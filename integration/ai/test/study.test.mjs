import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {Tutor} from '../core/src/tutor.mjs';
import {studyGeneration,validateStudyOutput} from '../study-schema.mjs';
import {LocalModel} from '../core/src/local-model.mjs';
import {createBridge} from '../bridge.mjs';
import {createWorkerServer} from '../worker-http.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const excerpt='Mercury has the shortest orbital period of any planet. Venus has a longer orbital period. Earth takes about one year to orbit the Sun.';
const actor={actor_id:'1'};
const request=()=>({request_id:randomUUID(),mode:'test',source_text:excerpt});
const example=()=>({title:'Planetary orbits',lessons:[],questions:['Which planet orbits the quickest?','Which period is shortest?','How long is Earth’s orbit?'].map(prompt=>({
 prompt,options:['Mercury','Venus','Earth','Mars'],correct_index:0,hint:'Compare the periods.',explanation:'The shortest period means the quickest orbit.',source_quote:'Mercury has the shortest orbital period of any planet.',
 option_explanations:['The shortest period means the quickest orbit.','A longer period cannot be the shortest.','One year is longer than the stated minimum.','The excerpt does not establish this planet as quickest.']
}))});
const raw=(result=example(),finish_reason='stop')=>({answer:JSON.stringify(result),finish_reason});
const lmReply=value=>{
 if(value?.questions)value={...value,questions:value.questions.map(({explanation,...question})=>({...question,option_explanations:question.option_explanations.map((feedback,index)=>({option:question.options[index],feedback}))}))};
 return Response.json({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}],usage:{completion_tokens:200}});
};
const verification=(check={correct_index:0,hint_safe:true})=>({
 checks:[check,{correct_index:0,hint_safe:true},{correct_index:0,hint_safe:true}].map(value=>({key_evidence:'The quote explicitly supports this option for the question.',question_supported:true,...value}))
});
const feedback=()=>({checks:[0,1,2].map(()=>({feedback_review:'The paired reasons follow the stated orbital period comparison.',hint_review:'The hint does not name the planet.',remaining_step:'Compare the relevant orbital periods.',hint_reveals_answer:false,feedback_valid:true,hint_usable:true}))});
const ready={status:'ready',result:example(),error_code:null};
const enabled={experimental:true,modelEnabled:true,modelReady:true};
test('new generation requires four bounded option explanations while historical output remains readable',()=>{
 const schema=studyGeneration(request()).schema.properties.questions.items;
 assert.ok(schema.required.includes('option_explanations'));
 const historical=example();historical.questions.forEach(question=>delete question.option_explanations);
 assert.deepEqual(validateStudyOutput(raw(historical),request()),historical);
 const value=example();
 value.questions.forEach(q=>q.option_explanations=['The shortest period means the quickest orbit.','A longer period cannot be the shortest.','One year is longer than the stated minimum.','The excerpt does not establish this planet as quickest.']);
 assert.deepEqual(validateStudyOutput(raw(value),request()),value);
 for(const bad of [[],['Only one'],['a','b','c',' '],['a','b','c','x'.repeat(501)],['a','b','c','\uD800']]){
  const invalid=structuredClone(value);invalid.questions[0].option_explanations=bad;
  assert.throws(()=>validateStudyOutput(raw(invalid),request()));
 }
});
function folder(t){
 const path=mkdtempSync(join(tmpdir(),'lat-ai-study-'));
 t.after(()=>rmSync(path,{recursive:true,force:true}));
 return path;
}
function journal(t,tutor){
 const path=mkdtempSync(join(tmpdir(),'lat-ai-study-journal-'));
 const dbPath=join(path,'replay.sqlite');
 let bridge;
 t.after(()=>{bridge?.close();rmSync(path,{recursive:true,force:true});});
 return ()=>{bridge?.close();return bridge=createBridge({dbPath,tutor});};
}
function hold(t){
 const sent=Promise.withResolvers(),answer=Promise.withResolvers();
 t.after(()=>answer.resolve(raw()));
 let posts=0;
 const tutor=new Tutor({...enabled,generate:async()=>{posts++;sent.resolve();return answer.promise;}});
 return {sent,answer,tutor,posts:()=>posts};
}

