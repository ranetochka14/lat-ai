import http from 'node:http';

// Native fetch has an independent headers timeout (~300 s in Node/undici).
// Long local study requests are bounded by the caller's AbortSignal instead.
// No retries, redirects, remote origins or unbounded response buffering.
export function localModelFetch(input, options={}) {
 const url=new URL(input);
 if(url.origin!=='http://127.0.0.1:1234'||url.username||url.password)throw Error('local model origin required');
 if(!options.signal)throw Error('bounded model request requires an AbortSignal');
 return requestLocal(url,options);
}

export function requestLocal(url,{method='GET',headers={},body,signal},requestImpl=http.request){
 if(!signal)throw Error('bounded request required');
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const request=requestImpl(url,{method,headers,signal},response=>{
   if(response.statusCode>=300&&response.statusCode<400){
    response.destroy();reject(Error('model redirect refused'));return;
   }
   let size=0;const chunks=[];
   response.on('data',chunk=>{
    size+=chunk.length;
    if(size>400000){response.destroy();reject(Error('model response limit'));return;}
    chunks.push(chunk);
   });
   response.on('aborted',()=>reject(Error('model response interrupted')));
   response.on('error',reject);
   response.on('end',()=>{
    try{resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers}));}
    catch(error){reject(error);}
   });
  });
  request.on('error',reject);
  request.end(body);
 });
}
