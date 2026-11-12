const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

test('document study client preserves generation and grading request identities', async () => {
  const calls = [];
  const window = {};
  vm.runInNewContext(fs.readFileSync('assets/data.js', 'utf8'), {
    window, URL, Headers, FormData, AbortController, setTimeout, clearTimeout,
    fetch: async (url, { method, body }) => {
      calls.push([new URL(url).pathname, method, body && JSON.parse(body)]);
      return { ok: true, text: async () => '[]' };
    }
  });
  const lat = window.LAT;
  const request_id = '00000000-0000-4000-8000-000000000002';
  const pack = 27;
  const generation = { request_id, mode: 'course', source_start: 7, source_end: 107 };
  const attempt = { request_id, question_id: 'q2', choice: 0 };
  await lat.documentDetail(11);
  await lat.generateStudyPack(11, generation);
  await lat.studyPacks();
  await lat.studyPack(pack);
  await lat.studyHint(pack, 'q2');
  await lat.studyAttempt(pack, attempt);
  assert.deepEqual(calls, [
    ['/api/v1/documents/11/', 'GET', undefined],
    ['/api/v1/documents/11/generate/', 'POST', generation],
    ['/api/v1/documents/packs/', 'GET', undefined],
    [`/api/v1/documents/packs/${pack}/`, 'GET', undefined],
    [`/api/v1/documents/packs/${pack}/hints/`, 'POST', { question_id: 'q2' }],
    [`/api/v1/documents/packs/${pack}/attempts/`, 'POST', attempt]
  ]);
  await assert.rejects(lat.studyPack('../other'), /идентификатор/i);
});



const appSource = fs.readFileSync('assets/app.js', 'utf8');
test('lesson submission keeps the mounted page, editor and neighboring drafts intact', async () => {
  const feedback = {innerHTML:''};
  let lessonReads = 0;
  const form = fakeForm('answer');
  form.dataset.exercise = '3'; form.dataset.maxScore = '10';
  form.values = {answer:'My preserved answer'};
  const app = mountApp('/lesson/1/2', {'[data-answer-result="3"]':feedback}, {
    lessons:async()=>{lessonReads++;return [{id:2,title:'Урок',content:'Текст'}];},
    exercises:async()=>[{id:3,title:'Задание',max_score:10}], attempts:async()=>[],
    submitAttempt:async()=>({status:'auto_checked',score:5,feedback:'Нужно уточнить: Условие.'})
  });
  await turn(); const html = app.main.innerHTML;
  await app.submit(form);
  assert.equal(lessonReads,1); assert.equal(app.main.innerHTML,html);
  assert.equal(form.values.answer,'My preserved answer');
  assert.match(feedback.innerHTML,/Частично верно/); assert.match(feedback.innerHTML,/5 из 10/);
  assert.match(app.app.innerHTML,/ИИ может ошибаться/);
});

test('history shows latest attempts first and retains earlier attempts in collapsed groups', async () => {
  const app = mountApp('/progress',{}, {
    attempts:async()=>[
      {id:1,exercise:3,submitted_at:'2026-11-11T00:00:00Z',answer:'OLD_ANSWER'},
      {id:2,exercise:3,submitted_at:'2026-11-12T00:00:00Z',answer:'LATEST_ANSWER'},
      {id:3,exercise:4,submitted_at:'2026-11-12T01:00:00Z',answer:'OTHER_TASK'}],
    dashboard:async()=>({courses:[],total_courses:0})
  });
  await turn(); const html=app.main.innerHTML;
  assert.ok(html.indexOf('LATEST_ANSWER')<html.indexOf('OLD_ANSWER'));
  assert.match(html,/<details class="attempt-history"><summary>Предыдущие попытки: 1/);
  assert.equal((html.match(/OLD_ANSWER/g)||[]).length,1);
});

