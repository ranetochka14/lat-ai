import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';

export function createWorkerServer({secret,bridge,health,control}) {
 if(typeof secret!=='string'||secret.length<32)throw Error('IPC secret required');
 const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
 const server=http.createServer(async(req,res)=>{
  const provided=Buffer.from(req.headers['x-lat-ipc']??''),expected=Buffer.from(secret);
  if(req.headers.origin)return reply(res,403,{error:'private_worker'});
  if(provided.length!==expected.length||!timingSafeEqual(provided,expected))return reply(res,401,{error:'private_worker'});
  if(req.method==='GET'&&req.url==='/health')return reply(res,200,health());
  if(req.method!=='POST'||!['/ask','/assess','/assess/receipt','/study','/study/receipt','/control'].includes(req.url))return reply(res,404,{error:'not_found'});
  if(req.headers['content-type']!=='application/json')return reply(res,400,{error:'invalid_request'});
  let size=0,chunks=[];
  try {
   for await(const chunk of req){size+=chunk.length;if(size>262144){req.resume();return reply(res,413,{error:'too_large'});}chunks.push(chunk);}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(req.url==='/control'){
    if(!control||!['enable','disable','retire'].includes(value?.action))return reply(res,400,{error:'invalid_control'});
    return reply(res,200,await control(value.action));
   }
   if(!value||Object.keys(value).sort().join(',')!=='body,resolved')return reply(res,400,{error:'invalid_envelope'});
   const method={
    '/ask':'ask','/assess':'assess','/assess/receipt':'assessmentReceipt',
    '/study':'study','/study/receipt':'studyReceipt'
   }[req.url];
   const result=await bridge[method](value.body,value.resolved);
   reply(res,result.status,result.body);
  }catch{if(!res.headersSent)reply(res,503,{error:'worker_unavailable'});}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;
 return server;
}
