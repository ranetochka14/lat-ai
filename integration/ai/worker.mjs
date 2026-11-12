import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLifecycle} from './lifecycle.mjs';
import {createBridge} from './bridge.mjs';
import {createWorkerServer} from './worker-http.mjs';

const dir=resolve(process.env.LAT_AI_RUNTIME??fileURLToPath(new URL('../../.runtime/i02/',import.meta.url)));
mkdirSync(dir,{recursive:true});
const secret=readFileSync(join(dir,'ipc-secret.txt'),'utf8').trim();
const log=event=>appendFileSync(join(dir,'ai-runtime.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
const lifecycle=createLifecycle({lockPath:join(dir,'model-inflight.lock'),modelKey:process.env.LAT_MODEL_KEY||'qwen3.5-9b',log});
const bridge=createBridge({dbPath:join(dir,'replay.sqlite3'),tutor:lifecycle,log});
const {health,control}=lifecycle;
const server=createWorkerServer({secret,bridge,health,control});
server.listen(Number(process.env.LAT_AI_PORT||8372),'127.0.0.1',()=>log({type:'worker_started',model_enabled:false}));
server.on('error',()=>{log({type:'worker_start_failed'});bridge.close();process.exitCode=1;});
process.on('SIGINT',()=>{lifecycle.disable();server.close(()=>{bridge.close();process.exit(0);});});