test('lecture typography structures prose, preserves code, and escapes untrusted markup', async () => {
  const long='Это достаточно длинное предложение учебного материала, которое нужно прочитать внимательно. '.repeat(8);
  const app=mountApp('/lesson/1/2',{}, {
    lessons:async()=>[{id:2,title:'Урок',content:`# Заголовок\n\n${long}\n\n- Один\n- Два\n\n\x60\x60\x60python\nprint('<img>')\n\x60\x60\x60`}],
    exercises:async()=>[],attempts:async()=>[]
  });
  await turn(); const html=app.main.innerHTML;
  assert.match(html,/<h3>Заголовок<\/h3>/); assert.match(html,/<ul><li>Один<\/li><li>Два/);
  assert.match(html,/<pre><code>print\(&#39;&lt;img&gt;&#39;\)/);
  assert.doesNotMatch(html,/<img>/);
  assert.equal((html.match(/Это достаточно/g)||[]).length,8);
});
const turn = () => new Promise(resolve => setImmediate(resolve));
function mountApp(route, nodes, api, schedule = setTimeout) {
  const handlers = {};
  const storage = new Map();
  const location = { hash: '#' + route };
  const main = { innerHTML: '', focus() {} };
  const app = { innerHTML: '' };
  const dialog = { addEventListener() {} };
  const document = {
    addEventListener: (name, handler) => { handlers[name] = handler; },
    querySelector: selector => ({ '#app': app, '#main': main, '#modal': dialog, ...nodes })[selector] || null
  };
  vm.runInNewContext(appSource, {
    window: { LAT: { me: async () => ({ id: 1 }), settings: () => ({ baseUrl: 'http://localhost/api/v1' }), ...api }, addEventListener() {} },
    document, location, crypto: require('node:crypto').webcrypto, setTimeout: schedule,
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.values[name] ?? null; } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  });
  function submit(form) {
    return handlers.submit({ target: { closest: selector => selector === 'form[data-form]' ? form : null }, preventDefault() {} });
  }
  const click = control => handlers.click({ target: { closest: selector => selector === '[data-action]' ? control : null }, preventDefault() {} });
  return { app, main, location, submit, click };
}
function fakeForm(type, nodes = {}) {
  const button = { disabled: false, setAttribute() {}, removeAttribute() {} };
  const error = { textContent: '' };
  return {
    dataset: { form: type },
    isConnected: true,
    addEventListener() {},
    querySelector: selector => ({ '[type="submit"]': button, '.form-error': error, ...nodes })[selector],
    error
  };
}

test('excerpt preview and retries use code points and preserve the UUID after a lost response', async () => {
  const calls = [];
  const source = '<img>🧬' + 'я'.repeat(100) + '\r\n' + '🧬';
  const preview = {};
  const excerpt = {};
  const form = fakeForm('generate-study', { '#study-range-status': {}, '#study-excerpt': excerpt });
  Object.assign(form.dataset, { id: '11' });
  form.elements = { first: { valueAsNumber: 6 }, last: { valueAsNumber: 105 } };
  form.values = { mode: 'test' };
  const app = mountApp('/documents/11', { '#study-source': preview, '[data-form="generate-study"]': form }, {
    documentDetail: async () => ({ id: 11, title: '<script>', status: 'ready', extracted_text: source }),
    generateStudyPack: async (id, body) => {
      calls.push({ id, body });
      if (calls.length === 1) throw new Error('Lost response');
      return { id: 27 };
    }
  });
  await turn();
  assert.match(app.main.innerHTML, /&lt;script&gt;/);
  assert.equal(preview.textContent, source);
  assert.equal(excerpt.textContent, '🧬' + 'я'.repeat(99));
  await app.submit(form);
  assert.match(form.error.textContent, /Статус отправки неизвестен/);
  assert.equal(app.location.hash, '#/documents/11');
  await app.submit(form);
  assert.equal(calls[0].id, 11);
  assert.equal(calls[0].body.source_start, 5);
  assert.equal(calls[0].body.source_end, 105);
  assert.equal(calls[0].body.request_id, calls[1].body.request_id);
  assert.equal(calls[0].body.generation_options.question_count, 6);
  assert.equal(calls[0].body.generation_options.detail, 'concise');
  form.values.question_count = '7';
  form.values.detail = 'detailed';
  await app.submit(form);
  assert.equal(calls[2].body.generation_options.question_count, 7);
  assert.equal(calls[2].body.generation_options.detail, 'detailed');
  assert.notEqual(calls[2].body.request_id, calls[0].body.request_id);
  assert.equal(app.location.hash, '/study/27');
});

test('study view escapes model text and uncertain grading never renders a score', async () => {
  const progress = { answered: 0, total: 1, score: 0, max_score: 1, percent: 0, completed: false };
  const packData = {
    id: 27, status: 'ready', title: '<img src=x>', mode: 'course', source_start: 0, source_end: 100, source_excerpt: '<script>SOURCE_EXCERPT</script>', progress,
    lessons: [{ title: '<script>', content: '<img src=x>', source_quote: '<em>quote</em>' }],
    questions: [{ id: 'q1', prompt: '<em>prompt</em>', options: ['<b>one</b>', 'two', 'three', 'four'], correct_index: 0, source_quote: 'UNSUBMITTED_QUOTE' }]
  };
  const calls = [];
  const aggregate = {};
  const pack = { dataset: { id: '27', status: 'ready' }, querySelectorAll: () => [], querySelector: () => aggregate };
  const feedback = { innerHTML: '' };
  const submittedInput = { dataset: {} };
  const form = fakeForm('study-answer', { '.study-feedback': feedback, '.study-option input[value="0"]': submittedInput });
  form.dataset.question = 'q1';
  form.values = { choice: '0' };
  form.closest = () => pack;
  const app = mountApp('/study/27', { '#study-pack': pack }, {
    studyPack: async () => packData,
    studyAttempt: async (id, body) => {
      calls.push({ id, body });
      if (calls.length === 1) return { correct: null, score: null };
      return { correct: false, score: 0, max_score: 1, feedback: '<img src=x>', source_quote: '<em>quote</em>', progress };
    }
  });
  await turn();
  assert.match(app.main.innerHTML, /&lt;em&gt;prompt&lt;\/em&gt;/);
  assert.match(app.main.innerHTML, /&lt;script&gt;SOURCE_EXCERPT&lt;\/script&gt;/);
  assert.match(app.main.innerHTML, /&lt;b&gt;one&lt;\/b&gt;/);
  assert.doesNotMatch(app.main.innerHTML, /<img|<script|UNSUBMITTED_QUOTE|correct_index/);
  await app.submit(form);
  assert.match(form.error.textContent, /Проверка ответа не подтверждена/);
  assert.equal(feedback.innerHTML, '');
  assert.equal(submittedInput.dataset.result, undefined);
  await app.submit(form);
  assert.equal(calls[0].body.choice, 0);
  assert.equal(calls[0].body.request_id, calls[1].body.request_id);
  assert.match(feedback.innerHTML, /Неверно/);
  assert.equal(submittedInput.dataset.result, 'incorrect');
  assert.match(feedback.innerHTML, /&lt;img src=x&gt;/);
  assert.match(feedback.innerHTML, /&lt;em&gt;quote&lt;\/em&gt;/);
  assert.doesNotMatch(feedback.innerHTML, /<img|<em>/);
});

test('opening a saved job polls by GET and shows the material once ready', async () => {
  const ticks = [];
  const errors = { textContent: '' };
  const target = {
    dataset: { id: '27', status: 'running' },
    parentElement: { querySelector: () => errors },
    isConnected: true
  };
  const reads = [];
  const pack = { id: 27, title: 'Готовый материал', mode: 'test', source_start: 0, source_end: 100 };
  const app = mountApp('/study/27', { '#study-pack': target }, {
    studyPack: async id => {
      reads.push(id);
      if (reads.length === 1) return { ...pack, title: '', status: 'running' };
      return {
        ...pack, status: 'ready', lessons: [], questions: [],
        progress: { answered: 0, total: 0, score: 0, max_score: 0, percent: 0, completed: false }
      };
    }
  }, callback => ticks.push(callback));
  await turn();
  assert.match(app.main.innerHTML, /Запрос|создаёт/);
  assert.equal(ticks.length, 1);
  await ticks.shift()();
  assert.deepEqual(reads, [27, 27]);
  assert.match(target.innerHTML, /Готовый материал/);
  assert.equal(target.dataset.status, 'ready');
  assert.equal(ticks.length, 0);
});

async function gradeFixture(result) {
  const progress = { answered: 1, total: 1, score: result.score, max_score: 1, percent: 0, completed: true };
  const pack = { dataset: { id: '27', status: 'ready' }, querySelectorAll: () => [], querySelector: () => ({}) };
  const feedback = { innerHTML: '' };
  const answer = { textContent: '<b>GROUP BY</b>' };
  const submittedInput = { dataset: {} };
  const otherInput = { dataset: {} };
  const form = fakeForm('study-answer', {
    '.study-feedback': feedback,
    '.study-option input[value="1"] + span': answer,
    '.study-option input[value="1"]': submittedInput,
    '.study-option input[value="2"]': otherInput
  });
  form.dataset.question = 'q1';
  form.values = { choice: '1' };
  form.closest = () => pack;
  const app = mountApp('/study/27', { '#study-pack': pack }, {
    studyPack: async () => ({ id: 27, status: 'ready', source_start: 0, source_end: 100, questions: [], lessons: [], progress }),
    studyAttempt: async () => {
      // A changed selection while the request is pending must not relabel its receipt.
      answer.textContent = 'A DIFFERENT SELECTION';
      form.values.choice = '2';
      return { max_score: 1, progress, ...result };
    }
  });
  await turn();
  await app.submit(form);
  assert.equal(form.error.textContent, '');
  assert.equal(submittedInput.dataset.result, result.correct ? 'correct' : 'incorrect');
  assert.equal(otherInput.dataset.result, undefined);
  return feedback.innerHTML;
}

test('wrong MCQ receipt distinguishes selected and correct options with a collapsed source', async () => {
  const html = await gradeFixture({ correct: false, score: 0, feedback: 'GROUP BY groups rows; WHERE filters rows.', correct_option: '<i>WHERE</i>', source_quote: '<q>WHERE filters rows.</q>' });
  assert.match(html, /study-result-incorrect/);
  assert.match(html, /Неверно/);
  assert.match(html, /0 из 1 баллов/);
  assert.match(html, /Твой ответ[\s\S]*&lt;b&gt;GROUP BY&lt;\/b&gt;/);
  assert.match(html, /Верный ответ[\s\S]*&lt;i&gt;WHERE&lt;\/i&gt;/);
  assert.match(html, /GROUP BY groups rows; WHERE filters rows\./);
  assert.match(html, /<details class="study-citation"><summary>/);
  assert.doesNotMatch(html, /<details[^>]*open|<i>|<b>|<q>|A DIFFERENT SELECTION/);
});

test('historical quote-only feedback appears once without fabricating an explanation or answer', async () => {
  const html = await gradeFixture({ correct: true, score: 1, feedback: 'WHERE filters rows.', source_quote: 'WHERE filters rows.' });
  assert.match(html, /study-result-correct/);
  assert.match(html, /Верно/);
  assert.equal(html.split('WHERE filters rows.').length - 1, 1);
  assert.doesNotMatch(html, /Верный ответ|Разбор ответа|undefined/);
});

test('assessment criteria render as escaped lists on lesson and history without inventing reasons', async () => {
  const feedback = 'Автоматическая оценка ИИ. Зачтено: Использован <code>for</code>. Нужно уточнить: Проверка <script>x</script>. Зачтено: Выведен результат.';
  const attempts = [{ id: 1, exercise: 3, exercise_title: 'Python', score: 6.7, max_score: 10, status: 'auto_checked', submitted_at: '2026-11-11', answer: '<code>answer</code>', feedback }];
  for (const route of ['/lesson/1/2', '/progress']) {
    const app = mountApp(route, {}, {
      lessons: async () => [{ id: 2, title: 'Python', content: 'Урок' }],
      exercises: async () => [{ id: 3, title: 'Циклы', description: 'Описание', max_score: 10 }],
      attempts: async () => attempts,
      dashboard: async () => ({ courses: [], total_courses: 0 })
    });
    await turn();
    const html = app.main.innerHTML;
    assert.match(html, /assessment-feedback/);
    assert.match(html, /Зачтено<\/h[234]>\s*<ul><li>Использован &lt;code&gt;for&lt;\/code&gt;\.<\/li><li>Выведен результат\.<\/li><\/ul>/);
    assert.match(html, /Нужно уточнить<\/h[234]>\s*<ul><li>Проверка &lt;script&gt;x&lt;\/script&gt;\.<\/li><\/ul>/);
    assert.match(html, /6,7/);
    assert.doesNotMatch(html, /<code>|<script>|Причина|Доказательство/);
  }
});

test('unstructured assessment comments remain readable and unscored failures remain unscored', async () => {
  const app = mountApp('/progress', {}, {
    attempts: async () => [{ exercise: 3, status: 'assessment_failed', score: null, feedback: '<b>Недоступно</b>\nПовтори позже.', answer: 'x' }],
    dashboard: async () => ({ courses: [], total_courses: 0 })
  });
  await turn();
  assert.match(app.main.innerHTML, /class="preserve-lines">&lt;b&gt;Недоступно&lt;\/b&gt;\nПовтори позже\./);
  assert.doesNotMatch(app.main.innerHTML, /assessment-positive|assessment-needs-work|0 балл|<b>/);
});

test('hint callout labels and escapes the supplied hint without rewriting it', async () => {
  const output = { hidden: true, innerHTML: '' };
  const form = fakeForm('study-answer', { '.study-hint': output });
  form.dataset.question = 'q1';
  form.closest = () => ({ dataset: { id: '27' } });
  const control = { dataset: { action: 'study-hint' }, form, disabled: false, closest: () => null };
  let calls = 0;
  const app = mountApp('/about', {}, {
    studyHint: async (id, question) => {
      assert.equal(id, 27);
      assert.equal(question, 'q1');
      calls++;
      return { hint: 'Какая операция отбирает строки до группировки? <img src=x>' };
    }
  });
  await turn();
  await app.click(control);
  assert.equal(output.hidden, false);
  assert.equal(control.disabled, false);
  assert.match(output.innerHTML, /<strong>Подсказка<\/strong>/);
  assert.match(output.innerHTML, /Какая операция отбирает строки до группировки\? &lt;img src=x&gt;/);
  assert.doesNotMatch(output.innerHTML, /<img/);
  await app.click(control);
  assert.equal(calls, 1);
});
