import { ApiError } from './core/errors.js';
import { placementRoot } from './domain-registry.js';
import { SHORTENERS, subjectStats, THRESHOLDS } from './deliverability.js';
import { lint, PreviewLimitError, type Issue, type Client } from './email-preview/index.js';
import { blockedExtension } from './outbound-content.js';
import { readHtml, screenTextSignals } from './screen.js';
import { screenedHtml, screenedHtmlStats } from './screened-html.js';
import { estimatedMimeBytes, SEND_LIMITS } from './send-limits.js';
import { gradeOf, marketingHourFor } from './standing-model.js';
import { categories, splitMailbox, type CheckMail, type CheckReport } from './sendability-schema.js';
import type { CheckContext } from './sendability-context.js';
import { productName } from './brand.js';

type Finding = CheckReport['findings'][number];
type Category = Finding['category'];
const weights: Record<Category,number> = {authentication:20, content:33, headers:15, size:12, rendering:5, reputation:15};
// `fix` is one short sentence in everyday words: what to do, without header names, record types or standards (those
// are the title's and the detail's). `fixIn` is where it is done, when not the category's usual place (places).
type Add = (id:string, severity: Finding['severity'], points:number, title:string, detail:string, fix:string, evidence?:Finding['evidence'], fixIn?:Finding['fixIn']) => void;
const places: Record<Category,Finding['fixIn']> = {authentication:'domain', content:'message', headers:'message', size:'message', rendering:'message', reputation:'sending'};
// Litmus October 2026 open shares. Unmeasured siblings split their bucket equally (not a claim about OS mix).
const shares: Record<Client,number> = {'apple-mail-ios':75.84/2,'apple-mail-macos':75.84/2,'gmail-web':17.02/5,'gmail-ios':17.02/5,'gmail-android':17.02/5,
  'gmail-ios-non-google':17.02/5,'gmail-android-non-google':17.02/5,'outlook-classic-windows':3.49/3,'outlook-new-windows':3.49/3,'outlook-mac':3.49/3,
  'outlook-web':0.31,'yahoo-web':2.25/2,'aol-web':2.25/2,'samsung-email':0.01};
