import {studyGeneration,studyVerification,validateStudyGeneration,verifiedStudyHints,studyFeedbackVerification,verifiedStudyFeedback,studyEliminationHints} from '../../study-schema.mjs';
import {assessmentInput as verifierInput,assessmentSystem as verifierSystem,assessmentSchema as verifierSchema} from './assessment-verifier.mjs';
import {contextForModel,validateRequestContext,CONTEXT_INSTRUCTION} from './code-context.mjs';
import {readFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RecoveryCoordinator} from './recovery.mjs';
import {fileURLToPath} from 'node:url';
import {modelInput} from './model-context.mjs';
import {buildFactLedger,separatedSchema} from './fact-ledger.mjs';
import {assessmentInput,assessmentSystem,assessmentSchema,validateCandidate} from './assessment.mjs';
const docs=JSON.parse(readFileSync(new URL('../data/materials.json',import.meta.url),'utf8')).documents;
const defaults=JSON.parse(readFileSync(new URL('../data/explain-options.json',import.meta.url),'utf8'));
export const SYSTEM=readFileSync(new URL('../data/explain-prompt.txt',import.meta.url),'utf8').trim();
export class LocalModel{
 #tuning;#owned=false;#retired=false;
 constructor({model='lat-ai-demo-9b',lockPath=fileURLToPath(new URL('../logs/model-inflight.lock',import.meta.url)),fetchImpl=fetch,protocol='structured',recoveryDelayMs=250,recoveryLog=()=>{},tuning={systemPrompt:SYSTEM,documents:docs,groundLiteralRanges:defaults.groundLiteralRanges,groundState:defaults.groundState}}={}){if(!['structured','native'].includes(protocol))throw Error('protocol');if(typeof tuning?.systemPrompt!=='string'||!tuning.systemPrompt.trim()||!['L1','L2'].every(id=>typeof tuning.documents?.[id]==='string'&&tuning.documents[id].trim()))throw Error('invalid tuning');this.#tuning=structuredClone(tuning);this.protocol=protocol;Object.defineProperty(this,'model',{value:model,enumerable:true});this.lockPath=lockPath;this.fetch=fetchImpl;this.coordinator=new RecoveryCoordinator({model,lockPath,recoveryDelayMs,log:recoveryLog});}
 get state(){return {...this.coordinator.state,retired:this.#retired};}
 recover(){return this.coordinator.recover();}
 quarantineActive(){this.coordinator.quarantine();}
 static async loadOwned({modelKey,contextLength=8192,loadImpl,...options}){
  if(typeof modelKey!=='string'||!modelKey||!Number.isInteger(contextLength)||contextLength<512)throw Error('owned load options');
  const lock=options.lockPath??fileURLToPath(new URL('../logs/model-inflight.lock',import.meta.url));
  if(existsSync(lock))throw Error('persistent quarantine or active request; cannot load replacement');
  const id='lat-owned-'+randomUUID();
  const load=loadImpl??(async({modelKey,id,contextLength})=>promisify(execFile)('lms',['load',modelKey,'--identifier',id,'--context-length',String(contextLength),'--parallel','1','-y'],{windowsHide:true,timeout:120000,maxBuffer:100000}));
  const model=new LocalModel({...options,model:id}),reservation=model.coordinator.begin();
  try{
   await load({modelKey,id,contextLength});model.#owned=true;
   // Own load reservation blocks peers. Unique ID is minted, never adopted.
   const r=await model.fetch('http://127.0.0.1:1234/api/v1/models',{signal:AbortSignal.timeout(3000),redirect:'error'});
   if(!r.ok||!(await r.json()).models?.some(m=>m.loaded_instances?.some(i=>i.id===id)))throw Error('not ready');
   model.coordinator.prove(reservation,'not_dispatched');return model;
  }catch{
   model.coordinator.quarantine(reservation);
   const error=new Error('owned provisioning incomplete: '+id);error.instanceId=id;error.recoveryModel=model;throw error;
  }
 }
 async retireOwnedInstance(){
  if(!this.#owned)return false;
  return this.coordinator.recoverWith(async()=>{
   const signal=AbortSignal.timeout(5000);
   if(!this.#retired){
    const r=await this.fetch('http://127.0.0.1:1234/api/v1/models/unload',{method:'POST',signal,redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({instance_id:this.model})});
    if(!r.ok||(await r.json()).instance_id!==this.model)return false;
    this.#retired=true;
   }
   const check=await this.fetch('http://127.0.0.1:1234/api/v1/models',{signal,redirect:'error'});if(!check.ok)return false;
   const j=await check.json();return Array.isArray(j.models)&&j.models.every(m=>Array.isArray(m.loaded_instances)&&m.loaded_instances.every(i=>i.id!==this.model));
  });
 }
 async isReady(signal){
  if(this.#retired||existsSync(this.lockPath))return false;
  const r=await this.fetch('http://127.0.0.1:1234/api/v1/models',{signal,redirect:'error'});if(!r.ok)return false;
  const j=await r.json();return j.models?.some(m=>m.loaded_instances?.some(i=>i.id===this.model))===true;
 }
 async generate(req,options){
  if(req.role==='study'){
   const generation=studyGeneration(req);
   const candidate=await this.#generateOnce(req,{...options,study:generation});
   const phases=[candidate];
   const output=extra=>({...candidate,...extra,stats:Object.fromEntries(['input_tokens','total_output_tokens','reasoning_output_tokens'].map(key=>[key,phases.every(phase=>Number.isFinite(phase.stats?.[key]))?phases.reduce((sum,phase)=>sum+phase.stats[key],0):null]))});
   const check=async study=>{
    options.signal.throwIfAborted();
    const response=await this.#generateOnce(req,{...options,maxTokens:req.generation_options?384*req.generation_options.question_count:1024,study,verification:true});
    phases.push(response);return response;
   };
   let result;
   try{
    result=validateStudyGeneration(candidate,req);
    const quotes=generation.input.quote_candidates;
    if([...result.lessons,...result.questions].some(item=>!quotes.includes(item.source_quote))){
     throw Error('unselected study quote');
    }
   }catch{return output({finish_reason:null});}
   const verified=await check(studyVerification(req,result));
   const hintSafety=verifiedStudyHints(verified,result);
   if(!hintSafety)return output({finish_reason:null});
   // Rationale is never passed to the blind key solver. Only after key agreement
   // may a separate phase evaluate the explanation and pedagogical usefulness.
   let hintQuality=verifiedStudyFeedback(await check(studyFeedbackVerification(req,result)),result);
   if(!hintQuality)return output({finish_reason:null});
   const hintRepairs=hintQuality.filter((useful,index)=>!useful||!hintSafety[index]).length;
   // Reuse one already-verified wrong-option explanation; never author new
   // facts or disclose the key. The final quality gate still has veto power.
   const hints=studyEliminationHints(result);
   for(const [index,hint] of hints.entries())result.questions[index].hint=hint??'Подсказка для этого вопроса недоступна.';
   hintQuality=verifiedStudyFeedback(await check(studyFeedbackVerification(req,result)),result);
   if(!hintQuality)return output({finish_reason:null});
   let hintFallbacks=0;
   for(const [index,useful] of hintQuality.entries()){
    if(useful&&hints[index])continue;
    result.questions[index].hint='Подсказка для этого вопроса недоступна.';
    hintFallbacks++;
   }
   return output({answer:JSON.stringify(result),hint_fallbacks:hintFallbacks,hint_repairs:hintRepairs,hint_refinements:hints.filter(Boolean).length,feedback_verified:true});
  }
  const candidate=await this.#generateOnce(req,options);
  if(req.role!=='assess')return candidate;
  try{validateCandidate(candidate,req.message);}catch{return {candidate,verification:null,stats:candidate.stats,finish_reason:candidate.finish_reason};}
  options.signal.throwIfAborted();
  const verification=await this.#generateOnce(req,{...options,verification:true});
  const stats=Object.fromEntries(['input_tokens','total_output_tokens','reasoning_output_tokens'].map(key=>[key,[candidate,verification].every(p=>Number.isFinite(p.stats?.[key]))?candidate.stats[key]+verification.stats[key]:null]));
  return {candidate,verification,task_key:req.assessment.task_key,stats,finish_reason:candidate.finish_reason==='stop'&&verification.finish_reason==='stop'?'stop':null};
 }
 async #generateOnce(req,{signal,maxTokens=192,verification=false,study}){
  validateRequestContext(req);
  if(this.#retired)throw Error('model retired');
  const op=this.coordinator.begin();let dispatched=false,terminal=false;
  try{
  signal.throwIfAborted();
  // Own reservation already exists: readiness is not a proof of prior completion.
  const ready=await this.fetch('http://127.0.0.1:1234/api/v1/models',{signal,redirect:'error'});
  if(!ready.ok||!(await ready.json()).models?.some(m=>m.loaded_instances?.some(i=>i.id===this.model)))throw Error('model cold');
  signal.throwIfAborted();
  const studying=req.role==='study';
  const ledger=!studying&&(this.#tuning.separateFacts===true||this.#tuning.factInput===true)?buildFactLedger(req):null;
  const assessing=req.role==='assess';
  const editorContext=contextForModel(req),systemPrompt=studying?study.system:assessing?(verification?verifierSystem:assessmentSystem):this.#tuning.systemPrompt+(editorContext?CONTEXT_INSTRUCTION:'');
  const input=JSON.stringify(studying?study.input:assessing?(verification?verifierInput(req):assessmentInput(req)):ledger?{lesson_id:req.lesson,question:req.message,facts:ledger.facts,...(editorContext?{editor_context:editorContext}:{})}:modelInput(req,this.#tuning));
  const schema=studying?study.schema:assessing?(verification?verifierSchema(req):assessmentSchema(req)):this.#tuning.separateFacts===true?separatedSchema(ledger,req.lesson):{type:'object',properties:{text:{type:'string',minLength:10,maxLength:900},source_ids:{type:'array',items:{type:'string',enum:[req.lesson]},minItems:1,maxItems:1}},required:['text','source_ids'],additionalProperties:false};
  const structured=studying||this.protocol==='structured';
  const payload=!structured?{model:this.model,reasoning:'off',temperature:assessing?0:.2,top_p:.8,top_k:20,min_p:0,repeat_penalty:1,max_output_tokens:maxTokens,store:false,stream:false,integrations:[],system_prompt:systemPrompt,input}:{model:this.model,messages:[{role:'system',content:systemPrompt},{role:'user',content:input}],reasoning_effort:'none',response_format:{type:'json_schema',json_schema:{name:studying?(study.name??(verification?'study_verification':'study')):'explain',strict:true,schema}},temperature:assessing||(studying&&verification)?0:.2,top_p:.8,max_tokens:maxTokens,store:false,stream:false};
  const endpoint=structured?'/v1/chat/completions':'/api/v1/chat';
  this.coordinator.dispatch(op);dispatched=true;
  const r=await this.fetch('http://127.0.0.1:1234'+endpoint,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok)throw Error('local model HTTP error');
  const text=await r.text();if(text.length>100000)throw Error('model response size');
  const raw=JSON.parse(text);
  if(structured){
   const choice=raw.choices?.[0];if(!choice?.message||!Number.isFinite(raw.usage?.completion_tokens)||raw.usage.completion_tokens<0||!['stop','length','content_filter','tool_calls'].includes(choice.finish_reason))throw Error('model protocol');
   this.coordinator.prove(op,'terminal_response');terminal=true;signal.throwIfAborted();
   return {answer:choice.message.content,finish_reason:choice.finish_reason,stats:{input_tokens:raw.usage.prompt_tokens,total_output_tokens:raw.usage.completion_tokens,reasoning_output_tokens:choice.message.reasoning_content?Math.max(1,raw.usage.completion_tokens_details?.reasoning_tokens||0):raw.usage.completion_tokens_details?.reasoning_tokens??null}};
  }
  if(!Array.isArray(raw.output)||!Number.isFinite(raw.stats?.total_output_tokens)||raw.stats.total_output_tokens<0)throw Error('model protocol');
  this.coordinator.prove(op,'terminal_response');terminal=true;signal.throwIfAborted();
  return {answer:raw.output.filter(x=>x.type==='message'&&typeof x.content==='string').map(x=>x.content).join('\n'),stats:raw.stats,finish_reason:raw.stats.total_output_tokens>=maxTokens?'length':null};
  }catch(error){if(!terminal){this.coordinator.quarantine(op);if(!dispatched)this.coordinator.prove(op,'not_dispatched');}throw error;}
 }
}
