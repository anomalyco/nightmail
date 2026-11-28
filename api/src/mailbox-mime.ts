import type { S3Client } from '@aws-sdk/client-s3';
import type { MailObjects } from './mail-objects.js';
import {mailKindTag} from './resource-tags.js';
import { ApiError, lazyModule } from './core.js';

const loadS3Commands = lazyModule(() => import('@aws-sdk/client-s3'));

const MiB=1024*1024, PREFIX=2*MiB, FIRST_PART=5.25*MiB;
export const PARSE_LIMIT=6*MiB;

// One top-level header field, with its folds: the first 12 characters of its name in lower case, and its text (latin1) on demand.
type HeaderField = { name: string; size: number; firstLine: () => string; text: () => string };
// Drops each top-level header field that `drop` picks, working on byte offsets: never reserializes MIME, DKIM headers,
// attachments or the body. Returns the input itself when nothing is dropped. `inPlace` writes into the input instead of
// a copy: the kept fields move up against the body, and the result is a view of the input's last bytes.
function dropHeaderFields(bytes:Uint8Array,drop:(field:HeaderField)=>boolean,inPlace=false) {
  const raw=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let pos=0,kept=0;
  let copy:Buffer|undefined,written=0;
  const keptFields:[number,number][]=[];
  while(pos<raw.length) {
    const start=pos;
    let end=raw.indexOf(10,pos); if (end===pos || (end===pos+1 && raw[pos]===13)) break;
    const firstEnd=end<0?raw.length:end;
    pos=end<0?raw.length:end+1;
    while(raw[pos]===32 || raw[pos]===9) { end=raw.indexOf(10,pos); pos=end<0?raw.length:end+1; }
    const fieldEnd=pos;
    const field={ name: raw.toString('latin1',start,Math.min(firstEnd,start+12)).toLowerCase(), size: fieldEnd-start,
      firstLine: () => raw.toString('latin1',start,firstEnd), text: () => raw.toString('latin1',start,fieldEnd) };
    if (drop(field)) { if (inPlace) { keptFields.push([kept,start]); copy=raw; } else { copy??=Buffer.allocUnsafe(raw.length);written+=raw.copy(copy,written,kept,start); } kept=fieldEnd; }
  }
  if (!copy) return bytes;
  if (inPlace) {
    // Last field first: each moves right, past every field before it.
    let to=kept;
    for (const [start,end] of keptFields.reverse()) { to-=end-start; raw.copyWithin(to,start,end); }
    return raw.subarray(to);
  }
  return copy.subarray(0,written+raw.copy(copy,written,kept));
}
const blindField=(f:HeaderField)=>(f.name.startsWith('bcc') || f.name.startsWith('resent-bcc')) && /^(?:bcc|resent-bcc)[ \t]*:/i.test(f.firstLine());
/** Removes top-level Bcc and Resent-Bcc fields, so blind recipients are never stored: received mail (workspaceMime) and an SMTP submission's Sent copy (protocol-content.ts) both strip them here. A submission is stripped in place (its buffer is the submission's own), so a large one isn't held twice. */
export const stripBlindRecipients=(bytes:Uint8Array,inPlace=false)=>dropHeaderFields(bytes,blindField,inPlace);

type ParsedAddress = { address?: string; name?: string };
/**
 * Who an SMTP submission is from and to, for both submissions: an app password's (protocol-content.ts) and a send-only
 * key's (protocol-relay.ts). `senders` is every address the credential must own: the one From, the envelope sender and
 * any Sender; null when the message has no single From or more than one Sender. The envelope decides who gets it, the
 * header how: To, then Cc, and anyone else is Bcc.
 */
