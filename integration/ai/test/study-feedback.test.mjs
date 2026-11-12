import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalModel} from '../core/src/local-model.mjs';
import {Tutor} from '../core/src/tutor.mjs';
import * as studySchema from '../study-schema.mjs';
const {validateStudyOutput,verifiedStudyFeedback}=studySchema;

const source='WHERE filters rows before grouping. HAVING filters groups after grouping. ORDER BY sorts the result rows.';
const request={role:'study',mode:'test',source_text:source};
const pack=()=>{const result={title:'SQL clauses',lessons:[],questions:[
 {prompt:'Which clause filters individual rows before grouping?',options:['WHERE','HAVING','ORDER BY','SELECT'],correct_index:0,hint:'Decide whether the condition applies to individual rows or to completed groups.',explanation:'The condition is applied before groups exist, so WHERE performs this filtering.',option_explanations:['WHERE filters the individual rows before groups are formed.','HAVING tests completed groups, so it acts too late for this row filter.','ORDER BY changes the order of results; sorting does not filter rows.','The excerpt does not identify SELECT as the clause that filters rows before grouping.'],source_quote:'WHERE filters rows before grouping.'},
 {prompt:'Which clause tests a condition on completed groups?',options:['WHERE','HAVING','ORDER BY','SELECT'],correct_index:1,hint:'Locate the condition in the sequence: is grouping already complete?',explanation:'A condition on completed groups uses HAVING because its filtering occurs after grouping.',option_explanations:['WHERE filters rows before grouping, so it cannot apply the group-stage condition described here.','HAVING filters after groups are formed, matching the condition on completed groups.','ORDER BY sorts result rows instead of filtering groups.','The excerpt does not assign filtering completed groups to SELECT.'],source_quote:'HAVING filters groups after grouping.'},
 {prompt:'Which clause sorts the result rows?',options:['WHERE','HAVING','ORDER BY','SELECT'],correct_index:2,hint:'Distinguish changing row order from removing rows.',explanation:'Sorting changes result order; the excerpt assigns that operation to ORDER BY.',option_explanations:['WHERE filters rows before grouping; filtering is not sorting.','HAVING filters groups after grouping, not result order.','ORDER BY is the clause that changes the order of result rows.','The excerpt does not describe SELECT as sorting rows.'],source_quote:'ORDER BY sorts the result rows.'}
]};for(const question of result.questions)question.explanation=question.option_explanations[question.correct_index];return result;};
const raw=value=>({answer:JSON.stringify(value),finish_reason:'stop'});
const boundPack=(value=pack())=>({...value,questions:value.questions.map(({explanation,...question})=>({...question,option_explanations:question.option_explanations.map((feedback,index)=>({option:question.options[index],feedback}))}))});
const keys=()=>({checks:[0,1,2].map(correct_index=>({key_evidence:'The cited sentence explicitly assigns this operation to the keyed clause.',question_supported:true,correct_index,hint_safe:true}))});
const feedback=()=>({checks:[0,1,2].map(()=>({feedback_review:'Each paired explanation contrasts the option with its stated role in the excerpt.',hint_review:'The hint provides a distinction without naming the clause that answers the question.',remaining_step:'Classify the operation or stage and match it to the clause.',hint_reveals_answer:false,feedback_valid:true,hint_usable:true}))});
function harness(t,replies){
 const dir=mkdtempSync(join(tmpdir(),'lat-ai-study-feedback-')),posts=[],signals=[];
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const model=new LocalModel({lockPath:join(dir,'lock'),fetchImpl:async(url,options)=>{
  if(url.endsWith('/models'))return Response.json({models:[{loaded_instances:[{id:'lat-ai-demo-9b'}]}]});
  const payload=JSON.parse(options.body);posts.push(payload);signals.push(options.signal);
  let value=await replies(payload,posts.length);
  if(value instanceof Error)throw value;
  if(value?.questions?.every(question=>Array.isArray(question.option_explanations)))value=boundPack(value);
  return Response.json({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:50}});
 }});
 const tutor=new Tutor({experimental:true,modelEnabled:true,modelReady:true,modelAdapter:model});
 return {model,tutor,posts,signals};
}

