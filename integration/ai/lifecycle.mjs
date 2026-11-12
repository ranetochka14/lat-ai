import {Tutor} from './core/src/tutor.mjs';
import {LocalModel} from './core/src/local-model.mjs';
import {localModelFetch} from './local-model-http.mjs';
import {setTimeout as delay} from 'node:timers/promises';

// Operator-only lifecycle around the unchanged v10 coordinator. No adoption,
// lock deletion, POST retry, shared-runtime shutdown or automatic replacement.
export function createLifecycle({lockPath,modelKey='qwen3.5-9b',modelBudgetMs=7900,studyBudgetMs=180000,log=()=>{},loadOwned=LocalModel.loadOwned}={}){
 // Leave 100 ms of the 8 s module budget for timer delivery and response work.
 // This is measured headroom, not a hard real-time guarantee under OS stalls.
 const tutorOptions={log,modelBudgetMs,studyBudgetMs};
 let tutor=new Tutor(tutorOptions),model=null,loading=false,epoch=0;
 const health=()=>({service:'lat-ai-i02',loading,tutor:tutor.state,model:model?{id:model.model,...model.state}:null});
 async function control(action){
  if(action==='disable'){epoch++;tutor.disableModel();return health();}
  if(!['enable','retire'].includes(action))throw Error('invalid control');
  if(loading)throw Error('operator operation in progress');
  if(action==='enable'&&tutor.state.busy)throw Error('busy');
  if(action==='enable'&&tutor.state.enabled){if(tutor.state.quarantined)throw Error('operator recovery required');return health();}
  const operationEpoch=epoch;loading=true;
  try{
   if(action==='retire'){
    epoch++;tutor.disableModel();
    if(!model)return health();
    // retireOwnedInstance requires an owned quarantined reservation even when
    // idle. Acquiring it uses the coordinator's exclusive lock, never stealing.
    if(model.state.phase==='idle'){model.coordinator.begin();model.quarantineActive();}
    if(!await model.retireOwnedInstance())throw Error('owned stop not proven');
    const until=Date.now()+3000;
    while((model.state.quarantined||tutor.state.busy)&&Date.now()<until){model.recover();await delay(20);}
    if(!model.state.retired||model.state.quarantined||model.state.busy||tutor.state.busy)throw Error('owned stop settling');
    log({type:'operator',action:'retire',instance_id:model.model});
    model=null;tutor=new Tutor(tutorOptions);return health();
   }
   if(!model){
    try{model=await loadOwned({modelKey,contextLength:8192,lockPath,recoveryLog:log,fetchImpl:localModelFetch});}
    catch(error){
     // Provisioning can fail after loading our instance. Keep its ownership
     // proof and quarantine; an unproven load still refuses retirement in core.
     if(error.recoveryModel instanceof LocalModel){model=error.recoveryModel;tutor=new Tutor({...tutorOptions,modelAdapter:model,experimental:true});}
     throw error;
    }
   }
   if(!await model.isReady(AbortSignal.timeout(3000)))throw Error('model not ready');
   // An operator disable during slow provisioning must win.
   const enabled=operationEpoch===epoch;
   tutor=new Tutor({...tutorOptions,modelAdapter:model,experimental:true,modelEnabled:enabled,modelReady:true});
   log({type:'operator',action:enabled?'enable':'provisioned_disabled'});return health();
  }finally{loading=false;}
 }
 return {health,control,respond:(...args)=>tutor.respond(...args),study:input=>tutor.study(input),disable:()=>{epoch++;tutor.disableModel();}};
}