export function submissionParties(m: { from?: ParsedAddress; sender?: ParsedAddress; to?: ParsedAddress[]; cc?: ParsedAddress[]; headers: { key: string }[] }, envelope: { from: string; to: string[] }) {
  const from = m.from?.address?.toLowerCase(), count = (key: string) => m.headers.filter(h => h.key === key).length;
  const senders = [from, envelope.from.toLowerCase(), ...count('sender') ? [m.sender?.address?.toLowerCase()] : []];
  const listed = (list?: ParsedAddress[]) => new Set(list?.map(a => a.address?.toLowerCase()));
  const headerTo = listed(m.to), headerCc = listed(m.cc);
  const to = envelope.to.filter(a => headerTo.has(a.toLowerCase())), cc = envelope.to.filter(a => !to.includes(a) && headerCc.has(a.toLowerCase()));
  return { from, senders: from && count('from') === 1 && count('sender') <= 1 && senders.every(a => a?.includes('@')) ? [...new Set(senders as string[])] : null,
    to, cc, bcc: envelope.to.filter(a => !to.includes(a) && !cc.includes(a)) };
}

// AWS's receiving-email-notifications-examples shows the SES-added first Received field can end
// in "for recipient@example.com;". Remove that field (including folds) when not ours. The S3
// action preserves raw MIME, so also drop top-level Bcc/Resent-Bcc if physically present.
function workspaceMime(bytes:Uint8Array,region:string,recipients:string[]) {
  let seenReceived=false;
  return dropHeaderFields(bytes,f=>{
    if (seenReceived || !f.name.startsWith('received:')) return blindField(f);
    seenReceived=true;
    const field=f.size<=64*1024 ? f.text().replace(/\r?\n[ \t]+/g,' ') : '';
    const match=/\bby\s+inbound-smtp\.([\w-]+)\.amazonaws\.com\b[^;]*?\sfor\s+([^;]+);/i.exec(field);
    return !field || (match?.[1]===region && !recipients.includes(match[2]!.trim().replace(/^<|>$/g,'').toLowerCase()));
  });
}

export type RawObjectHead = { size: number; etag: string };

/** Inspect staging object size and ETag before reserving byte budget or reading bytes. */
export async function headWorkspaceRaw(client: S3Client, bucket: string, source: string, etag?: string): Promise<RawObjectHead> {
  const { HeadObjectCommand } = await loadS3Commands();
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: source }));
  if (head.ContentLength === undefined || !head.ETag) throw new Error('Raw message metadata unavailable');
  if (etag && head.ETag !== etag) throw new ApiError(409, 'MAILBOX_STAGING_CHANGED', 'The recovered message no longer matches the inspected object.');
  if (head.ContentLength > 40 * MiB) throw new ApiError(413, 'RAW_MESSAGE_TOO_LARGE', 'The raw message exceeds 40 MiB.');
  return { size: head.ContentLength, etag: head.ETag };
}

