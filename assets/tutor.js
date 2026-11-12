/* Minimal editor-to-tutor integration. No code execution, credentials or model controls. */
(function (global) {
  'use strict';
  class EditorSession {
    constructor(ids) { this.ids={...ids};this.code='';this.revision=0;this.selection=null;this.latest=null; }
    edit(code) { if(code!==this.code){this.code=code;this.revision++;this.selection=null;} }
    select(start,end) { this.selection=start<end?{start,end}:null; }
    begin(action,question,style) {
      if(!question.trim()||question.length>2000)throw Error('Напиши вопрос длиной до 2000 символов.');
      const suffix=style==='brief'?'\nОтветь кратко, по сути.':style==='step_by_step'?'\nОбъясни по шагам.':'';
      if(question.length+suffix.length>2000)throw Error('Сократи вопрос до 1900 символов, чтобы добавить выбранный стиль ответа.');
      question+=suffix;
      if(this.code.length>4000)throw Error('Код длиннее 4000 символов. Он не будет обрезан.');
      this.latest={contract_version:'1.0',request_id:crypto.randomUUID(),action,question,...this.ids,
        code_context:{code:this.code,revision:this.revision,selection:this.selection?{...this.selection}:null}};
      return structuredClone(this.latest);
    }
    retry() { return structuredClone(this.latest); }
    isStale(request) { return this.revision!==request.code_context.revision; }
    accepts(response) { return response?.request_id===this.latest?.request_id&&response?.context?.code_context?.revision===this.latest?.code_context.revision; }
  }
  const element=(tag,text,cls)=>{const el=document.createElement(tag);if(text)el.textContent=text;if(cls)el.className=cls;return el;};
  const sources={model:'Локальная модель · пояснение не проверено',catalogue:'Подсказка из подготовленного каталога',template:'Резервный ответ · модель не ответила',policy:'Ответ поддержки и безопасности'};
  const reasons={disabled:'Модель выключена.',cold:'Модель ещё не готова.',timeout:'Модель не уложилась во время.',transport:'Связь с моделью прервалась.',quarantined:'Проверяем завершение предыдущего запроса.',invalid_output:'Ответ модели не прошёл проверку формата.',queue_full:'Помощник занят.',queue_budget:'Не хватило времени в очереди.'};
  function attach(form,ids,info,api) {
    const editor=form.querySelector('textarea[name="answer"]');
    if(!editor||form.dataset.aiAttached)return;form.dataset.aiAttached='true';
    const panel=element('section',null,'ai-panel');panel.setAttribute('aria-label','Помощник по коду');
    if(!info?.supported){panel.append(element('p','Помощник пока не подключён к этому заданию.'));form.after(panel);return;}
    editor.setAttribute('aria-label','Код задания');editor.spellcheck=false;editor.classList.add('ai-code');editor.rows=8;
    if(!editor.value&&info.initial_code)editor.value=info.initial_code;
    const session=new EditorSession(ids);session.edit(editor.value);
    panel.append(element('h3','Спросить о коде'),element('p','Код выше прикладывается автоматически. Выдели нужные строки, если вопрос только о них.','subtle'));
    const context=element('p',null,'ai-context'),preview=element('pre',null,'ai-selection'),clear=element('button','Снять выделение','button secondary');clear.type='button';
    const question=element('textarea');question.rows=2;question.maxLength=1900;question.placeholder='Что непонятно?';question.setAttribute('aria-label','Вопрос помощнику');
    const buttons=element('div',null,'ai-actions'),ask=element('button','Объясни','button primary'),hint=element('button','Дай подсказку','button secondary'),retry=element('button','Повторить этот запрос','button secondary');
    for(const b of [ask,hint,retry])b.type='button';hint.hidden=!info.hint_supported;retry.hidden=true;buttons.append(ask,hint,retry);
    const state=element('p',null,'ai-state'),output=element('div',null,'ai-answer');state.setAttribute('role','status');output.setAttribute('aria-live','polite');
    panel.append(context,preview,clear,question,buttons,state,output,element('p','ИИ может ошибаться. Код не запускается помощником.','small-note'));form.after(panel);
    let displayed=null;
    function describe(){
      const sel=session.selection;
      context.textContent=sel?`Вопрос о выделении · ${sel.end-sel.start} символов. Весь код тоже приложен.`:`Прикреплён весь код · ${session.code.length} / 4000 символов.`;
      preview.hidden=!sel;clear.hidden=!sel;preview.textContent=sel?session.code.slice(sel.start,sel.end):'';
      if(displayed&&session.isStale(displayed))state.textContent='Код изменился. Ответ относится к предыдущему снимку.';
    }
    editor.addEventListener('input',()=>{session.edit(editor.value);describe();});
    const capture=()=>{session.edit(editor.value);session.select(editor.selectionStart,editor.selectionEnd);describe();};
    for(const name of ['select','mouseup','keyup'])editor.addEventListener(name,capture);
    clear.addEventListener('click',()=>{session.select(0,0);editor.setSelectionRange(editor.selectionEnd,editor.selectionEnd);describe();});
    async function send(body){
      if(!body)return;ask.disabled=hint.disabled=retry.disabled=true;retry.hidden=true;state.textContent='Готовим ответ…';
      try{
        const answer=await api.tutorAsk(body);
        if(!panel.isConnected||!session.accepts(answer))return;
        displayed=body;output.replaceChildren();
        output.append(element('strong',sources[answer.answer.source]||'Неизвестный источник'));
        if(answer.outcome==='fallback')output.append(element('p',reasons[answer.reason]||'Использован резервный ответ.'));
        if(answer.answer.facts?.length){output.append(element('h4','Факты по коду'));const list=element('ul');for(const fact of answer.answer.facts)list.append(element('li',fact.text));output.append(list,element('p','Реестр фактов ещё не проверен преподавателем.','small-note'));}
        output.append(element('p',answer.answer.text,'preserve-lines'));
        const focus=answer.context.code_context?.selection;
        state.textContent=session.isStale(body)?'Код изменился. Ответ относится к предыдущему снимку.':focus?`Ответ по строкам ${focus.start_line}–${focus.end_line} сохранённого снимка.`:'Ответ по прикреплённому снимку кода.';
      }catch(error){if(panel.isConnected){state.textContent=error.message||'Не удалось получить ответ.';retry.hidden=Boolean(error.status);}}
      finally{if(panel.isConnected)ask.disabled=hint.disabled=retry.disabled=false;}
    }
    function begin(action){try{session.edit(editor.value);send(session.begin(action,question.value,global.LATLearning?.settings().answer_detail));}catch(error){state.textContent=error.message;}}
    ask.addEventListener('click',()=>begin('explain'));
    hint.addEventListener('click',()=>{if(!question.value.trim())question.value='Подскажи следующий шаг, не решая за меня.';begin('hint');});
    retry.addEventListener('click',()=>send(session.retry()));
    describe();
  }
  async function mount(root,courseId,lessonId,api){
    const forms=[...root.querySelectorAll('form[data-form="answer"]')];
    try{
      const data=await api.tutorContext(courseId,lessonId);
      if(!root.isConnected||!forms.every(form=>root.contains(form)))return;
      for(const form of forms){const id=Number(form.dataset.exercise);attach(form,{course_id:courseId,lesson_id:lessonId,exercise_id:id},data.exercises.find(x=>x.exercise_id===id),api);}
    }catch{for(const form of forms)if(form.isConnected)form.after(element('p','Помощник недоступен: не удалось получить учебный контекст.','ai-state'));}
  }
  global.LATTutor=Object.freeze({EditorSession,mount});
})(window);
