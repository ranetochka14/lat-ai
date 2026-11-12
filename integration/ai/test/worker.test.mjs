import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const impl=await import('../worker-http.mjs').catch(()=>({}));
test('private worker requires secret; denies browser Origin and oversized input',async t=>{
 assert.equal(typeof impl.createWorkerServer,'function');
 let calls=0;
 const server=impl.createWorkerServer({secret:'x'.repeat(64),bridge:{async ask(){calls++;return {status:200,body:{ok:true}};}},health:()=>({enabled:false})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const request=(path,body,headers={})=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,data}));});req.on('error',reject);req.end(body);
 });
 assert.equal((await request('/ask','{}')).status,401);
 assert.equal((await request('/ask','{}',{'X-LAT-IPC':'x'.repeat(64),Origin:'https://foreign.test'})).status,403);
 assert.equal((await request('/ask','x'.repeat(262145),{'X-LAT-IPC':'x'.repeat(64)})).status,413);
 assert.equal(calls,0);
 assert.equal((await request('/ask',JSON.stringify({body:{},resolved:{}}),{'X-LAT-IPC':'x'.repeat(64)})).status,200);
 assert.equal(calls,1);
});