test('authenticated IPC joins concurrent duplicates and replays a completed result after restart',async t=>{
 const {sent,answer,tutor,posts}=hold(t),reopen=journal(t,tutor);
 const secret='study-test-'.repeat(4);
 const server=createWorkerServer({secret,bridge:reopen(),health:()=>({})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.close();server.closeAllConnections();});
 const body=request(),url='http://127.0.0.1:'+server.address().port;
 const call=(route,secretValue=secret)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-LAT-IPC':secretValue},body:JSON.stringify({body,resolved:actor})});
 assert.equal((await call('/study','wrong')).status,401);
 const dispatch=call('/study');
 assert.equal(await Promise.race([sent.promise.then(()=>null),dispatch.then(response=>response.status)]),null);
 const duplicate=call('/study');
 assert.deepEqual(await (await call('/study/receipt')).json(),{status:'pending',result:null,error_code:null});
 answer.resolve(raw());
 for(const response of await Promise.all([dispatch,duplicate])){
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),ready);
 }
 const bridge=reopen();
 assert.deepEqual((await bridge.studyReceipt(body,actor)).body,ready);
 assert.deepEqual((await bridge.study(body,actor)).body,ready);
 assert.equal(posts(),1);
});

test('restart exposes a pending dispatch as unknown and never re-POSTs it',async t=>{
 const {sent,answer,tutor,posts}=hold(t),reopen=journal(t,tutor),bridge=reopen(),body=request();
 assert.equal(typeof bridge.study,'function');
 const dispatch=bridge.study(body,actor);
 await sent.promise;
 const restarted=reopen();
 const receipt={status:'unknown',result:null,error_code:'interrupted'};
 assert.deepEqual((await restarted.studyReceipt(body,actor)).body,receipt);
 assert.deepEqual((await restarted.study(body,actor)).body,receipt);
 answer.resolve(raw());
 await dispatch;
 assert.deepEqual((await restarted.studyReceipt(body,actor)).body,receipt);
 assert.equal(posts(),1);
});

test('killed worker leaves a durable pending receipt before model dispatch can complete',async t=>{
 const path=mkdtempSync(join(tmpdir(),'lat-ai-study-crash-'));
 const dbPath=join(path,'crash.sqlite');
 const body=request(),child=fork(new URL('./study-crash.fixture.mjs',import.meta.url),[dbPath,JSON.stringify(body)],{stdio:['ignore','ignore','ignore','ipc']});
 t.after(()=>child.kill());
 const exited=once(child,'exit');
 assert.equal((await once(child,'message'))[0],'dispatched');
 child.kill();
 await exited;
 let posts=0;
 const bridge=createBridge({dbPath,tutor:{study(){posts++;}}});
 try{
  const expected={status:'unknown',result:null,error_code:'interrupted'};
  assert.deepEqual((await bridge.studyReceipt(body,actor)).body,expected);
  assert.deepEqual((await bridge.study(body,actor)).body,expected);
  assert.equal(posts,0);
 }finally{bridge.close();}
});

test('a failed durable result write is unknown and exact replay cannot dispatch again',async t=>{
 let posts=0;
 const circular=example();
 circular.cycle=circular;
 const bridge=journal(t,{async study(){posts++;return {status:'ready',result:circular,error_code:null};}})();
 const body=request();
 assert.equal((await bridge.study(body,actor)).status,503);
 const expected={status:'unknown',result:null,error_code:'study_unavailable'};
 assert.deepEqual((await bridge.studyReceipt(body,actor)).body,expected);
 assert.deepEqual((await bridge.study(body,actor)).body,expected);
 assert.equal(posts,1);
});

