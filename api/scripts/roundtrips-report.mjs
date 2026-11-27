// node --import tsx scripts/roundtrips-report.mjs inventory
// node scripts/roundtrips-report.mjs csv trace1.ndjson ...   (one row per actual request)
// node scripts/roundtrips-report.mjs check baseline.ndjson candidate.ndjson   (named scenarios only)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const verbs = new Set(['GET','POST','DELETE','PATCH','PUT','HEAD']);
const template = path => path.replace(/:([A-Za-z]\w*)/g, '{$1}');
const quote = v => '"'+String(v ?? '').replaceAll('"','""')+'"';
const load = path => readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));

export function counts(r) {
  const txs=[], open=new Map(), labels=[];
  let statements=0, savepoints=0;
  for(const f of r.flights) {
    if(!f.done) throw Error('Unfinished pg exchange: '+r.method+' '+r.route+' '+r.requestId);
    for(const [i,cmd] of f.commands.entries()) {
      const stmt = f.sql[i] ?? cmd;
      labels.push(stmt); statements++;
      if(cmd==='BEGIN' || cmd==='START') { const tx={n:0}; txs.push(tx); open.set(f.wire,tx); }
      if(open.has(f.wire)) open.get(f.wire).n++;
      if(cmd==='SAVEPOINT') savepoints++;
      if(cmd==='COMMIT' || cmd==='ROLLBACK' && !stmt.startsWith('rollback-to ')) open.delete(f.wire);
    }
  }
  return { statements, exchanges:r.flights.length, sequential:r.depth, transactions:txs.length, sizes:txs.map(t=>t.n),
    savepoints, alreadyInTransaction:['T','E'].includes(r.flights[0]?.txBefore), labels };
}

export function checkBudgets(baseline, candidate) {
  const key=r=>[r.method,template(r.route),r.auth,r.credential,r.hosted,r.sample].join(' ');
  const cases=rows=>{
    const out=new Map();
    for(const r of rows) if(r.sample && r.source==='scenario' && !r.nested && r.status>=200 && (r.status<300 || r.status===303)) {
      const k=key(r); if(out.has(k)) throw Error('Scenario is not unique: '+k); out.set(k,counts(r));
    }
    return out;
  };
  const a=cases(baseline), b=cases(candidate), errors=[];
  if(!a.size) throw Error('No measured scenario budgets');
  for(const [k,was] of a) {
    const now=b.get(k);
    if(!now){errors.push(k+': missing successful authenticated sample');continue;}
    if(now.sequential<=was.sequential && now.exchanges<=was.exchanges) continue;
    const bag=new Map();for(const label of was.labels) bag.set(label,(bag.get(label)??0)+1);
    const extra=now.labels.filter(l=>{const n=bag.get(l)??0; if(n>0){bag.set(l,n-1);return false;} return true;});
    errors.push(k+': sequential '+was.sequential+' → '+now.sequential+', exchanges '+was.exchanges+' → '+now.exchanges+'; '+(extra.length?'additional SQL: '+extra.join(' | '):'same SQL labels; dispatch became more serial'));
  }
  for(const k of b.keys()) if(!a.has(k)) errors.push(k+': uncovered scenario; review and record its budget');
  if(errors.length) throw Error(errors.join('\n'));
  return a.size;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const [action,...files]=process.argv.slice(2);
 if(action==='inventory') {
   const {createOpenApiApp}=await import('../src/app.js'), app=await createOpenApiApp();
   const {createRegisteredDocument}=await import('../src/openapi-docs.js');
   const open=createRegisteredDocument(app), rows=new Map();
   for(const [route,pathItem] of Object.entries(open.paths)) for(const [v,o] of Object.entries(pathItem)) {
     const method=v.toUpperCase(); if(!verbs.has(method) || !o.operationId) continue;
     rows.set(method+' '+route,{method,route,operation:o.operationId,group:o.tags[0],permission:o['x-nightmail-permission'],surface:'openapi'});
   }
   for(const r of app.routes) {
     if(!verbs.has(r.method) || r.path.endsWith('*')) continue;
     const route=template(r.path), k=r.method+' '+route;
     if(!rows.has(k)) rows.set(k,{method:r.method,route,surface:/^\/v1\/(?:support(?:[-/]|$)|operator\/(?:support|inbox)(?:[-/]|$)|operator\/(?:users|workspaces)\/\{id\}\/audit$|contact-support$|activity$|public\/support-keys$)/.test(route)?'support':'ancillary'});
   }
   rows.set('POST /mcp',{method:'POST',route:'/mcp',surface:'mcp'});
   console.log(JSON.stringify([...rows.values()],null,2));
 } else if(action==='csv' && files.length) {
   const columns=['method','route','sample','auth','credential','hosted','source','nested','status','statements','exchanges','sequential','transactions','sizes','savepoints','alreadyInTransaction','labels','requestId'];
   console.log(columns.join(','));
   for(const file of files) for(const r of load(file)) {
     const c=counts(r), row={...r,...c,route:template(r.route),sizes:c.sizes.join('|'),labels:c.labels.join(' | ')};
     console.log(columns.map(k=>quote(row[k])).join(','));
   }
 } else if(action==='check' && files.length===2) console.log('Within budget: '+checkBudgets(load(files[0]),load(files[1]))+' scenarios');
 else throw Error('Use inventory, csv TRACE... or check BASELINE CANDIDATE');
}