/** Read, scrub blind headers, and store an already-inspected and byte-reserved staging object. */
export async function transferWorkspaceRaw(client: S3Client, region: string, bucket: string, source: string, key: string, recipients: string[], kind: 'raw' | 'legacy-raw' | 'kept', head: RawObjectHead, objects?: MailObjects) {
  const { GetObjectCommand, PutObjectCommand, CopyObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = await loadS3Commands();
  const location = { Bucket: bucket, Key: source };
  const size = head.size;
  const pinnedEtag = head.etag;
  // Pin the checked object and do not let fetch transparently expand BYO Content-Encoding metadata.
  const get=async(start:number,end:number,range:boolean)=>{
    const object=await client.send(new GetObjectCommand({...location,IfMatch:pinnedEtag,ResponseContentEncoding:'identity',Range:range?`bytes=${start}-${end-1}`:undefined}));
    if(range && object.ContentRange!==`bytes ${start}-${end-1}/${size}`) throw new Error('Expected a bounded S3 range response');
    const bytes=await object.Body!.transformToByteArray();if(bytes.length!==end-start)throw new Error('Incomplete S3 response');return bytes;
  };
  const large=size>PARSE_LIMIT;
  let original=await get(0,large?PREFIX:size,large);
  const hasEnd=(p:Uint8Array)=>{const b=Buffer.from(p.buffer,p.byteOffset,p.length);return b[0]===10 || b[0]===13 && b[1]===10 || b.includes('\n\n') || b.includes('\n\r\n');};
  const headerLimit=()=>new ApiError(422,'MAILBOX_RAW_HEADERS_TOO_LARGE','The raw headers exceed the bounded workspace scrub budget.');
  if(large && !hasEnd(original)){original=await get(0,FIRST_PART,true);if(!hasEnd(original))throw headerLimit();}
  const bytes=workspaceMime(original,region,recipients),removed=original.length-bytes.length;
  if(objects){
    if(!large) await objects.put(key,bytes,'message/rfc822');
    else {
      const start=original.length;
      const rest=await client.send(new GetObjectCommand({...location,IfMatch:pinnedEtag,Range:`bytes=${start}-${size-1}`,ResponseContentEncoding:'identity'}));
      if(!rest.Body || rest.ContentRange!==`bytes ${start}-${size-1}/${size}`)throw new Error('Incomplete S3 range');
      const reader=rest.Body.transformToWebStream().getReader();
      const stream=new ReadableStream<Uint8Array>({start:c=>c.enqueue(bytes),async pull(c){const part=await reader.read();if(part.done)c.close();else c.enqueue(part.value);},cancel:r=>reader.cancel(r)});
      await objects.put(key,{stream,length:size-removed},'message/rfc822');
    }
    return {bytes,sizeBytes:size-removed,large};
  }
  const destination={Bucket:bucket,Key:key,Tagging:`${mailKindTag(bucket)}=${kind}`};
  const copy={CopySource:`${bucket}/${source}`,CopySourceIfMatch:pinnedEtag};
  if(!removed) await client.send(new CopyObjectCommand({...destination,...copy,TaggingDirective:'REPLACE'}));
  else if(!large) await client.send(new PutObjectCommand({...destination,Body:bytes,ContentType:'message/rfc822'}));
  else {
    const end=Math.max(FIRST_PART,5*MiB+removed);if(end>=size)throw headerLimit();
    const first=end===original.length?bytes:Buffer.concat([bytes,await get(original.length,end,true)]);
    const {UploadId}=await client.send(new CreateMultipartUploadCommand({...destination,ContentType:'message/rfc822'}));
    if(!UploadId) throw new Error('Missing S3 multipart upload id');
    const upload={Bucket:bucket,Key:key,UploadId};
    try {
      const a=await client.send(new UploadPartCommand({...upload,PartNumber:1,Body:first}));
      const b=await client.send(new UploadPartCopyCommand({...upload,...copy,PartNumber:2,CopySourceRange:`bytes=${end}-${size-1}`}));
      if(!a.ETag || !b.CopyPartResult?.ETag)throw new Error('Incomplete S3 multipart upload');
      await client.send(new CompleteMultipartUploadCommand({...upload,MultipartUpload:{Parts:[{PartNumber:1,ETag:a.ETag},{PartNumber:2,ETag:b.CopyPartResult.ETag}]}}));
    } catch(error){try{await client.send(new AbortMultipartUploadCommand(upload));}catch{/* bucket lifecycle also aborts abandoned uploads */}throw error;}
  }
  return {bytes,sizeBytes:size-removed,large};
}

/** Inspect the exact bytes being copied. CopySourceIfMatch prevents substituting another object after inspection. */
export async function copyWorkspaceRaw(client:S3Client,region:string,bucket:string,source:string,key:string,recipients:string[],kind:'raw'|'legacy-raw'|'kept',etag?:string,objects?:MailObjects) {
  const head = await headWorkspaceRaw(client, bucket, source, etag);
  return transferWorkspaceRaw(client, region, bucket, source, key, recipients, kind, head, objects);
}