test('receipt isolates actors and rejects changed mode or source',async t=>{
 const {sent,answer,tutor}=hold(t),bridge=journal(t,tutor)(),body=request();
 assert.equal(typeof bridge.study,'function');
 const dispatch=bridge.study(body,actor);
 await sent.promise;
 for(const changed of [{...body,mode:'course'},{...body,source_text:excerpt+' Added.'}]){
  assert.equal((await bridge.study(changed,actor)).status,409);
  assert.equal((await bridge.studyReceipt(changed,actor)).status,409);
 }
 assert.deepEqual((await bridge.studyReceipt(body,{actor_id:'2'})).body,{status:'missing',result:null,error_code:null});
 assert.equal((await bridge.study({...body,source_text:'😀'.repeat(99)},actor)).status,400);
 assert.equal((await bridge.study({...body,source_text:excerpt+'\0'},actor)).status,400);
 answer.resolve(raw());
 await dispatch;
});

test('generation rejects truncated, malformed, ungrounded and duplicate content',async t=>{
 const variants=[raw(example(),'length'),{...raw(),answer:'{'},{...raw(),answer:raw().answer.replace('{','{"title":"duplicate",')},raw({...example(),debug:true}),raw({...example(),title:'  '}),
  raw({...example(),lessons:[{title:'A lesson',content:'Some content',source_quote:excerpt.slice(0,25)}]}),
  ...[{prompt:'Which period is shortest?'},{options:['Mercury',' MERCURY ','Earth','Mars']},{correct_index:true},
   {source_quote:'This source quote was invented.'},{hint:'😀'.repeat(401)},{hint:'\uD800'},{hint:'a\0b'}]
   .map(fields=>{const value=example();Object.assign(value.questions[0],fields);return raw(value);})];
 let output;
 const bridge=journal(t,new Tutor({...enabled,generate:async()=>output}))();
 assert.equal(typeof bridge.study,'function');
 for(output of variants)assert.deepEqual((await bridge.study(request(),actor)).body,{status:'failed',result:null,error_code:'invalid_output'});
 const value={...example(),title:'😀'.repeat(160),lessons:[{title:'Planets',content:'An orbital period measures a full orbit.',source_quote:excerpt.slice(0,25)}]};
 output=raw(value);
 assert.deepEqual((await bridge.study({...request(),mode:'course'},actor)).body,{status:'ready',result:value,error_code:null});
});

test('study owns the LocalModel lock beyond the short tutor budget',async t=>{
 const sent=Promise.withResolvers(),answer=Promise.withResolvers(),posts=[];
 const model=new LocalModel({lockPath:join(folder(t),'lock'),recoveryDelayMs:0,fetchImpl:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({models:[{loaded_instances:[{id:'lat-ai-demo-9b'}]}]});
  posts.push(JSON.parse(options.body));
  if(posts.length===2)return lmReply(verification());
  if(posts.length===3)return lmReply(feedback());
  if(posts.length===4)return lmReply(feedback());
  sent.resolve();return answer.promise;
 }});
 const tutor=new Tutor({...enabled,modelBudgetMs:120,minimumGenerationMs:20,modelAdapter:model});
 assert.equal(typeof tutor.study,'function');
 const run=tutor.study(request());
 await sent.promise;
 assert.equal(model.state.busy,true);
 assert.equal(posts[0].max_tokens,3072);
 assert.equal(posts[0].response_format.json_schema.schema.properties.questions.minItems,3);
 assert.equal((await tutor.respond({role:'explain',message:'What is a string?',lesson:'L1'})).reason,'queue_budget');
 await delay(40);
 assert.equal(tutor.state.busy,true);
 assert.equal(posts.length,1);
 answer.resolve(lmReply(example()));
 const generated=await run;
 assert.equal(generated.status,'ready');
 assert.ok(generated.result.questions.every(question=>question.hint.includes('«Venus»')));
 assert.equal(posts.length,4);
 assert.equal(posts[1].max_tokens,1024);
 assert.equal(model.state.busy,false);
});

