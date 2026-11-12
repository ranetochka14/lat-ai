import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {profile,plan,hint,quiz} from './core.mjs';
import {validateAnswer} from './validation.mjs';
import {buildFactLedger,validateSeparated} from './fact-ledger.mjs';
import {routeDetails,policyText,fallback} from './policy.mjs';
import {validateRequestContext,contextMetadata} from './code-context.mjs';
import {hasVisibleText} from './safety-router.mjs';
import {assessmentInput,validateAssessment} from './assessment.mjs';
import {validateStudyOutput} from '../../study-schema.mjs';
const STUDY_BUDGET_MS=180000;
const roles=['explain','hint','profile','plan','quiz','assess'];
const numeric=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
const allowed=new Set(['role','message','lesson','topic','topics','count','minutes','level','document','task_id','code_context']);
function requestValid(r){
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!allowed.has(k))||!roles.includes(r.role))return false;
 if(['message','document'].some(k=>r[k]!==undefined&&(typeof r[k]!=='string'||r[k].length>4000)))return false;
 if(r.task_id!==undefined&&(typeof r.task_id!=='string'||!r.task_id||r.task_id.length>100))return false;
 if(r.topic!==undefined&&(typeof r.topic!=='string'||r.topic.length>100))return false;
 if(['explain','assess'].includes(r.role)&&(!['L1','L2'].includes(r.lesson)||!hasVisibleText(r.message)))return false;
 return true;
}
export class Tutor {
 #enabled;#ready;#quarantine=false;#busy=false;#queue=[];#controller;#epoch=0;#adapter;
 constructor({generate,modelAdapter,answerMode='plain',experimental=false,modelEnabled=false,modelReady=false,modelBudgetMs=8000,minimumGenerationMs=4000,log=()=>{}}={}){
  if(!['plain','separated'].includes(answerMode))throw Error('answer mode');this.answerMode=answerMode;
  if(!(modelBudgetMs>0&&modelBudgetMs<=8000&&minimumGenerationMs>0&&minimumGenerationMs<=modelBudgetMs))throw Error('budget');
  if(modelAdapter&&generate)throw Error('choose modelAdapter or generate');this.#adapter=modelAdapter;
  this.generate=modelAdapter?modelAdapter.generate.bind(modelAdapter):generate;this.experimental=experimental;this.budget=modelBudgetMs;this.minimum=minimumGenerationMs;this.log=log;this.#enabled=experimental&&modelEnabled;this.#ready=modelReady;
 }
 #isQuarantined(){return this.#adapter?this.#adapter.state.quarantined:this.#quarantine;}
 #markQuarantine(){if(this.#adapter)this.#adapter.quarantineActive();else this.#quarantine=true;}
 async recoverModel(){if(this.#adapter)this.#adapter.recover();return this.state;}
 get state(){return {enabled:this.#enabled,ready:this.#ready,quarantined:this.#isQuarantined(),busy:this.#busy,queued:this.#queue.length,recovery_phase:this.#adapter?.state.phase??null};}
 disableModel(){this.#enabled=false;this.#epoch++;if(this.#busy){this.#markQuarantine();this.#controller?.abort();}this.#wake();}
 enableExperiment(){if(this.#isQuarantined())throw Error('quarantine requires operator recovery');if(!this.experimental)throw Error('experiment opt-in required');this.#enabled=true;}
 #wake(){for(const wake of [...this.#queue])wake();}
 #unavailable(){return !this.#enabled?'disabled':this.#isQuarantined()?'quarantined':this.#adapter?.state.retired?'retired':!this.#ready?'cold':!this.generate?'unconfigured':null;}
 async #slot(start,budget){
  if(this.#unavailable())return this.#unavailable();
  if(this.#busy){
   if(this.#queue.length>=1)return 'queue_full';
   const remaining=budget-(performance.now()-start)-this.minimum;
   if(remaining<=0)return 'queue_budget';
   await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);this.#queue=this.#queue.filter(x=>x!==wake);resolve();};this.#queue.push(wake);timer=setTimeout(wake,remaining);});
  }
  if(this.#unavailable())return this.#unavailable();
  if(this.#busy||budget-(performance.now()-start)<this.minimum)return 'queue_budget';
  this.#busy=true;return null;
 }
 async respond(input, trustedContext={}){
  const start=performance.now(),id=randomUUID();let queueMs=0,generationMs=0,validationMs=0,stats={},reason='ok',path='error',result,finish=null,policy=null,codeMeta;
  const done=()=>{
   const metrics={id,role:roles.includes(input?.role)?input.role:'invalid',path,reason,queue_ms:queueMs,generation_ms:generationMs,validation_ms:validationMs,total_ms:performance.now()-start,input_tokens:stats.input_tokens??null,completion_tokens:stats.total_output_tokens??null,reasoning_tokens:stats.reasoning_output_tokens??null,tokens_per_second:stats.tokens_per_second??null,ttft_ms:Number.isFinite(stats.time_to_first_token_seconds)?stats.time_to_first_token_seconds*1000:null,finish_reason:finish,retries:0};
   Object.assign(metrics,{policy_version:policy?.version??null,policy_rule:policy?.rule??null,policy_view:policy?.view??null,policy_field:policy?.field??null});
   for(const key of ['input_tokens','completion_tokens','reasoning_tokens','tokens_per_second','ttft_ms'])metrics[key]=numeric(metrics[key]);
   try{this.log({...metrics});}catch{}return {id,role:metrics.role,path,reason,result,metrics,...(codeMeta?{code_context:codeMeta}:{})};
  };
  if(!requestValid(input)){reason='invalid_request';result={text:'Некорректный запрос.'};return done();}
  // Snapshot trusted state before any await to prevent mutation during queuing.
  let req,ctx;try{req=structuredClone(input);ctx=structuredClone(trustedContext);}catch{reason='invalid_context';return done();}
  const assessing=req.role==='assess';
  if(assessing){try{req.assessment=ctx.assessment;assessmentInput(req);}catch{reason='invalid_assessment_context';return done();}}
  try{validateRequestContext(req);codeMeta=contextMetadata(req);}catch{reason='invalid_code_context';result={text:'Не удалось прикрепить код: проверь размер и выделение. Максимум4000 символов кода и6000 вместе с вопросом; текст не обрезан.'};return done();}
  policy=routeDetails(req.message,req.document,req.code_context?.code);
  if(policy.route){path='refusal';reason=policy.route;result={text:policyText(reason)};return done();}
  if(req.role!=='explain'&&!assessing){
   try{result=req.role==='profile'?profile(ctx.events):req.role==='plan'?plan(req,ctx.events):req.role==='hint'?hint(req,ctx):quiz(req);path=req.role==='quiz'?'bank':'catalogue';}
   catch{reason='invalid_role_input';result={text:'Проверь параметры задания или доверенные учебные данные.'};}return done();
  }
  result=assessing?null:fallback(req.topic);path=assessing?'error':'template';
  const generated=await this.#generate(req,start,this.budget,192);
  ({reason,queueMs,generationMs}=generated);
  if(reason!=='ok')return done();
  const raw=generated.raw;
  stats=raw?.stats||{};
  finish=['stop','length'].includes(raw?.finish_reason)?raw.finish_reason:null;
  const v=performance.now();
  try{
   result=assessing?validateAssessment(raw,req.message):this.answerMode==='separated'?validateSeparated(raw,req.lesson,buildFactLedger(req)):validateAnswer(raw,req.lesson);
   path='model';
  }catch{reason='invalid_output';}
  validationMs=performance.now()-v;
  return done();
 }

 async study({mode,source_text,generation_options}){
  const generated=await this.#generate({role:'study',mode,source_text,...(generation_options?{generation_options}:{})},performance.now(),STUDY_BUDGET_MS,generation_options?768*(generation_options.question_count+1):3072);
  if(generated.reason!=='ok'){
   return {status:generated.uncertain?'unknown':'failed',result:null,error_code:generated.reason};
  }
  try{
   const result=validateStudyOutput(generated.raw,{mode,source_text,generation_options});
   if(Number.isInteger(generated.raw.hint_fallbacks)){
    try{this.log({type:'study_verification',hint_fallbacks:generated.raw.hint_fallbacks,hint_repairs:generated.raw.hint_repairs??0,hint_refinements:generated.raw.hint_refinements??0,feedback_verified:generated.raw.feedback_verified===true,...(generated.raw.stats??{})});}catch{}
   }
   return {status:'ready',result,error_code:null};
  }
  catch{return {status:'failed',result:null,error_code:'invalid_output'};}
 }

 async #generate(req,start,budget,maxTokens){
  this.#adapter?.recover();
  const slotError=await this.#slot(start,budget),queueMs=performance.now()-start;
  if(slotError)return {reason:slotError,queueMs,generationMs:0};
  const reason=this.#unavailable();
  if(reason){this.#busy=false;this.#wake();return {reason,queueMs,generationMs:0};}
  const epoch=this.#epoch,controller=new AbortController();
  this.#controller=controller;
  const began=performance.now();
  let timeout=false,started=false;
  const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
  const timer=setTimeout(()=>{
   timeout=true;
   this.#markQuarantine();
   controller.abort();
   this.#wake();
  },Math.max(0,budget-(began-start)));
  const task=Promise.resolve().then(()=>{
   controller.signal.throwIfAborted();
   if(epoch!==this.#epoch||this.#unavailable())throw Error('disabled');
   started=true;
   return this.generate(req,{signal:controller.signal,maxTokens});
  });
  try{
   const raw=await Promise.race([task,cancelled]),generationMs=performance.now()-began;
   if(epoch!==this.#epoch||!this.#enabled)return {reason:'disabled',queueMs,generationMs,uncertain:started};
   if(performance.now()-start>=budget){
    if(!this.#adapter)this.#markQuarantine();
    return {reason:'timeout',queueMs,generationMs,uncertain:started};
   }
   return {reason:'ok',raw,queueMs,generationMs};
  }catch{
   if(!this.#adapter)this.#markQuarantine();
   return {reason:timeout?'timeout':!this.#enabled?'disabled':'transport',queueMs,generationMs:performance.now()-began,uncertain:started};
  }finally{
   clearTimeout(timer);
   this.#controller=undefined;
   this.#busy=false;
   this.#wake();
  }
 }
}
