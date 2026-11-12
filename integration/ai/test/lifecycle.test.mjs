import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalModel} from '../core/src/local-model.mjs';
import {createWorkerServer} from '../worker-http.mjs';
const impl=await import('../lifecycle.mjs').catch(()=>({}));
const req={role:'explain',lesson:'L1',topic:'types',message:'Почему это строка?'};
const answer={choices:[{message:{content:JSON.stringify({text:'Кавычки обозначают строковое значение.',source_ids:['L1']})},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:12,completion_tokens_details:{reasoning_tokens:0}}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t,{failUnload=false,blockedLoad=false,failReadiness=false}={}){
 assert.equal(typeof impl.createLifecycle,'function','operator recovery lifecycle must exist');
 const dir=mkdtempSync(join(tmpdir(),'lat-ai-l01-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const lock=join(dir,'lock'),loaded=new Set(['foreign-model']),unloads=[],posts=[];
 const dispatched=deferred(),gate=deferred();let hold=false;
 const loadOwned=options=>LocalModel.loadOwned({...options,lockPath:lock,recoveryDelayMs:0,
  loadImpl:async({id})=>{loaded.add(id);if(blockedLoad)await gate.promise;},
  fetchImpl:async(url,opts={})=>{
   if(url.endsWith('/models')){if(failReadiness){failReadiness=false;return new Response('{}',{status:503});}return new Response(JSON.stringify({models:[{loaded_instances:[...loaded].map(id=>({id}))}]}));}
   if(url.endsWith('/unload')){const id=JSON.parse(opts.body).instance_id;unloads.push(id);if(failUnload)return new Response('{}',{status:500});loaded.delete(id);return new Response(JSON.stringify({instance_id:id}));}
   posts.push(JSON.parse(opts.body).model);dispatched.resolve();
   if(hold){await new Promise((resolve,reject)=>{if(opts.signal.aborted)return reject(Error('aborted'));opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}
   return new Response(JSON.stringify(answer));
  }});
 const life=impl.createLifecycle({lockPath:lock,loadOwned});
 return {life,lock,loaded,unloads,posts,dispatched,gate,hold:()=>{hold=true;}};
}
test('operator retire unloads exact owned instance, clears proven lock, leaves foreign model and stays off',async t=>{
 const s=await setup(t);await s.life.control('enable');const id=s.life.health().model.id;
 await s.life.control('retire');assert.deepEqual(s.unloads,[id]);assert.deepEqual([...s.loaded],['foreign-model']);assert.equal(existsSync(s.lock),false);assert.equal(s.life.health().tutor.enabled,false);
 await s.life.control('enable');assert.notEqual(s.life.health().model.id,id);assert.equal((await s.life.respond(req)).path,'model');
});
test('unknown dispatched request is not retried; queued client falls back and replacement requires explicit enable',async t=>{
 const s=await setup(t);await s.life.control('enable');s.hold();const a=s.life.respond(req);await s.dispatched.promise;const b=s.life.respond(req);
 await s.life.control('retire');const rs=await Promise.all([a,b]);assert.deepEqual(rs.map(x=>x.path),['template','template']);assert.equal(s.posts.length,1);assert.equal(s.life.health().tutor.enabled,false);assert.equal(existsSync(s.lock),false);
});
test('failed exact-instance unload keeps quarantine and prohibits new generation',async t=>{
 const s=await setup(t,{failUnload:true});await s.life.control('enable');await assert.rejects(s.life.control('retire'));assert.equal(existsSync(s.lock),true);assert.equal(s.life.health().tutor.enabled,false);await assert.rejects(s.life.control('enable'));assert.equal(s.posts.length,0);
});
test('disable wins over in-flight provisioning and concurrent enable cannot duplicate load',async t=>{
 const s=await setup(t,{blockedLoad:true});const loading=s.life.control('enable');await assert.rejects(s.life.control('enable'));await s.life.control('disable');s.gate.resolve();await loading;assert.equal(s.life.health().tutor.enabled,false);assert.equal(s.loaded.size,2);assert.equal((await s.life.respond(req)).reason,'disabled');
});
test('foreign lock is never removed or adopted',async t=>{
 const s=await setup(t);const text=JSON.stringify({owner:'other',token:'other',model:'foreign-model'});writeFileSync(s.lock,text);await assert.rejects(s.life.control('enable'));await s.life.control('retire');assert.equal(readFileSync(s.lock,'utf8'),text);assert.deepEqual(s.unloads,[]);
});
test('readiness failure after owned load retains recovery handle and visible quarantine for operator retire',async t=>{
 const s=await setup(t,{failReadiness:true});await assert.rejects(s.life.control('enable'));
 assert.equal(s.life.health().model?.quarantined,true);assert.equal(s.life.health().tutor.quarantined,true);
 const id=s.life.health().model.id;await s.life.control('retire');assert.deepEqual(s.unloads,[id]);assert.equal(existsSync(s.lock),false);assert.deepEqual([...s.loaded],['foreign-model']);
});
test('generation timeout leaves processing headroom within the 8 second internal budget',async t=>{
 const s=await setup(t);await s.life.control('enable');s.hold();
 const r=await s.life.respond(req);assert.equal(r.reason,'timeout');assert.equal(r.path,'template');
 assert.ok(r.metrics.total_ms<8000,`internal deadline exceeded: ${r.metrics.total_ms}`);assert.equal(s.posts.length,1);
});
test('authenticated private control exposes retire, unauthenticated caller cannot invoke it',async t=>{
 let actions=[];const server=createWorkerServer({secret:'x'.repeat(64),bridge:{},health:()=>({}),control:async action=>{actions.push(action);return {off:true};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port+'/control';
 const call=secret=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-LAT-IPC':secret},body:JSON.stringify({action:'retire'})});
 assert.equal((await call('wrong')).status,401);assert.equal((await call('x'.repeat(64))).status,200);assert.deepEqual(actions,['retire']);
});
