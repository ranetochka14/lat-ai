import {createHash} from 'node:crypto';

const envelope=(status,error_code=null,result=null)=>({status,result,error_code});
const reply=(body,status=200)=>({status,body});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identity(input,resolved){
 if(!input||!['mode,request_id,source_text','generation_options,mode,request_id,source_text'].includes(Object.keys(input).sort().join(','))||
  !resolved||Object.keys(resolved).join(',')!=='actor_id'||
  typeof resolved.actor_id!=='string'||!resolved.actor_id.trim()||
  typeof input.request_id!=='string'||!uuid.test(input.request_id)||
  !['course','test'].includes(input.mode)||typeof input.source_text!=='string'||
  input.source_text.length>12000||!input.source_text.isWellFormed()||input.source_text.includes('\0')||!input.source_text.trim()){
  throw Error('invalid study request');
 }
 const {mode,source_text,generation_options}=input;
 if('generation_options' in input && (!generation_options || Object.keys(generation_options).sort().join(',')!=='detail,question_count' || ![5,6,7].includes(generation_options.question_count) || !['concise','detailed'].includes(generation_options.detail)))throw Error('invalid generation options');
 const options=generation_options?{generation_options:{question_count:generation_options.question_count,detail:generation_options.detail}}:{};
 const length=Array.from(source_text).length;
 if(length<100||length>6000)throw Error('invalid study source length');
 return {
  actor:resolved.actor_id,
  rid:input.request_id.toLowerCase(),
  digest:createHash('sha256').update(JSON.stringify(generation_options?[mode,source_text,options.generation_options]:[mode,source_text])).digest('hex'),
  input:{mode,source_text,...options}
 };
}

export function createStudyBridge({db,tutor,log}){
 db.exec(`CREATE TABLE IF NOT EXISTS study_requests(
  actor TEXT NOT NULL, rid TEXT NOT NULL, digest TEXT NOT NULL,
  status TEXT NOT NULL, result TEXT, error_code TEXT, PRIMARY KEY(actor,rid)
 );
 UPDATE study_requests SET status='unknown', error_code='interrupted' WHERE status='pending';`);
 const lookup=db.prepare('SELECT digest,status,result,error_code FROM study_requests WHERE actor=? AND rid=?');
 const insert=db.prepare("INSERT INTO study_requests(actor,rid,digest,status) VALUES(?,?,?,'pending')");
 const settle=db.prepare("UPDATE study_requests SET status=?,result=?,error_code=? WHERE actor=? AND rid=? AND status='pending'");
 const flights=new Map();
 const conflict=reply(envelope('failed','request_conflict'),409);
 const unavailable=()=>reply(envelope('unknown','study_unavailable'),503);
 const rowResponse=row=>reply(envelope(row.status,row.error_code,row.result===null?null:JSON.parse(row.result)));
 const flightKey=({actor,rid})=>JSON.stringify([actor,rid]);
 const orphaned=()=>reply(envelope('unknown','study_unavailable'));

 async function complete({actor,rid,input}){
  let outcome;
  try{outcome=await tutor.study(input);}
  catch{outcome=envelope('unknown','study_unavailable');}
  try{
   const {status,result,error_code}=outcome;
   const update=settle.run(status,result===null?null:JSON.stringify(result),error_code,actor,rid);
   if(update.changes!==1)return unavailable();
   try{log({type:'study',request_id:rid,status,error_code});}catch{}
   return reply(outcome);
  }catch{return unavailable();}
 }

 async function study(body,resolved){
  let key;
  try{key=identity(body,resolved);}catch{return reply(envelope('failed','invalid_request'),400);}
  try{
   const {actor,rid,digest}=key;
   const row=lookup.get(actor,rid);
   const id=flightKey(key);
   if(row){
    if(row.digest!==digest)return conflict;
    return flights.get(id)??(row.status==='pending'?orphaned():rowResponse(row));
   }
   // FULL synchronous SQLite commit precedes the first possible model dispatch.
   insert.run(actor,rid,digest);
   const flight=Promise.resolve().then(()=>complete(key));
   flights.set(id,flight);
   try{return await flight;}finally{flights.delete(id);}
  }catch{return unavailable();}
 }

 function studyReceipt(body,resolved){
  let key;
  try{key=identity(body,resolved);}catch{return reply(envelope('failed','invalid_request'),400);}
  try{
   const row=lookup.get(key.actor,key.rid);
   if(!row)return reply(envelope('missing'));
   if(row.digest!==key.digest)return conflict;
   return row.status==='pending'&&!flights.has(flightKey(key))?orphaned():rowResponse(row);
  }catch{return unavailable();}
 }

 return {study,studyReceipt};
}
