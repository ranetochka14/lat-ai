import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fixture=fileURLToPath(new URL('./child-worker.fixture.mjs',import.meta.url));
const input=()=>({body:{contract_version:'1.0',request_id:randomUUID(),action:'explain',question:'Что делает эта строка?',course_id:1,lesson_id:2,exercise_id:3,code_context:{code:'print(1)',revision:1,selection:null}},resolved:{actor_id:1,access:'granted',course_id:1,lesson_id:2,exercise_id:3,lesson_key:'L1',topic:'types',task_key:'L1.types.1',mapping_version:'fixture',hint_events:[]}});
async function start(dir){
 const child=spawn(process.execPath,[fixture,dir],{windowsHide:true,stdio:['ignore','pipe','ignore']});
 let line='';const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture startup timeout')),3000);child.once('error',reject);child.stdout.on('data',data=>{line+=data;if(line.includes('\n')){clearTimeout(timer);resolve(JSON.parse(line.split('\n')[0]).port);}});});
 return {child,port};
}
function post(port,input){
 let req;
 const result=new Promise(resolve=>{req=http.request({host:'127.0.0.1',port,path:'/ask',method:'POST',headers:{'Content-Type':'application/json','X-LAT-IPC':'t'.repeat(64)}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',error=>resolve({error:error.code}));req.end(JSON.stringify(input));});
 return {req,result};
}
async function reached(dir){for(let i=0;i<150;i++){if(existsSync(join(dir,'calls.txt')))return;await wait(20);}throw Error('request never dispatched');}
async function stop(child){if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
test('lost HTTP after dispatch replays the completed response without second generation',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'lad-http-'));const worker=await start(dir);t.after(async()=>{await stop(worker.child);rmSync(dir,{recursive:true,force:true});});
 const body=input(),first=post(worker.port,body);await reached(dir);first.req.destroy();await first.result;
 const repeat=await post(worker.port,body).result;assert.equal(repeat.status,200);
 const again=await post(worker.port,body).result;assert.deepEqual(again,repeat);
 assert.equal(readFileSync(join(dir,'calls.txt'),'utf8').trim().split('\n').length,1);
});
test('worker killed after dispatch leaves durable pending and restart refuses regeneration',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'lad-crash-'));let worker=await start(dir);t.after(async()=>{await stop(worker.child);rmSync(dir,{recursive:true,force:true});});
 const body=input(),first=post(worker.port,body);await reached(dir);await stop(worker.child);await first.result;
 worker=await start(dir);const repeat=await post(worker.port,body).result;
 assert.equal(repeat.status,503);assert.equal(readFileSync(join(dir,'calls.txt'),'utf8').trim().split('\n').length,1);
});
