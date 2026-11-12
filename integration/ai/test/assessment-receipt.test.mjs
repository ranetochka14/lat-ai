import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createBridge} from '../bridge.mjs';
import {assessmentIdentity} from '../assessment-receipt.mjs';
import {rubrics} from '../core/src/assessment.mjs';
import {createWorkerServer} from '../worker-http.mjs';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const resolved={actor_id:11,attempt_id:27,digest:'a'.repeat(64),task_key:'L1.types.1'};
const body=()=>({request_id:randomUUID(),answer:'Оба значения строки; плюс склеивает; вывод 32.'});
const modelResult={path:'model',result:{checks:[true,true,true],evidence:['Оба значения строки;','плюс склеивает;','вывод 32.'],rubric_version:'local-assessment-v1'}};
test('lookup is read-only before dispatch, during work, and after the terminal receipt',async()=>{
 let calls=0,release;const bridge=createBridge({dbPath:':memory:',tutor:{respond:()=>{calls++;return new Promise(r=>release=r);}}});
 try{
  const b=body();assert.equal(bridge.assessmentReceipt(b,resolved).body.state,'not_found');assert.equal(calls,0);
  const flight=bridge.assess(b,resolved);
  for(let i=0;i<3;i++)assert.equal(bridge.assessmentReceipt(b,resolved).body.state,'pending_unknown');
  assert.equal(calls,1);release(modelResult);const terminal=await flight;
  for(let i=0;i<3;i++){const r=bridge.assessmentReceipt(b,resolved);assert.equal(r.body.state,'completed');assert.deepEqual(r.body.receipt,terminal);}
  assert.equal(calls,1);
 }finally{bridge.close();}
});
test('actor isolation and every identity component guard completed receipts',async()=>{
 const bridge=createBridge({dbPath:':memory:',tutor:{respond:async()=>modelResult}});
 try{
  const b=body();await bridge.assess(b,resolved);
  assert.equal(bridge.assessmentReceipt(b,{...resolved,actor_id:12}).body.state,'not_found');
  for(const r of [{...resolved,attempt_id:28},{...resolved,digest:'b'.repeat(64)},{...resolved,task_key:'L1.condition.1'}])assert.equal(bridge.assessmentReceipt(b,r).status,409);
  assert.equal(bridge.assessmentReceipt({...b,answer:'Другой ответ'},resolved).status,409);
  assert.equal(bridge.assessmentReceipt({...b,actor_id:11},resolved).status,400);
  const revision=rubrics.assessment_revision;try{rubrics.assessment_revision+='-changed';assert.equal(bridge.assessmentReceipt(b,resolved).status,409);}finally{rubrics.assessment_revision=revision;}
 }finally{bridge.close();}
});
test('pending journal survives worker reopening; lookup never creates a row or retries',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lat-receipt-'));const file=join(dir,'journal.sqlite3');const b=body();
 const initial=createBridge({dbPath:file,tutor:{respond(){throw Error('not called');}}});initial.close();
 const db=new DatabaseSync(file);db.prepare('INSERT INTO assessments(actor,rid,digest) VALUES(?,?,?)').run(resolved.actor_id,b.request_id,assessmentIdentity(b,resolved).digest);db.close();
 let calls=0;const reopened=createBridge({dbPath:file,tutor:{respond(){calls++;throw Error('never retry');}}});
 try{assert.equal(reopened.assessmentReceipt(b,resolved).body.state,'pending_unknown');assert.equal(reopened.assessmentReceipt(body(),resolved).body.state,'not_found');assert.equal(calls,0);}finally{reopened.close();}
 const check=new DatabaseSync(file);assert.equal(check.prepare('SELECT count(*) AS n FROM assessments').get().n,1);check.close();rmSync(dir,{recursive:true,force:true});
});
test('terminal unavailable remains completed but is not promoted into a grade',async()=>{
 const bridge=createBridge({dbPath:':memory:',tutor:{respond:async()=>({path:'error',reason:'invalid_output'})}});
 try{const b=body(),original=await bridge.assess(b,resolved),r=bridge.assessmentReceipt(b,resolved);assert.equal(r.body.state,'completed');assert.deepEqual(r.body.receipt,original);assert.equal(r.body.receipt.status,503);assert.equal(r.body.receipt.body.checks,undefined);}finally{bridge.close();}
});
test('receipt HTTP route has the same private IPC boundary and never calls inference',async t=>{
 let calls=0,lookups=0;const secret='r'.repeat(64);
 const server=createWorkerServer({secret,bridge:{assess(){calls++;throw Error('no dispatch');},assessmentReceipt(){lookups++;return {status:200,body:{state:'not_found'}};}},health:()=>({})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/assess/receipt';const payload=JSON.stringify({body:body(),resolved});
 const request=headers=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:payload});
 assert.equal((await request({})).status,401);assert.equal((await request({'X-LAT-IPC':secret,Origin:'https://foreign.test'})).status,403);
 assert.equal((await request({'X-LAT-IPC':secret})).status,200);assert.equal(lookups,1);assert.equal(calls,0);
});
test('actual child-process termination after stub dispatch leaves durable pending without retry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lat-crash-receipt-')),file=join(dir,'journal.sqlite3'),requestId=randomUUID();
 const child=fork(fileURLToPath(new URL('./receipt-crash.fixture.mjs',import.meta.url)),[file,requestId],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child dispatch timeout')),10000);child.once('error',reject);child.once('message',m=>{clearTimeout(timer);m.event==='dispatched_to_stub'?resolve():reject(Error('unexpected marker'));});});
  child.kill();await exited;
  let calls=0;const bridge=createBridge({dbPath:file,tutor:{respond(){calls++;throw Error('no retry');}}});
  try{const result=bridge.assessmentReceipt({request_id:requestId,answer:'Строки склеиваются. Вывод32.'},resolved);assert.equal(result.body.state,'pending_unknown');assert.equal(calls,0);}finally{bridge.close();}
 }finally{if(child.exitCode===null){child.kill();await exited;}assert.ok(dir.startsWith(join(tmpdir(),'lat-crash-receipt-')));rmSync(dir,{recursive:true,force:true});}
});
test('closed or corrupted journal is unavailable without exposing a fabricated receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lat-corrupt-receipt-')),file=join(dir,'journal.sqlite3'),b=body();
 let bridge=createBridge({dbPath:file,tutor:{respond:async()=>modelResult}});await bridge.assess(b,resolved);bridge.close();
 assert.equal(bridge.assessmentReceipt(b,resolved).status,503);
 const db=new DatabaseSync(file);db.prepare('UPDATE assessments SET result=?').run('{bad json');db.close();
 bridge=createBridge({dbPath:file,tutor:{respond(){throw Error('no generation');}}});
 try{const r=bridge.assessmentReceipt(b,resolved);assert.equal(r.status,503);assert.equal(r.body.receipt,undefined);}finally{bridge.close();assert.ok(dir.startsWith(join(tmpdir(),'lat-corrupt-receipt-')));rmSync(dir,{recursive:true,force:true});}
});
