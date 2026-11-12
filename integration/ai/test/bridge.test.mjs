import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Tutor} from '../core/src/tutor.mjs';

const implementation=await import('../bridge.mjs').catch(()=>({}));
const body=(extra={})=>({contract_version:'1.0',request_id:randomUUID(),action:'hint',question:'Подскажи первый шаг',course_id:1,lesson_id:2,exercise_id:3,...extra});
const resolved=(extra={})=>({actor_id:1,access:'granted',course_id:1,lesson_id:2,exercise_id:3,lesson_key:'L1',topic:'types',task_key:'L1.types.1',mapping_version:'test-v1',hint_events:[],...extra});
function setup(t,tutor=new Tutor()) {
 assert.equal(typeof implementation.createBridge,'function','persistent bridge must be implemented');
 const dir=mkdtempSync(join(tmpdir(),'lat-ai-i02-'));
 const bridge=implementation.createBridge({dbPath:join(dir,'ai.sqlite3'),tutor});
 t.after(()=>{bridge.close();rmSync(dir,{recursive:true,force:true});});
 return {bridge,dir};
}
test('same ID replays exactly once; changed body conflicts',async t=>{
 const {bridge}=setup(t), b=body(), r=resolved();
 const first=await bridge.ask(b,r);
 assert.equal(first.status,200);assert.equal(first.body.answer.hint_level,1);
 assert.deepEqual(await bridge.ask(b,r),first);
 assert.equal((await bridge.ask({...b,question:'Иной вопрос'},r)).status,409);
 assert.equal((await bridge.ask(body(),r)).body.answer.hint_level,2);
});
test('concurrent same and different hint IDs cannot duplicate or skip',async t=>{
 const {bridge}=setup(t), b=body(),r=resolved();
 const answers=await Promise.all([bridge.ask(b,r),bridge.ask(b,r),bridge.ask(body(),r)]);
 assert.deepEqual(answers[0],answers[1]);
 assert.deepEqual(answers.map(x=>x.body.answer.hint_level),[1,1,2]);
 assert.equal((await bridge.ask(body(),r)).body.answer.hint_level,2);
 const withAttempt=resolved({hint_events:[{id:'attempt:1',task_id:'L1.types.1',kind:'attempt',status:'verified',passed:false}]});
 assert.equal((await bridge.ask(body(),withAttempt)).body.answer.hint_level,3);
 assert.equal((await bridge.ask(body(),withAttempt)).body.answer.hint_level,3);
});
test('replay is actor isolated and rechecks access and mapping',async t=>{
 const {bridge}=setup(t),b=body();await bridge.ask(b,resolved());
 assert.equal((await bridge.ask(b,resolved({access:'denied'}))).status,404);
 assert.equal((await bridge.ask(b,resolved({actor_id:2}))).body.answer.hint_level,1);
 assert.equal((await bridge.ask(b,resolved({mapping_version:'changed'}))).status,409);
});
test('policy and fallback never advance hints',async t=>{
 const {bridge}=setup(t);
 assert.equal((await bridge.ask(body({question:'Не хочу больше жить'}),resolved())).body.outcome,'policy');
 assert.equal((await bridge.ask(body({action:'explain'}),resolved())).body.outcome,'fallback');
 assert.equal((await bridge.ask(body(),resolved())).body.answer.hint_level,1);
});
test('durable replay survives restart; abandoned pending request never regenerates',async t=>{
 const {bridge,dir}=setup(t),b=body(),r=resolved();const result=await bridge.ask(b,r);bridge.close();
 const reopened=implementation.createBridge({dbPath:join(dir,'ai.sqlite3'),tutor:new Tutor()});
 assert.deepEqual(await reopened.ask(b,r),result);reopened.close();
 const db=new DatabaseSync(join(dir,'ai.sqlite3'));db.exec("UPDATE requests SET result=NULL WHERE actor=1");db.close();
 let calls=0;
 const uncertain=implementation.createBridge({dbPath:join(dir,'ai.sqlite3'),tutor:{respond(){calls++;throw Error('must not run');}}});
 assert.equal((await uncertain.ask(b,r)).status,503);assert.equal(calls,0);uncertain.close();
});
test('a second worker cannot own the same durable journal',t=>{
 const {dir}=setup(t);let second,error;
 try{second=implementation.createBridge({dbPath:join(dir,'ai.sqlite3'),tutor:new Tutor()});}catch(e){error=e;}finally{second?.close();}
 assert.ok(error,'second owner must be rejected by SQLite, not just by a TCP port');
});
