import { ModuleLoadError } from './core.js';
import { placementRoot } from './domain-registry.js';
import { dns, fqdn } from './public-dns.js';
import type { IdentityFacts } from './states.js';
import { SEND_LIMITS } from './send-limits.js';

type Policy = 'none'|'quarantine'|'reject';
type Mode = 'r'|'s';
type PolicyRecord = { status:Policy|'invalid'|'missing'; record:string|null; source:string|null; adkim:Mode; aspf:Mode };
export type DmarcObservation = PolicyRecord & { checkedAt:number; recommend:boolean; alignedMailFrom:string|null };
const isPolicy=(p?:string):p is Policy=>p==='none' || p==='quarantine' || p==='reject';

/** A TXT string as one value: its quotes removed and its parts joined. */
export const unquoteTxt=(s:string)=>s.replace(/^"|"$/g,'').replace(/"\s*"/g,'');
/**
 * The DMARC record among a _dmarc name's TXT strings, read by RFC 7489: null when there is none; more than one is none
 * that counts (§6.6.3), so it is invalid. Its tags are what it says, first of each name; valid when it keeps the grammar
 * (v=DMARC1 first, then p; no tag twice) and every policy, alignment mode and pct is one the RFC allows. Every reader
 * of DMARC (the stored observation, the support health check, domain findings) decides validity here.
 */
export function readDmarc(values:string[]):{record:string;tags:Map<string,string>;valid:boolean}|null {
  const records=values.map(unquoteTxt).filter(s=>/(?:^|;)\s*(?:v\s*=\s*DMARC|p\s*=)/i.test(s));
  if(!records.length) return null;
  const record=records.join('\n'), tags=new Map<string,string>();
  if(records.length!==1) return {record,tags,valid:false};
  let valid=true;
  for(const field of record.trim().replace(/;$/,'').split(';')) {
    const m=/^\s*([a-z][a-z0-9_-]*)\s*=\s*([^;\x00-\x1f]+?)\s*$/i.exec(field), name=m?.[1]!.toLowerCase();
    if(!m || tags.has(name!)) { valid=false; continue; }
    tags.set(name!,m[2]!);
  }
  const [v,p]=tags.keys(), policy=tags.get('p')?.toLowerCase(), sub=tags.get('sp')?.toLowerCase();
  const adkim=tags.get('adkim')?.toLowerCase() ?? 'r', aspf=tags.get('aspf')?.toLowerCase() ?? 'r';
  valid&&=v==='v' && tags.get(v)==='DMARC1' && p==='p' && isPolicy(policy) && (sub===undefined || isPolicy(sub)) &&
    ['r','s'].includes(adkim) && ['r','s'].includes(aspf) && (!tags.has('pct') || /^(?:\d{1,2}|100)$/.test(tags.get('pct')!));
  return {record,tags,valid};
}

function policyAt(values:string[],source:string,inherited:boolean):PolicyRecord|null {
  const read=readDmarc(values);
  if(!read) return null;
  if(!read.valid) return {status:'invalid',record:read.record,source,adkim:'r',aspf:'r'};
  const {record,tags}=read, policy=tags.get('p')!.toLowerCase() as Policy, sub=tags.get('sp')?.toLowerCase() as Policy|undefined;
  return {status:inherited && sub ? sub : policy,record,source,adkim:(tags.get('adkim')?.toLowerCase() ?? 'r') as Mode,aspf:(tags.get('aspf')?.toLowerCase() ?? 'r') as Mode};
}

// The verifier persists this alongside its SES and MX facts. No resolver calls in MX reads or admissions.
export async function observeDmarc(name:string,mailFrom?:string):Promise<DmarcObservation|null> {
  const signal=AbortSignal.timeout(5000);
  const {root}=await placementRoot(name), query=(host:string)=>dns('_dmarc.'+host,'TXT',signal);
  const exact=await query(name);
  let policy=policyAt(exact.values,name,false), empty=!exact.values.length && exact.aliases.length===1;
  if(!policy && root && root!==name) {
    const org=await query(root);
    policy=policyAt(org.values,root,true);
    empty &&= !org.values.length && org.aliases.length===1;
  }
  // Our alignment boundary is the shared PSL. Before recommending a new TXT,
  // also rule out an inherited policy visible to RFC 9989 tree-walk receivers.
  // An authoritative disagreement returns null; transport failures reject.
  if(!policy && empty) {
    const labels=name.split('.').slice(1).slice(-7);
    const other=labels.map((_,i)=>labels.slice(i).join('.')).filter(host=>host!==root);
    const answers=await Promise.all(other.map(query));
    if(answers.some((rr,i)=>policyAt(rr.values,other[i]!,true))) return null;
  }
  policy??={status:'missing',record:null,source:null,adkim:'r',aspf:'r'};
  const bounce=mailFrom && fqdn(mailFrom);
  const aligns=bounce && (name===bounce || (policy.aspf==='r' && root && (await placementRoot(bounce)).root===root));
  return {...policy,checkedAt:Date.now(),recommend:policy.status==='missing' && empty,alignedMailFrom:aligns?bounce:null};
}

export function dmarcView(obs:DmarcObservation|null|undefined,ses:IdentityFacts['ses']) {
  if(!obs || obs.checkedAt<Date.now()-SEND_LIMITS.dmarcMaxAgeHours*3600_000) return null;
  const {status,record,source,adkim,aspf}=obs, mail=ses.MailFromAttributes;
  return {status,record,source,adkim,aspf,alignment:{
    // The checked From domain IS this SES identity (also an exact match in strict mode).
    dkim:ses.DkimAttributes?.SigningEnabled===true && ses.DkimAttributes.Status==='SUCCESS',
    spf:!!obs.alignedMailFrom && mail?.MailFromDomainStatus==='SUCCESS' && fqdn(mail.MailFromDomain ?? '')===obs.alignedMailFrom,
  }};
}

// A transport failure is no observation (undefined), so the caller keeps its last one; null is an authoritative answer.
export const tryObserveDmarc=(name:string,mailFrom?:string)=>observeDmarc(name,mailFrom).catch(e=>{if(e instanceof ModuleLoadError)throw e;return undefined;});

// Self-hosted detail already refreshes SES inline; cache public DNS only and never cache an in-flight request or a failure.
const local=new Map<string,{value:DmarcObservation|null;until:number}>();
export async function localDmarc(name:string,mailFrom?:string,refresh=false) {
  const key=name+':'+(mailFrom ?? ''), hit=local.get(key);
  if(!refresh && hit && hit.until>Date.now()) return hit.value;
  const value=await tryObserveDmarc(name,mailFrom);
  if(value===undefined) return hit?.value ?? null;
  if(local.size>=256) local.delete(local.keys().next().value!);
  local.set(key,{value,until:Date.now()+(value?300_000:30_000)}); return value;
}
