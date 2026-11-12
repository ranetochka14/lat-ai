import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestLocal,localModelFetch} from '../local-model-http.mjs';

async function server(t,handler){
 const instance=http.createServer(handler);
 await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
 t.after(()=>{instance.closeAllConnections();instance.close();});
 return 'http://127.0.0.1:'+instance.address().port;
}

test('local adapter refuses remote origins and calls without a deadline signal',()=>{
 assert.throws(()=>localModelFetch('https://example.com',{signal:AbortSignal.timeout(100)}),/origin/);
 assert.throws(()=>localModelFetch('http://127.0.0.1:1234/v1/chat/completions'),/AbortSignal/);
});

test('delayed headers and chunked terminal response use one POST with the original body',async t=>{
 let calls=0,received='';
 const url=await server(t,(req,res)=>{
  calls++;req.on('data',chunk=>received+=chunk);req.on('end',()=>setTimeout(()=>{
   res.writeHead(200,{'Content-Type':'application/json'});res.write('{"done":');
   setTimeout(()=>res.end('true}'),20);
  },70));
 });
 const response=await requestLocal(url,{method:'POST',body:'original',signal:AbortSignal.timeout(1000)});
 assert.deepEqual(await response.json(),{done:true});assert.equal(calls,1);assert.equal(received,'original');
});

test('aborted or interrupted POST is never retried or returned as a complete response',async t=>{
 for(const interrupt of [false,true]){
  let calls=0;
  const url=await server(t,(_,res)=>{calls++;if(interrupt){res.writeHead(200);res.write('{');setTimeout(()=>res.destroy(),20);}});
  await assert.rejects(requestLocal(url,{method:'POST',body:'one',signal:AbortSignal.timeout(100)}));
  assert.equal(calls,1);
 }
});

test('redirect and excessive body are rejected without following or retrying',async t=>{
 for(const redirect of [false,true]){
  let calls=0;
  const url=await server(t,(_,res)=>{calls++;if(redirect){res.writeHead(302,{Location:'/other'});res.end();}else res.end('x'.repeat(400001));});
  await assert.rejects(requestLocal(url,{signal:AbortSignal.timeout(1000)}));assert.equal(calls,1);
 }
});