test('every accepted pack verifies partial elimination even when draft quality passes',async t=>{
 const {model,posts}=harness(t,(_,number)=>[pack(),keys(),feedback(),feedback()][number-1]);
 const result=await model.generate(request,{signal:new AbortController().signal,maxTokens:3072});
 const decoded=validateStudyOutput(result,request);
 assert.equal(decoded.questions[0].option_explanations.length,4);
 assert.match(decoded.questions[0].hint,/«HAVING»/);
 assert.equal(posts.length,4);
 const blind=JSON.parse(posts[1].messages[1].content);
 for(const question of blind.questions){
  for(const field of ['correct_index','explanation','option_explanations'])assert.equal(Object.hasOwn(question,field),false);
 }
 assert.equal(JSON.parse(posts[2].messages[1].content).questions[0].options.length,4);
 assert.equal(result.stats.total_output_tokens,200);
 assert.equal(result.hint_refinements,3);
 assert.equal(result.hint_repairs,0);
});

test('new model generation refuses historical packs even though replay validation accepts them',async t=>{
 const legacy=pack();legacy.questions.forEach(question=>delete question.option_explanations);
 assert.deepEqual(validateStudyOutput(raw(legacy),request),legacy);
 const {tutor,posts}=harness(t,()=>legacy);
 assert.equal((await tutor.study(request)).status,'failed');
 assert.equal(posts.length,1);
});

test('explicit feedback rejection cannot promote explanations or trigger repair',async t=>{
 const rejected=feedback();rejected.checks[1].feedback_valid=false;
 const {tutor,posts}=harness(t,(_,number)=>[pack(),keys(),rejected][number-1]);
 assert.deepEqual(await tutor.study(request),{status:'failed',result:null,error_code:'invalid_output'});
 assert.equal(posts.length,3);
});

test('unsafe or generic drafts are replaced with one wrong-option explanation and verified once',async t=>{
 const original=pack();original.questions[0].hint='The answer is WHERE.';
 const blind=keys();blind.checks[0].hint_safe=false;
 const quality=feedback();quality.checks[0].hint_usable=false;
 const useful='Можно исключить вариант «HAVING»: HAVING tests completed groups, so it acts too late for this row filter. Сравни оставшиеся три варианта.';
 const {model,posts,signals}=harness(t,(_,number)=>[original,blind,quality,feedback()][number-1]);
 const result=await model.generate(request,{signal:new AbortController().signal,maxTokens:3072});
 const decoded=validateStudyOutput(result,request);
 assert.equal(decoded.questions[0].hint,useful);
 assert.deepEqual(decoded.questions[1].option_explanations,original.questions[1].option_explanations);
 assert.equal(posts.length,4);
 assert.equal(new Set(signals).size,1);
 assert.equal(JSON.parse(posts[3].messages[1].content).questions.length,3);
 assert.equal(JSON.parse(posts[3].messages[1].content).questions[0].hint,useful);
 assert.equal(result.hint_repairs,1);
 assert.equal(result.hint_fallbacks,0);
 assert.equal(result.stats.total_output_tokens,200);
});

test('a second hint rejection yields an honest unavailable message and no further generation',async t=>{
 const quality=feedback();quality.checks[0].hint_usable=false;
 const {model,posts}=harness(t,(_,number)=>[pack(),keys(),quality,quality][number-1]);
 const result=await model.generate(request,{signal:new AbortController().signal,maxTokens:3072});
 assert.equal(result.finish_reason,'stop');
 assert.match(JSON.parse(result.answer).questions[0].hint,/недоступна/);
 assert.equal(result.hint_fallbacks,1);
 assert.equal(posts.length,4);
});

test('malformed feedback is terminal invalid output and never qualifies for a repair',async t=>{
 const {tutor,posts}=harness(t,(_,number)=>[pack(),keys(),'{'][number-1]);
 assert.equal((await tutor.study(request)).error_code,'invalid_output');
 assert.equal(posts.length,3);
});

test('unknown final hint verification transport failure quarantines without retrying or publishing the pack',async t=>{
 const quality=feedback();quality.checks[0].hint_usable=false;
 const {tutor,model,posts}=harness(t,(_,number)=>[pack(),keys(),quality,new Error('connection lost')][number-1]);
 const result=await tutor.study(request);
 assert.equal(result.status,'unknown');
 assert.equal(result.result,null);
 assert.equal(model.state.quarantined,true);
 assert.equal(posts.length,4);
});

test('feedback rejects malformed, duplicate and incomplete verdicts',()=>{
 assert.deepEqual(verifiedStudyFeedback(raw(feedback()),pack()),[true,true,true]);
 for(const value of [{checks:[]},{checks:[{feedback_valid:true,hint_usable:'true'}]}, {...feedback(),extra:true}])assert.equal(verifiedStudyFeedback(raw(value),pack()),null);
 assert.equal(verifiedStudyFeedback({...raw(feedback()),finish_reason:'length'},pack()),null);
 assert.equal(verifiedStudyFeedback({answer:JSON.stringify(feedback()).replace('{','{"checks":[], '),finish_reason:'stop'},pack()),null);

});