function rendering(issues: Issue[], add:Add) {
  // Charge a reader once, not once per CSS property. Give the author the highest-reach feature to fix first.
  const impact = new Map<Client,number>(); let top: Issue | undefined, largest=0;
  for (const issue of issues) {
    const factor = issue.severity==='error' ? 1 : 0.25;
    const reach = issue.clients.reduce((n,c)=>{ impact.set(c,Math.max(impact.get(c)??0,factor)); return n+shares[c]*factor; },0);
    if (reach>largest) {top=issue; largest=reach;}
  }
  if (top) add('client-support','warning',Math.round([...impact].reduce((n,[c,f])=>n+shares[c]*f,0)), 'Some clients need a fallback',
    `The compatibility lint flags ${top.feature} in ${top.clients.join(', ')}.`, 'Check how it looks in each mail app.', {issues:issues.length,feature:top.feature});
}
function authentication(d: CheckContext['domain'], host:string, add:Add) {
  if (!d || d.dmarc===undefined || d.dkim===undefined) add('auth-unknown','info',0,'Authentication evidence is incomplete','There is no complete, current cached observation for the exact From domain. Unknown checks are not scored.',`Check ${host} in Domains.`);
  if (!d) return;
  // Every problem with the domain's records is fixed in one place, its page, so they share one sentence.
  const records=`Finish setting up ${host}.`;
  if (d.fromSpf===false) add('spf-policy','info',3,'Review the From domain SPF policy','The most recent cached DNS check did not find a single restrictive SPF policy here. SPF authenticates the envelope domain; this is not a delivery verdict.',records);
  if (!d.verified || d.dkim===false) add('dkim','error',45,'Sender identity is not ready','The exact domain is not verified for sending or its aligned DKIM signing is not ready.',records);
  if (d.mailFrom===false) add('mail-from','warning',8,'No custom MAIL FROM','The default SES envelope does not align with the From domain. DKIM can still satisfy DMARC.',records);
  if (d.mailFrom && d.spf===false) add('spf-alignment','warning',16,'Custom MAIL FROM is not aligned','Cached SES and DMARC checks do not confirm an aligned SPF path.',records);
  if (d.dmarc==='invalid' || d.dmarc==='missing' || (d.dmarc && d.dkim===false && d.spf===false)) add('dmarc','error',40,'No usable DMARC path','Cached checks show a missing/invalid policy or no aligned identifier.',records);
  if (d.dmarc==='none') add('dmarc-monitor','info',3,'DMARC is monitoring only','p=none meets bulk-sender policy requirements but does not request enforcement.','Inventory authorized senders before moving to quarantine or reject.');
  if (d.rua===false && ['none','quarantine','reject'].includes(d.dmarc??'')) add('dmarc-reports','info',2,'No DMARC aggregate reports','No mailto reporting destination appears in the cached policy. This limits visibility, not authentication.','Add a rua mailbox you operate and review the reports.');
  if (d.ageDays!==undefined && d.ageDays<THRESHOLDS.newDomainDays) add('young-domain','warning',18,'Recently registered domain',`Cached registration data puts the domain at ${d.ageDays} days old.`, 'Send small, steady amounts while the domain is new.',{days:d.ageDays},'sending');
}
function reputation(mail:CheckMail, ctx:CheckContext, add:Add) {
  if (ctx.domain?.pool) add('shared-pool','info',0,'Hosted shared-IP delivery',`The ${ctx.domain.pool} pool shares SES IP reputation; placement is not solely a property of the message.`, 'Build your own domain history with consistent wanted mail.');
  const s=ctx.standing;
  if (!s) return;
  if (s.warmup) add('warmup','warning',22,'Sender is warming up','There is not yet enough sending history for a graded sender score.','Send a little more each day.');
  if (s.score!==null && s.score<80) add('sender-band','warning',30,'Sender score below B',`Current workspace sender score: ${s.score} (${gradeOf(s.score)}).`, 'Raise your sender score before sending more.',{senderScore:s.score});
  if (s.accepted && s.bounced>=2 && s.bounced/s.accepted>THRESHOLDS.hardBounce.serious) add('bounce-rate','error',35,'Recent hard-bounce rate exceeds 2%','At least two hard bounces in the last seven UTC dates.','Remove addresses that bounce.',{accepted:s.accepted,bounced:s.bounced});
  if (s.accepted && s.complained>=2 && s.complained/s.accepted>=THRESHOLDS.complaint.serious) add('complaint-rate','error',45,'Recent complaint rate is at least 0.1%','At least two complaints in the last seven UTC dates.','Send only to people who asked for it.',{accepted:s.accepted,complained:s.complained});
  if (s.daily!==null && mail.recipientCount && mail.recipientCount>(s.warmup ? marketingHourFor(s.daily) : s.daily)) add('burst','warning',30,'Pace this audience',`Planned volume is ${mail.recipientCount} recipients against a ${s.daily}/day allowance${s.warmup?' during warm-up':''}.`, 'Spread this send over several days.',{recipients:mail.recipientCount,daily:s.daily});
}
function compliance(mail:CheckMail, headers:Map<string,string>, copy:string, unsub:boolean, add:Add) {
  if (!(mail.fromName || splitMailbox(mail.from).name)?.trim()) add('display-name','warning',30,'Sender has no display name','Recipients see only an address in their inbox.','Add a sender name.');
  const mid=headers.get('message-id'), date=headers.get('date');
  if (mid!==undefined && !/^<[^<>@\s]+@[^<>@\s]+>$/.test(mid)) add('message-id','warning',15,'Malformed Message-ID','The supplied header is not a single bracketed message identifier.','Remove your Message-ID header.');
  if (date!==undefined && (!Number.isFinite(Date.parse(date)) || Date.parse(date)>Date.now()+86400_000)) add('date','warning',15,'Invalid or future Date','The supplied Date cannot be parsed or is over a day in the future.','Remove your Date header.');
  if (mail.stream!=='marketing') return;
  const list=headers.get('list-unsubscribe')??'';
  if (!mail.generatedUnsubscribe && !/<https:\/\/[^<>\s]+>/i.test(list)) add('unsubscribe-header','error',30,'No HTTPS List-Unsubscribe target',`Marketing mail needs an HTTPS List-Unsubscribe endpoint for one-click unsubscribe (RFC 8058). ${productName} adds it to marketing mail it sends.`,'Add one-click unsubscribe.');
  if (!mail.generatedUnsubscribe && headers.get('list-unsubscribe-post')?.trim().toLowerCase()!=='list-unsubscribe=one-click') add('unsubscribe-post','error',20,'One-click POST not declared',`The RFC 8058 opt-out header, List-Unsubscribe-Post: List-Unsubscribe=One-Click, is absent or invalid. ${productName} adds it to marketing mail it sends.`,'Add one-click unsubscribe.');
  if (!mail.generatedUnsubscribe && !unsub) add('unsubscribe-link','error',25,'No recognizable opt-out link','No HTTP unsubscribe, opt-out or preference link was recognized in the body.','Add an unsubscribe link.');
  // Marketing mail Nightmail sends gets a footer with the workspace's postal address, so its copy needs none; only a workspace without one is told.
  if (mail.generatedUnsubscribe) { if (mail.postalAddress===false) add('postal-address','warning',18,'No postal address','The workspace has no postal address for the footer of its marketing mail, which US law (CAN-SPAM) requires.','Add your postal address.',undefined,'workspace'); }
  else if (!/\b(?:p\.?\s*o\.?\s*box\s+\d+|\d{1,6}\s+(?:[\p{L}\d.'-]+\s+){0,5}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|way|boulevard|blvd|suite))\b/iu.test(copy)) add('postal-address','warning',18,'Check the mailing address','No recognizable postal address was found. The heuristic is English-oriented, not a legal determination.','Add your postal address to the footer.');
}
async function shortDomain(host:string) {
  const name=host.toLowerCase().replace(/\.$/,'');
  if (name.length>253 || name.startsWith('[') || /^[\d.]+$/.test(name)) return name;
  return (await placementRoot(name)).root ?? name;
}
async function content(mail:CheckMail, from:string, read:Awaited<ReturnType<typeof readHtml>>|undefined, overlap:number|undefined, tags:Set<string>, parseErrors:Set<string>, add:Add) {
  const {html,text='',subject}=mail, visible=read?.text??'', copy=`${visible}\n${text}`;
  if (html && !text.trim()) add('text-part','warning',32,'No plain-text alternative','The HTML has no corresponding plain-text part.','Add a plain-text version.');
  if (html && text.trim() && visible.trim() && (overlap??0)<0.25) add('part-mismatch','warning',52,'Text and HTML tell different stories',`Only ${Math.round(100*(overlap??0))}% word-set overlap between alternatives.`, 'Make the plain-text version say the same as the HTML.',{similarity:overlap??0});
  if (html) {
    const stats=screenedHtmlStats(html), alt=read?.images.filter(i=>!i.alt).length??0;
    if (!stats.imageRulePasses) add('image-ratio','warning',20,'Images outweigh readable copy',`${stats.words} visible words; the declared image area calls for ${stats.wordsRequiredByImages}.`,'Put the main message in text, not only in images.');
    if (alt) add('image-alt','info',6,'Images without descriptive alt text',`${alt} image(s) have empty or missing alternatives.`, 'Describe informative images; decorative images can keep empty alt text.',{images:alt});
    if (stats.hiddenWords || stats.recoloredWords || /[\u034f\u200b\u200c\u2060\ufeff](?:[\u034f\u200b\u200c\u2060\ufeff\s\u00a0]){3}/u.test(visible)) add('hidden-text','warning',16,'Hidden or hard-to-read text','The HTML contains hidden words, very low contrast, tiny type or repeated invisible padding.','Remove hidden or hard-to-read text.');
  }
  const hosts=new Set<string>(); let short=false, ip=false, redirect=!!mail.tracking, unsub=false;
  for (const value of [...(read?.links??[]),...Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi),m=>m[0])]) {
    if (!/^(?:https?:)?\/\//i.test(value)) continue;
    let u:URL; try { u=new URL(value.startsWith('//')?'https:'+value:value); } catch { continue; }
    hosts.add(u.hostname); short ||= SHORTENERS.includes(u.hostname); ip ||= /^(?:\d+\.){3}\d+$|^\[/.test(u.hostname);
    for (const v of u.searchParams.values()) if (/^https?:\/\//i.test(v)) {redirect=true; break;}
    unsub ||= /unsub|opt-?out|preferences/i.test(u.pathname+u.search);
  }
  if (hosts.size && !(await Promise.all([...hosts].map(async h=>(await shortDomain(h))===from))).some(Boolean)) add('off-brand-links','warning',25,'All link domains differ from the sender','None of the web links shares the sender’s registrable domain. Third-party links can be legitimate.','Link to your own website.');
  if (read?.mismatches.size) add('link-label','warning',18,'Link label names a different host','A displayed hostname differs from its actual destination.','Make each link’s text match where it goes.');
  if (short) add('short-url','warning',15,'Link shortener hides the destination','A link uses a known public shortening service.','Link to the page itself, not a shortened link.');
  if (ip) add('ip-link','warning',20,'Link points to an IP address','At least one web link has a numeric host instead of a recognizable domain.','Link to a website name, not a number.');
  if (redirect) add('redirect','info',5,'Link tracking or a nested destination','Click tracking is enabled or a query parameter contains another URL. No redirect was followed.','Use direct links where possible and avoid layered redirects.');
  if (/\b(?:no credit check|you are a winner|this is not spam)\b/i.test(subject+' '+copy)) add('promotional-phrase','info',4,'High-pressure or unsolicited-mail phrasing','Copy contains a credit, prize or unsolicited-mail claim. One phrase alone does not predict junk.','Describe the specific offer and why the recipient is getting it.');
  const s=subjectStats(subject,false);
  if ((s.length>=10 && (s.capitalsShare??0)>0.65) || s.exclamationRuns || (subject.match(/!/g)??[]).length>=3) add('shouting','warning',8,'Subject reads as shouting','The subject has a high share of capitals or repeated punctuation.','Write the subject in ordinary sentence case.');
  if (!subject.trim() || s.length>90 || s.emoji>2) add('subject','info',6,'Subject is empty, long or emoji-heavy',`${s.length} characters and ${s.emoji} pictographs.`, 'Lead with the reason for the message in a concise descriptive subject.');
  if (tags.has('form')) add('form','warning',12,'Embedded form','Form submission is blocked by many email clients.','Link to a form on your website instead.');
  if (tags.has('script')) add('script','error',30,'Embedded script','Email clients disable scripts; core content must not depend on them.','Remove the scripts.');
  if (parseErrors.size) add('html-invalid','warning',8,'HTML required parser recovery',`HTML parser diagnostic: ${[...parseErrors][0]}.`,'Fix the broken HTML.');
  if (mail.attachments?.length) {
    const risky=mail.attachments.some(a=>blockedExtension(a.filename) || /^(?:text\/html|application\/(?:x-msdownload|javascript|x-sh|zip))\b/i.test(a.contentType));
    add('attachments',risky?'error':'info',risky?30:0,risky?'Potentially blocked attachment':'Message includes attachments',`${mail.attachments.length} file(s) checked by declared type and extension only.`,risky?'Remove attachments that mail servers block.':'Keep expected files small and clearly identify them in the message.');
  }
  return {copy,unsub};
}
export async function checkMail(mail:CheckMail, ctx:CheckContext={}): Promise<CheckReport> {
  const findings:Finding[]=[], deductions = new Map<Category,number>();
  const category=(id:Category):Add=>(ruleId,severity,points,title,detail,fix,evidence,fixIn)=>{
    deductions.set(id,(deductions.get(id)??0)+points); findings.push({ruleId,category:id,severity,title,detail,fix,fixIn:fixIn??places[id],...(evidence?{evidence}:{})});
  };
  const auth=category('authentication'), size=category('size'), tags=new Set<string>(), parseErrors=new Set<string>();
  const sender=splitMailbox(mail.from), host=sender.address.split('@').at(-1)!.toLowerCase(), from=await shortDomain(host), headers=new Map(Object.entries(mail.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
  authentication(ctx.domain,host,auth);
  const reply=headers.get('reply-to');
  if (reply && (await shortDomain(splitMailbox(reply).address.split('@').at(-1)!))!==from) auth('reply-domain','warning',12,'Reply-To differs from From','Replies go to a different registrable domain.','Use a reply address on your own domain.',undefined,'message');
  try {
    const html=mail.html??'';
    if (html) rendering(lint(html,e=>{if(e.code!=='missing-doctype') parseErrors.add(e.code);}),category('rendering'));
    const read=html ? await readHtml(html,tag=>tags.add(tag)) : undefined;
    const signals=screenTextSignals(read?.text??'',mail.text);
    const {copy,unsub}=await content(mail,from,read,signals.textHtmlOverlap,tags,parseErrors,category('content'));
    compliance(mail,headers,copy,unsub,category('headers'));
    const bytes=Buffer.byteLength(html);
    if (bytes>=102400) size('gmail-clip','warning',45,'Gmail may clip the message',`${bytes} bytes of HTML before delivery-time rewriting.`, 'Shorten the email so Gmail shows all of it.',{htmlBytes:bytes});
    // Probation dispatch screens the rewritten copy. Image-only mail cannot reach that step; measure the submitted copy instead.
    let measured=signals.content, basis='submitted';
    if (html && ctx.domain?.probation) try {
      const rewritten=screenedHtml(html,mail.previewText); measured=screenTextSignals((await readHtml(rewritten)).text,mail.text).content; basis='probation copy';
    } catch (e) { if (!(e instanceof ApiError && e.code==='CONTENT_IMAGE_ONLY')) throw e; }
    const limit=ctx.screenLimitBytes??24*1024, screenedBytes=Buffer.byteLength(measured), left=limit-screenedBytes, near=left<limit*0.1;
    size('screen-bytes',left<0?'error':near?'warning':'info',left<0?100:near?20:0,'Hosted screened-text budget',`${screenedBytes} of ${limit} UTF-8 bytes (${Math.abs(left)} bytes ${left<0?'over':'remaining'}; ${basis}).`,left<0?'Shorten the email.':'Keep room for personalization and the final footer.',{screenedBytes,limitBytes:limit,remainingBytes:left});
    const mime=estimatedMimeBytes(mail,mail.attachments??[]), over=mime>SEND_LIMITS.encodedBytes;
    size('mime-size',over?'error':'info',over?100:0,'Estimated total MIME size',`${productName}’s conservative estimate is ${mime} bytes including transfer encoding and headers; not an observed wire size.`, over?'Make the attachments smaller.':`Reduce attachments or link to large documents if near the ${SEND_LIMITS.encodedBytes / 1_000_000} MB limit.`,{estimatedBytes:mime,limitBytes:SEND_LIMITS.encodedBytes});
  } catch (e) { if (e instanceof PreviewLimitError || (e instanceof ApiError && e.code==='CONTENT_TOO_LARGE_TO_SCREEN')) throw new ApiError(413,'EMAIL_CHECK_LIMIT_EXCEEDED','Simplify the HTML to fit the offline checker’s byte, tree and style budgets.'); throw e; }
  reputation(mail,ctx,category('reputation'));
  const parts=categories.map(id=>({id,score:Math.max(0,100-(deductions.get(id)??0)),weight:(id==='reputation' && !ctx.standing) || (id==='authentication' && !ctx.domain && !deductions.get(id)) ? 0 : weights[id]}));
  const score=Math.round(parts.reduce((n,c)=>n+c.weight*c.score,0)/parts.reduce((n,c)=>n+c.weight,0));
  return {score,grade:gradeOf(score),domainId:ctx.domain?.id??null,categories:parts,findings};
}
