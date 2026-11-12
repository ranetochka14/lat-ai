import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';
const file=new URL('../../../assets/tutor.js',import.meta.url);
const window={};if(existsSync(file))vm.runInNewContext(readFileSync(file,'utf8'),{window,crypto:{randomUUID:()=>crypto.randomUUID()},structuredClone});
test('editor snapshot keeps selection when focus changes and preserves original source',()=>{
 assert.equal(typeof window.LATTutor?.EditorSession,'function');
 const s=new window.LATTutor.EditorSession({course_id:1,lesson_id:2,exercise_id:3});
 s.edit('x = "😀"\r\nprint(x)');s.select(10,18);
 const request=s.begin('explain','Объясни выделение');
 assert.equal(request.code_context.code,'x = "😀"\r\nprint(x)');
 assert.deepEqual(JSON.parse(JSON.stringify(request.code_context.selection)),{start:10,end:18});
 assert.equal(s.retry().request_id,request.request_id);
 s.edit('print(42)');assert.equal(s.isStale(request),true);
 assert.equal(request.code_context.code,'x = "😀"\r\nprint(x)');
 assert.equal(s.retry().code_context.code,request.code_context.code);
});
test('newer question replaces active ID; old result cannot overwrite; response revision checked',()=>{
 assert.equal(typeof window.LATTutor?.EditorSession,'function');
 const s=new window.LATTutor.EditorSession({course_id:1,lesson_id:2,exercise_id:3});s.edit('print(1)');
 const a=s.begin('explain','Почему?'),b=s.begin('hint','Что дальше?');
 assert.equal(s.accepts({request_id:a.request_id,context:{code_context:a.code_context}}),false);
 assert.equal(s.accepts({request_id:b.request_id,context:{code_context:b.code_context}}),true);
 assert.equal(s.accepts({request_id:b.request_id,context:{code_context:{revision:999}}}),false);
});

test('answer style preserves source, rejects empty questions and remains fixed on retry',()=>{
 const s=new window.LATTutor.EditorSession({course_id:1,lesson_id:2,exercise_id:3});
 s.edit('print(3 + 2)');
 assert.throws(()=>s.begin('explain','  ','brief'),/Напиши вопрос/);
 assert.throws(()=>s.begin('explain','x'.repeat(2000),'brief'),/Сократи/);
 const brief=s.begin('explain','Почему?','brief');
 assert.equal(brief.question,'Почему?\nОтветь кратко, по сути.');
 assert.equal(s.retry().question,brief.question);
 assert.equal(brief.code_context.code,'print(3 + 2)');
 assert.match(s.begin('hint','Следующий шаг?','step_by_step').question,/не раскрывая готовое решение/);
});