test('generation binds each explanation to exact option text even when the correct record is returned last',()=>{
 const value=boundPack();
 for(const question of value.questions){const [correct]=question.option_explanations.splice(question.correct_index,1);question.option_explanations.push(correct);}
 assert.equal(typeof studySchema.validateStudyGeneration,'function');
 const result=studySchema.validateStudyGeneration(raw(value),request);
 assert.deepEqual(result,pack());
 for(const badOption of ['UNLISTED','WHERE']){
  const invalid=boundPack();invalid.questions[0].option_explanations[1].option=badOption;
  assert.throws(()=>studySchema.validateStudyGeneration(raw(invalid),request));
 }
 // Positional arrays remain readable receipts, but cannot bypass generation binding.
 assert.throws(()=>studySchema.validateStudyGeneration(raw(pack()),request));
 const pairs=studySchema.studyFeedbackVerification(request,result).input.questions[1].options;
 assert.deepEqual(pairs[1],{option:'HAVING',is_correct:true,explanation:'HAVING filters after groups are formed, matching the condition on completed groups.'});
});

test('generation derives the general explanation from bound correct feedback and rejects serialized legacy payloads',()=>{
 const schema=studySchema.studyGeneration(request).schema.properties.questions.items;
 assert.equal(Object.hasOwn(schema.properties,'explanation'),false);
 assert.equal(schema.properties.option_explanations.items.properties.feedback.maxLength,500);
 const value=pack();
 for(const question of value.questions){
  delete question.explanation;
  question.option_explanations=question.option_explanations.map((feedback,index)=>({option:question.options[index],feedback}));
 }
 const result=studySchema.validateStudyGeneration(raw(value),request);
 assert.equal(result.questions[1].explanation,'HAVING filters after groups are formed, matching the condition on completed groups.');
 const invalid=structuredClone(value);invalid.questions[0].explanation=JSON.stringify(invalid.questions[0].option_explanations);
 assert.throws(()=>studySchema.validateStudyGeneration(raw(invalid),request));
 value.questions[0].option_explanations[0].feedback='x'.repeat(501);
 assert.throws(()=>studySchema.validateStudyGeneration(raw(value),request));
});

test('blind key agreement cannot override unsupported question evidence',()=>{
 const verdict=keys();
 verdict.checks[0].key_evidence='The source only assigns filtering to WHERE, not every guarantee in the question.';
 verdict.checks[0].question_supported=false;
 assert.equal(studySchema.verifiedStudyHints(raw(verdict),pack()),null);
});

test('hint disclosure and absent learner steps override positive usefulness flags',()=>{
 const verdict=feedback();
 verdict.checks[0].hint_reveals_answer=true;
 verdict.checks[1].remaining_step='none';
 assert.deepEqual(verifiedStudyFeedback(raw(verdict),pack()),[false,false,true]);
 const copied=pack();copied.questions[2].hint='Choose ORDER BY.';
 assert.deepEqual(verifiedStudyFeedback(raw(feedback()),copied),[true,true,false]);
});

test('partial elimination selects exactly one grounded wrong option without revealing the correct option',()=>{
 assert.equal(typeof studySchema.studyEliminationHints,'function');
 const hints=studySchema.studyEliminationHints(pack());
 assert.equal(hints.length,3);
 assert.equal(hints[0],'Можно исключить вариант «HAVING»: HAVING tests completed groups, so it acts too late for this row filter. Сравни оставшиеся три варианта.');
 assert.ok(!hints[0].includes('WHERE'));
 assert.ok(!hints[0].includes('ORDER BY'));
 assert.ok(!hints[0].includes('SELECT'));
});

test('partial elimination rejects correct-label leakage, quote-only, generic or oversized feedback',()=>{
 const value=pack();
 value.questions[0].options=['A','B','C','D'];
 value.questions[0].option_explanations=['A is correct.','A is the answer, B is wrong.','Incorrect.','x'.repeat(500)];
 value.questions[1].option_explanations=value.questions[1].options.map(()=>value.questions[1].source_quote);
 value.questions[2].option_explanations=value.questions[2].options.map(()=> 'Incorrect.');
 assert.deepEqual(studySchema.studyEliminationHints(value),[null,null,null]);
 value.questions[0].option_explanations[3]='This choice assumes the later stage, while the question concerns the earlier stage.';
 assert.match(studySchema.studyEliminationHints(value)[0],/«D»/);
});