test('study schema supplies only exact Unicode source quotes to model generation',async t=>{
 const source='😀 В первой строке есть достаточно длинное утверждение о планетах. Вместе они обращаются вокруг звезды.\r\n\r\n'+excerpt;
 const posts=[];
 const model=new LocalModel({lockPath:join(folder(t),'lock'),fetchImpl:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({models:[{loaded_instances:[{id:'lat-ai-demo-9b'}]}]});
  posts.push(JSON.parse(options.body));
  return lmReply(posts.length===1?example():posts.length===2?verification():feedback());
 }});
 const tutor=new Tutor({...enabled,modelAdapter:model});
 assert.equal((await tutor.study({...request(),source_text:source})).status,'ready');
 const schema=posts[0].response_format.json_schema.schema;
 const choices=schema.properties.questions.items.properties.source_quote.enum;
 assert.ok(choices.length>=3);
 assert.ok(choices.some(value=>value.startsWith('😀')));
 for(const quote of choices){
  assert.ok(source.includes(quote));
  assert.ok(Array.from(quote).length>=20&&Array.from(quote).length<=500);
 }
 assert.deepEqual(JSON.parse(posts[0].messages[1].content).quote_candidates,choices);
 assert.equal(schema.properties.questions.maxItems,3);
});

test('blind same-model check blocks wrong keys, ambiguous questions and malformed verification',async t=>{
 const replies=[verification({correct_index:1,hint_safe:true}),verification({correct_index:-1,hint_safe:true}),
  {checks:[]}];
 const posts=[];
 const model=new LocalModel({lockPath:join(folder(t),'lock'),fetchImpl:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({models:[{loaded_instances:[{id:'lat-ai-demo-9b'}]}]});
  posts.push(JSON.parse(options.body));
  return lmReply(posts.length%2===1?example():replies.shift());
 }});
 const tutor=new Tutor({...enabled,modelAdapter:model});
 for(let index=0;index<3;index++){
  assert.deepEqual(await tutor.study(request()),{status:'failed',result:null,error_code:'invalid_output'});
  const blind=JSON.parse(posts.at(-1).messages[1].content);
  assert.equal(blind.questions.length,3);
  assert.deepEqual(blind.questions[0],{
   prompt:example().questions[0].prompt,options:example().questions[0].options,
   hint:example().questions[0].hint,source_quote:example().questions[0].source_quote
  });
 }
});

test('final hint quality rejection yields honest unavailable feedback while verified keys stay intact',async t=>{
 const result=example();
 result.questions[0].hint='Mercury is the answer.';
 const events=[];
 const rejected=feedback();rejected.checks.forEach(check=>check.hint_usable=false);
 let posts=0;
 const model=new LocalModel({lockPath:join(folder(t),'lock'),fetchImpl:async(url)=>{
  if(url.endsWith('/models'))return Response.json({models:[{loaded_instances:[{id:'lat-ai-demo-9b'}]}]});
  posts++;
  return lmReply([result,verification({correct_index:0,hint_safe:false}),feedback(),rejected][posts-1]);
 }});
 const tutor=new Tutor({...enabled,modelAdapter:model,log:event=>events.push(event)});
 const generated=await tutor.study(request());
 assert.equal(generated.status,'ready');
 const replacement=generated.result.questions[0].hint;
 assert.ok(replacement.includes('недоступна'));
 assert.ok(!replacement.includes('Mercury'));
 assert.deepEqual(generated.result,{...result,questions:result.questions.map(question=>({...question,hint:replacement}))});
 assert.deepEqual(events,[{type:'study_verification',hint_fallbacks:3,hint_repairs:1,hint_refinements:3,feedback_verified:true,input_tokens:null,total_output_tokens:800,reasoning_output_tokens:null}]);
 assert.equal(posts,4);
});

test('disable quarantines uncertain dispatch and a late model result cannot update its receipt',async t=>{
 const {sent,answer,tutor,posts}=hold(t),bridge=journal(t,tutor)(),body=request();
 assert.equal(typeof bridge.study,'function');
 const dispatch=bridge.study(body,actor);
 await sent.promise;
 tutor.disableModel();
 const unknown={status:'unknown',result:null,error_code:'disabled'};
 assert.deepEqual((await dispatch).body,unknown);
 assert.equal(tutor.state.quarantined,true);
 answer.resolve(raw());
 assert.deepEqual((await bridge.study(body,actor)).body,unknown);
 assert.deepEqual((await bridge.studyReceipt(body,actor)).body,unknown);
 assert.equal(posts(),1);
});
