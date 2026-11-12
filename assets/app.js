/* LAT AI — frontend for the supplied Django REST API. No mock user data. */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icons = {
    home:'m3 10 9-8 9 8v11h-6v-8H9v8H3V10Z', arrow:'M5 12h14m-6-6 6 6-6 6', book:'M12 6v15m0-15C8 3 4 3 2 4v15c4-1 7 0 10 2 3-2 6-3 10-2V4c-2-1-6-1-10 2Z',
    grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', file:'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8M8 17h6',
    chart:'M4 20V10m8 10V4m8 16v-7', search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z', upload:'M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5',
    check:'m5 12 4 4L19 6', close:'m6 6 12 12M6 18 18 6', user:'M20 21v-2a8 8 0 0 0-16 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    lock:'M5 10h14v12H5zM8 10V6a4 4 0 0 1 8 0v4', spark:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z', menu:'M4 6h16M4 12h16M4 18h16',
    globe:'M2 12h20M12 2c6 5 6 15 0 20-6-5-6-15 0-20Zm10 10a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z', code:'m8 5-7 7 7 7m8-14 7 7-7 7m-3-16-2 18',
    trash:'M3 6h18M5 6l1 16h12l1-16M9 6V2h6v4m-5 4v8m4-8v8', clock:'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    settings:'M4 7h16M4 17h16M8 4v6m8 4v6', exit:'M9 3H3v18h6m5-14 5 5-5 5m-6-5h13', cap:'m2 8 10-5 10 5-10 5L2 8Zm4 3v7c4 3 8 3 12 0v-7M22 8v9'
  };
  const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.book}"/></svg>`;
  const logo = () => `<a class="friendly-brand" href="#/" aria-label="LAT AI — главная"><svg viewBox="0 0 48 40" aria-hidden="true"><rect x="1" y="29" width="18" height="10" rx="4" fill="#AFCBA4"/><rect x="15" y="16" width="18" height="23" rx="5" fill="#98BA8E"/><rect x="29" y="3" width="18" height="36" rx="5" fill="#80A577"/></svg><span><strong>LAT AI</strong></span></a>`;

  const button = (label, href, cls = 'primary') => `<a class="button ${cls}" href="${href}">${label}${icon('arrow')}</a>`;
  let user = null, renderId = 0, coursesCache = [], currentCourse = null, currentLesson = null, currentExercises = [];
  let catalogQuery = '', catalogSubject = '', toastTimer;
  const api = () => window.LAT;
  const format = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 1}).format(Number(value)) : '—';
  const date = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString('ru-RU') : '—';
  const pct = value => Math.min(100, Math.max(0, Number(value) || 0));
  const bar = value => `<span class="progress-track" role="progressbar" aria-label="Пройдено" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct(value)}"><span style="width:${pct(value)}%"></span></span>`;
  const status = value => `<span class="badge ${value === 'checked' || value === 'auto_checked' || value === 'ready' ? 'success' : (value === 'failed' || value === 'assessment_failed') ? 'danger' : 'neutral'}">${escape(({submitted:'На проверке', checked:'Проверено человеком', auto_checked:'Проверено ИИ', assessment_failed:'Автопроверка не завершена', uploaded:'Загружен', processing:'Обрабатывается', ready:'Готов', failed:'Ошибка обработки'})[value] || value)}</span>`;
  function assessmentFeedback(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const plain = () => `<p class="preserve-lines">${escape(text)}</p>`;
    const markers = [...text.matchAll(/(?:^|\s)(Зачтено:|Нужно уточнить:)\s*/g)];
    if (!markers.length) return plain();
    const groups = { 'Зачтено:': [], 'Нужно уточнить:': [] };
    for (let i = 0; i < markers.length; i++) {
      const criterion = text.slice(markers[i].index + markers[i][0].length, markers[i + 1]?.index ?? text.length).trim();
      // Keep unusual or incomplete comments intact rather than inventing a criterion.
      if (!criterion) return plain();
      groups[markers[i][1]].push(criterion);
    }
    const intro = text.slice(0, markers[0].index).trim();
    return `<div class="assessment-feedback">${intro ? `<p class="preserve-lines">${escape(intro)}</p>` : ''}${Object.entries(groups).filter(([,items]) => items.length).map(([label,items]) => `<section class="assessment-group ${label === 'Зачтено:' ? 'assessment-positive' : 'assessment-needs-work'}"><h4>${label.slice(0,-1)}</h4><ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>`).join('')}</div>`;
  }
  function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
  function header(route) {
    const links = [['/','Главная','home'],['/courses','Курсы','book'],['/documents','Документы','file'],['/progress','Прогресс','chart']];
    const active = route === '/dashboard' ? '/' : route.startsWith('/course/') || route.startsWith('/lesson/') ? '/courses' : route.startsWith('/study/') || route.startsWith('/documents/') ? '/documents' : route;
    return `<aside class="friendly-sidebar">${logo()}<nav class="friendly-nav" aria-label="Основная навигация">${links.map(([url,title,symbol]) => `<a href="#${url}" ${active === url ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${title}</span></a>`).join('')}</nav><span class="friendly-sidebar-credit">LAT AI · LEARN AND TALK</span></aside><header class="friendly-topbar"><button class="icon-button mobile-menu" data-action="menu" aria-label="Открыть меню" aria-expanded="false">${icon('menu')}</button><div class="friendly-account">${user ? `<button class="profile-button" data-action="profile"><span class="avatar">${escape((user.display_name || user.email || 'У').slice(0,1).toUpperCase())}</span><span class="profile-name">${escape(user.display_name || 'Профиль')}</span><span class="account-chevron" aria-hidden="true">⌄</span></button>` : `<button class="profile-button guest-account" data-action="login"><span class="avatar">${icon('user')}</span><span class="profile-name">Войти</span><span class="account-chevron" aria-hidden="true">⌄</span></button><button class="link-button guest-register" data-action="register">Регистрация</button><button class="icon-button appearance-shortcut" data-action="profile" aria-label="Настройки профиля">${icon('settings')}</button>`}</div></header>`;
  }
  function footer() { return `<footer class="friendly-footer"><div><a href="#/about">О платформе</a></div></footer>`; }

  function pageHead(kicker, title, subtitle = '', action = '') { return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${action}</div>`; }
  const empty = (title, body, action = '') => `<div class="empty-state">${icon('book')}<h3>${title}</h3><p>${body}</p>${action}</div>`;
  function errorView(error) { return `<div class="connection-state">${icon('globe')}<div><h2>${error.status === 401 ? 'Войдите в свой аккаунт' : 'Не удалось получить данные'}</h2><p>${escape(error.message || 'Проверьте подключение к серверу и попробуйте ещё раз.')}</p><div class="button-row"><button class="button primary" data-action="${error.status === 401 ? 'login' : 'retry'}">${error.status === 401 ? 'Войти' : 'Попробовать снова'}</button><button class="button secondary" data-action="settings">Проверить подключение</button></div></div></div>`; }
  function requireLogin(title) { return `<section class="container section">${pageHead('ЛИЧНОЕ ПРОСТРАНСТВО', title)}<div class="auth-gate"><div class="gate-icon">${icon('lock')}</div><h2>Всё начинается с первого шага</h2><p>Войдите, чтобы открыть курсы, выполнять задания<br>и сохранять свой прогресс на платформе.</p><div class="button-row"><button class="button primary" data-action="login">Войти в аккаунт ${icon('arrow')}</button><button class="button secondary" data-action="register">Зарегистрироваться</button></div><span class="subtle">Обучение бесплатное — никаких подписок.</span></div></section>`; }
  const homeCourseIcon = (course, i) => /геометр/i.test(course.course_title || '') ? '△' : /алгебр|математ/i.test(course.course_title || '') ? 'x²' : icon(i % 2 ? 'code' : 'book');
  function homeCourseCard(course, i) {
    return `<article class="friendly-course-card"><span class="friendly-course-icon">${homeCourseIcon(course,i)}</span><div class="friendly-course-copy"><h3><a href="#/course/${Number(course.course_id)}">${escape(course.course_title)}</a></h3><p>${format(course.completed_lessons)} из ${format(course.total_lessons)} уроков</p><div class="friendly-meter">${bar(course.completion_percent)}<span>${format(course.completion_percent)}%</span></div></div><a class="button primary friendly-course-open" href="#/course/${Number(course.course_id)}">Открыть курс</a></article>`;
  }
  function homeGuestCourses() {
    return `<article class="friendly-course-card friendly-placeholder"><span class="friendly-course-icon">x²</span><div class="friendly-course-copy"><h3>Ваши курсы</h3><p>Войдите, чтобы начать обучение</p><div class="friendly-meter"><span class="progress-track" aria-hidden="true"></span><span>—</span></div></div><button class="button primary friendly-course-open" data-action="login">Войти</button></article><article class="friendly-course-card friendly-placeholder"><span class="friendly-course-icon">△</span><div class="friendly-course-copy"><h3>Ваш прогресс</h3><p>Здесь появятся результаты уроков</p><div class="friendly-meter"><span class="progress-track" aria-hidden="true"></span><span>—</span></div></div></article>`;
  }
  function homeAnswers(attempts) {
    return attempts.length ? attempts.slice(0,2).map(a=>`<a href="#/progress" class="friendly-answer-row"><span class="friendly-answer-icon">${icon('file')}</span><strong class="friendly-answer-title">${escape(a.exercise_title || 'Задание №' + a.exercise)}</strong>${status(a.status)}<span class="friendly-answer-score">${a.score == null ? '' : a.max_score != null ? format(a.score)+' / '+format(a.max_score) : format(a.score)+' балл.'}</span></a>`).join('') : `<div class="friendly-answer-row friendly-empty"><span class="friendly-answer-icon">${icon('file')}</span><span>${user ? 'Пока нет отправленных ответов' : 'Войдите, чтобы увидеть свои ответы'}</span></div><div class="friendly-answer-row friendly-empty"><span class="friendly-answer-icon">${icon('check')}</span><span>Здесь будут оценки и комментарии</span></div>`;
  }
  async function home() {
    let stats = null, docs = [], attempts = [], failures = {};
    if (user) {
      const results = await Promise.allSettled([api().dashboard(),api().documents(),api().attempts()]);
      if(results[0].status==='fulfilled')stats=results[0].value;else failures.courses=results[0].reason;
      if(results[1].status==='fulfilled')docs=results[1].value;else failures.documents=results[1].reason;
      if(results[2].status==='fulfilled')attempts=results[2].value;else failures.attempts=results[2].reason;
    }
    const inlineError = (error) => `<div class="friendly-error"><p>${escape(error.message)}</p><button class="link-button" data-action="${error.status===401?'login':'retry'}">${error.status===401?'Войти снова':'Повторить'}</button></div>`;
    return `<section class="friendly-home"><section class="friendly-welcome"><div class="friendly-welcome-copy"><h1>${user && user.display_name ? 'Привет, '+escape(user.display_name)+'!' : 'Привет!'}</h1><p>Продолжим учиться?</p></div><img class="friendly-welcome-art" src="assets/study-illustration.png" alt="Открытая тетрадь, карандаш и геометрические фигуры"></section><div class="friendly-middle"><section class="friendly-courses"><h2>Курсы</h2><div class="friendly-course-stack">${failures.courses ? inlineError(failures.courses) : !user ? homeGuestCourses() : stats.courses.length ? stats.courses.map(homeCourseCard).join('') : '<div class="friendly-course-card friendly-empty">Опубликованные курсы появятся здесь.</div>'}</div></section><section class="friendly-docs"><h2>Мои документы</h2><p class="friendly-file-hint">Создавай мини-курсы и тесты по своим материалам.</p><div class="friendly-doc-list">${failures.documents ? inlineError(failures.documents) : docs.length ? docs.slice(0,1).map(d=>`<a class="friendly-doc-row" href="${documentLink(d)}"><span class="friendly-document-icon">${icon('file')}<small>${escape((d.title.split('.').pop() || 'FILE').slice(0,4).toUpperCase())}</small></span><span class="friendly-doc-name">${escape(d.title)}</span>${status(d.status)}</a>`).join('') : `<div class="friendly-doc-row friendly-empty"><span class="friendly-document-icon">${icon('file')}</span><span>${user?'Пока нет документов':'Ваши материалы появятся после входа'}</span></div>`}</div><button class="button primary friendly-upload" data-action="home-upload">${icon('upload')} Загрузить файл</button><input class="sr-only" id="home-upload" type="file" accept=".pdf,.docx,.pptx,.txt" tabindex="-1" aria-label="Выбрать учебный файл"><p class="friendly-file-hint">PDF, DOCX, PPTX, TXT · до 20 МБ</p><p class="home-upload-error form-error" role="alert"></p></section></div><div class="friendly-bottom"><section class="friendly-answers"><h2>Мои ответы</h2>${failures.attempts ? inlineError(failures.attempts) : homeAnswers(attempts)}</section><a href="#/tutor" class="friendly-tutor"><span class="friendly-tutor-icon">${icon('cap')}</span><div><h2>ИИ-репетитор</h2><span class="badge neutral">Проверка</span></div><span class="friendly-tutor-decoration" aria-hidden="true"></span></a></div></section>`;
  }

  function about() { return `<section class="container section about-page">${pageHead('LEARN AND TALK', 'Знания не должны<br>иметь барьеров.', 'LAT AI — образовательный стартап для школьников и студентов.')}<div class="about-grid"><div class="large-statement">Бесплатно.<br>Понятно.<br><span>Для твоего будущего.</span></div><div class="prose"><h2>Учиться тому, что интересно</h2><p>Мы создаём платформу, где можно изучать разные дисциплины, развиваться в выбранных сферах и находить новые интересы без платной подписки.</p><h2>От материала к практике</h2><p>Выбери опубликованный курс, открой урок, изучи материал и отправь ответ на задание. После проверки в кабинете появятся оценка и комментарий.</p><h2>Свои материалы под рукой</h2><p>Загружай PDF, DOCX, PPTX и TXT. Выбери фрагмент текста, чтобы создать личный мини-курс или тест.</p><h2>Помощь по Python</h2><p>Задавай вопросы ИИ-репетитору из подключённых заданий по Python.</p>${button('Открыть каталог', '#/courses')}</div></div></section>`; }
  function courseCard(course, index = 0) { return `<a class="course-card" href="#/course/${Number(course.id)}"><div class="course-card-top"><span class="course-symbol">${icon(index % 3 === 0 ? 'book' : index % 3 === 1 ? 'code' : 'globe')}</span><span class="badge success">Бесплатно</span></div><span class="course-subject">${escape(course.subject || 'Учебный курс')}</span><h3>${escape(course.title)}</h3><p>${escape(course.description || 'Изучите материалы курса и закрепите знания на практике.')}</p><div class="course-bottom"><span>${icon('book')} ${format(course.lessons_count)} уроков</span><span class="course-arrow">${icon('arrow')}</span></div></a>`; }
  function filterCourses() { const list = coursesCache.filter(c => (!catalogSubject || c.subject === catalogSubject) && `${c.title} ${c.description} ${c.subject}`.toLocaleLowerCase('ru').includes(catalogQuery.toLocaleLowerCase('ru'))); $('#course-results').innerHTML = list.length ? list.map(courseCard).join('') : empty('Ничего не найдено', 'Попробуйте другой запрос или выберите все дисциплины.'); $('#result-count').textContent = `Найдено курсов: ${list.length}`; }
  async function catalog() { if (!user) return requireLogin('Каталог курсов'); coursesCache = await api().courses(); const subjects = [...new Set(coursesCache.map(c => c.subject).filter(Boolean))]; return `<section class="container section">${pageHead('УЧИСЬ БЕЗ ОГРАНИЧЕНИЙ', 'Найди своё направление', 'Все опубликованные курсы доступны бесплатно. Выбирай то, что интересно тебе.')}<div class="catalog-toolbar"><label class="search-field">${icon('search')}<input id="course-query" type="search" placeholder="Название курса или тема" aria-label="Поиск курсов" value="${escape(catalogQuery)}"></label><label class="select-field"><span>Дисциплина</span><select id="course-subject"><option value="">Все дисциплины</option>${subjects.map(s => `<option ${catalogSubject === s ? 'selected' : ''} value="${escape(s)}">${escape(s)}</option>`).join('')}</select></label></div><div class="catalog-caption"><span id="result-count" aria-live="polite">Курсов: ${coursesCache.length}</span><span>${icon('check')} Без подписок и оплаты</span></div><div class="course-grid" id="course-results">${coursesCache.length ? coursesCache.map(courseCard).join('') : empty('Курсы скоро появятся', 'Здесь будут опубликованные учебные курсы платформы.')}</div></section>`; }
  async function coursePage(id) { if (!user) return requireLogin('Учебный курс'); const [courses, lessons, progress] = await Promise.all([api().courses(), api().lessons(id), api().progress()]); const course = courses.find(c => Number(c.id) === id); if (!course) return `<section class="container section">${empty('Курс не найден', 'Возможно, он больше не опубликован.', button('К каталогу','#/courses'))}</section>`; currentCourse = course; const completed = lessons.filter(l => progress.some(p => Number(p.lesson) === Number(l.id) && p.completed)).length; return `<section class="container section"><a class="back-link" href="#/courses">← Все курсы</a><div class="course-layout"><div><div class="eyebrow">${escape(course.subject || 'УЧЕБНЫЙ КУРС')}</div><h1>${escape(course.title)}</h1><p class="lead">${escape(course.description)}</p><div class="section-heading compact-heading"><h2>Программа курса</h2><span class="mono">${lessons.length} уроков</span></div><div class="lesson-list">${lessons.map((l,i) => { const done = progress.some(p => Number(p.lesson) === Number(l.id) && p.completed); return `<a class="lesson-row" href="#/lesson/${id}/${Number(l.id)}"><span class="lesson-number">${String(i+1).padStart(2,'0')}</span><div><h3>${escape(l.title)}</h3><span>${done ? 'Урок пройден' : 'Материал и практика'}</span></div><span class="lesson-state">${icon(done ? 'check' : 'arrow')}</span></a>`; }).join('') || empty('Программа готовится', 'В этом курсе пока нет уроков.')}</div></div><aside class="study-card"><span class="feature-icon">${icon('book')}</span><h3>Твой путь в этом курсе</h3><div class="study-number">${completed}<small> / ${lessons.length}</small></div><p>уроков завершено</p>${bar(lessons.length ? completed / lessons.length * 100 : 0)}<span class="badge success">Бесплатный доступ</span>${lessons.length ? button('Открыть урок', `#/lesson/${id}/${Number((lessons.find(l => !progress.some(p => Number(p.lesson) === Number(l.id) && p.completed)) || lessons[0]).id)}`) : ''}<p class="small-note">Урок завершается после проверки ответов на все его задания.</p></aside></div></section>`; }
  async function lessonPage(courseId, lessonId) { if (!user) return requireLogin('Учебный урок'); const [lessons, exercises, attempts] = await Promise.all([api().lessons(courseId), api().exercises(courseId,lessonId), api().attempts()]); const lesson = lessons.find(l => Number(l.id) === lessonId); if (!lesson) return `<section class="container section">${empty('Урок не найден', 'Вернитесь к программе курса.')}</section>`; currentLesson = lesson; currentExercises = exercises; const next = lessons[lessons.findIndex(l=>Number(l.id)===lessonId)+1]; return `<section class="container section"><a class="back-link" href="#/course/${courseId}">← Программа курса</a><div class="learning-layout"><article class="lesson-article"><div class="eyebrow">УЧЕБНЫЙ МАТЕРИАЛ</div><h1>${escape(lesson.title)}</h1><div class="lesson-content">${escape(lesson.content || 'Материал урока пока не добавлен.').split(/\n\s*\n/).map(p=>`<p>${p.replace(/\n/g,'<br>')}</p>`).join('')}</div><div class="exercise-section"><div class="eyebrow">ПРИМЕНИ ЗНАНИЯ</div><h2>Практика</h2>${exercises.map(ex => { const latest = attempts.filter(a=>Number(a.exercise)===Number(ex.id)).sort((a,b)=>Date.parse(b.submitted_at)-Date.parse(a.submitted_at))[0]; return `<div class="exercise-card"><div class="exercise-heading"><h3>${escape(ex.title)}</h3><span class="mono">до ${format(ex.max_score)} баллов</span></div><p class="preserve-lines">${escape(ex.description)}</p>${latest ? `<div class="last-attempt">${status(latest.status)}<span>${latest.score == null ? 'Ответ отправлен' : `${format(latest.score)} / ${format(ex.max_score)}`}</span>${assessmentFeedback(latest.feedback)}</div>` : ''}<form data-form="answer" data-exercise="${Number(ex.id)}"><label for="answer-${Number(ex.id)}">Твой ответ</label><textarea id="answer-${Number(ex.id)}" name="answer" rows="5" maxlength="4000" required placeholder="Запиши решение и объясни ход мыслей…"></textarea><p class="form-error" role="alert"></p><div class="exercise-footer"><span>Для подключённых заданий ИИ автоматически выставляет балл и обновляет прогресс. Оценка ИИ может ошибаться.</span><button class="button primary" type="submit">${latest ? 'Отправить новую попытку' : 'Отправить на проверку'} ${icon('arrow')}</button></div></form></div>`; }).join('') || '<p class="subtle">К этому уроку пока нет опубликованных заданий.</p>'}</div>${next ? button('Следующий урок', `#/lesson/${courseId}/${Number(next.id)}`, 'secondary') : button('Вернуться к программе', `#/course/${courseId}`, 'secondary')}</article><aside class="lesson-sidebar"><div class="eyebrow">УРОКИ КУРСА</div>${lessons.map((l,i)=>`<a href="#/lesson/${courseId}/${Number(l.id)}" ${Number(l.id)===lessonId?'aria-current="page"':''}><span class="mono">${String(i+1).padStart(2,'0')}</span>${escape(l.title)}</a>`).join('')}<div class="aside-tip">${icon('file')}<p>Нужны свои записи? Материалы всегда рядом.</p><a href="#/documents">Мои документы →</a></div></aside></div></section>`; }
  function progressTable(courses) { return courses.length ? `<div class="table-scroll"><table><thead><tr><th>Курс</th><th>Пройдено</th><th>Прогресс</th><th>Средний балл</th><th><span class="sr-only">Действие</span></th></tr></thead><tbody>${courses.map(c=>`<tr><td><a class="table-course" href="#/course/${Number(c.course_id)}">${escape(c.course_title)}</a></td><td class="mono nowrap">${format(c.completed_lessons)} / ${format(c.total_lessons)}</td><td><div class="table-progress">${bar(c.completion_percent)}<span class="mono">${format(c.completion_percent)}%</span></div></td><td class="mono">${c.completed_lessons ? format(c.average_score) + '%' : '—'}</td><td><a class="table-action" href="#/course/${Number(c.course_id)}" aria-label="Открыть курс ${escape(c.course_title)}">Открыть ${icon('arrow')}</a></td></tr>`).join('')}</tbody></table></div>` : empty('Пока нет курсов', 'Опубликованные курсы появятся здесь.'); }
  function attemptRows(attempts, limit = 100) { return attempts.length ? attempts.slice(0,limit).map(a=>`<article class="attempt-row"><span class="attempt-icon">${icon('file')}</span><div class="attempt-copy"><strong>${escape(a.exercise_title || `Задание №${a.exercise}`)}</strong><span>${date(a.submitted_at)}</span>${assessmentFeedback(a.feedback)}<details><summary>Мой ответ</summary><p class="preserve-lines">${escape(a.answer)}</p></details></div><div class="attempt-result">${status(a.status)}<span class="mono">${a.score == null ? '—' : format(a.score) + ' балл.'}</span></div></article>`).join('') : empty('Первый результат впереди', 'Открой урок и отправь ответ на задание.'); }
  async function dashboard(full = false) { if (!user) return requireLogin(full ? 'Мой прогресс' : 'Личный кабинет'); const [stats, attempts, docs] = await Promise.all([api().dashboard(), api().attempts(), full ? Promise.resolve([]) : api().documents().catch(err=>{if(err.status===503)return null;throw err;})]); const completed = stats.courses.reduce((n,c)=>n+Number(c.completed_lessons),0), total = stats.courses.reduce((n,c)=>n+Number(c.total_lessons),0); return `<section class="container section">${pageHead(full ? 'ТВОИ РЕЗУЛЬТАТЫ' : 'ЛИЧНЫЙ КАБИНЕТ', full ? 'Каждый урок — шаг вперёд' : `Привет, ${escape(user.display_name || 'ученик')}!`, full ? 'Завершённые уроки, оценки и обратная связь по заданиям.' : 'Продолжай учиться и открывать новые возможности.', button('Все курсы','#/courses','secondary'))}<div class="stats-grid"><div><span>Доступно курсов</span><strong>${format(stats.total_courses)}</strong>${icon('book')}</div><div><span>Пройдено уроков</span><strong>${format(completed)} <small>/ ${format(total)}</small></strong>${icon('check')}</div><div><span>Ответов на проверке</span><strong>${attempts.filter(a=>a.status==='submitted').length}</strong>${icon('clock')}</div></div><section class="panel"><div class="panel-heading"><h2>Прогресс по курсам</h2><span class="subtle">Учись в своём темпе</span></div>${progressTable(stats.courses)}</section><div class="${full ? '' : 'dashboard-grid'}"><section class="panel"><div class="panel-heading"><h2>${full ? 'История ответов' : 'Последние ответы'}</h2>${full ? '' : '<a class="plain-link" href="#/progress">Все ответы →</a>'}</div>${attemptRows(attempts,full?1000:3)}</section>${full ? '' : `<div><section class="panel"><div class="panel-heading"><h2>Мои документы</h2>${icon('file')}</div>${docs === null ? '<p class="panel-message">Материалы сейчас недоступны. Прогресс и оценки доступны.</p>' : docs.length ? docs.slice(0,3).map(d=>`<a href="#/documents" class="document-short">${icon('file')}<span>${escape(d.title)}</span>${status(d.status)}</a>`).join('') : '<p class="panel-message">Загрузи конспект, чтобы создать мини-курс или тест по нему.</p>'}<a class="panel-bottom-link" href="#/documents">Открыть материалы ${icon('arrow')}</a></section><a href="#/tutor" class="tutor-card">${icon('spark')}<div><h3>ИИ-репетитор</h3><span>Вопросы по коду задания</span></div><span class="badge neutral">Проверка</span></a></div>`}</div></section>`; }

  const studyStates = {
    queued: 'В очереди', running: 'Создаётся', ready: 'Готово',
    failed: 'Не удалось создать', unknown: 'Результат пока неизвестен'
  };
  const activeStudy = pack => pack.status === 'queued' || pack.status === 'running';
  const watchStudy = pack => activeStudy(pack) || pack.status === 'unknown';
  const modeLabel = mode => mode === 'course' ? 'Мини-курс' : 'Тест';
  const studyBadge = pack => `<span class="badge ${pack.status === 'ready' ? 'success' : pack.status === 'failed' ? 'danger' : 'neutral'}">${escape(studyStates[pack.status] || pack.status)}</span>`;
  const studyLink = pack => `#/study/${Number(pack.id)}`;
  const documentLink = doc => `#/documents/${Number(doc.id)}`;

  function documentRow(doc) {
    return `<div class="document-row">
      <span class="document-icon">${icon('file')}</span>
      <div class="document-info"><a href="${documentLink(doc)}">${escape(doc.title)}</a>
        <span>${date(doc.created_at)}${doc.status === 'ready' ? ` · ${format(doc.text_length)} симв.` : ''}</span>
        ${doc.status === 'failed' ? `<span class="error-text">${escape(documentIssue(doc.error))}</span>` : ''}
      </div>
      ${status(doc.status)}
      ${doc.status === 'ready' ? button('Открыть текст', documentLink(doc), 'secondary compact') : ''}
      <button class="icon-button" data-action="delete-document" data-id="${Number(doc.id)}" data-title="${escape(doc.title)}" aria-label="Удалить ${escape(doc.title)}">${icon('trash')}</button>
    </div>`;
  }
  function packRows(packs) {
    return packs.length ? packs.map(pack => `<div class="document-row study-pack-row">
      <span class="document-icon">${icon(pack.mode === 'course' ? 'book' : 'file')}</span>
      <div class="document-info"><a href="${studyLink(pack)}">${escape(pack.title || modeLabel(pack.mode))}</a>
        <span>${pack.status === 'ready' ? `${format(pack.progress.answered)} из ${format(pack.progress.total)} ответов · ${format(pack.progress.score)} из ${format(pack.progress.max_score)} баллов` : modeLabel(pack.mode)}</span>
      </div>
      ${studyBadge(pack)}
      ${button(pack.status === 'ready' ? 'Открыть' : 'Статус', studyLink(pack), 'secondary compact')}
    </div>`).join('') : empty('Пока нет мини-курсов и тестов', 'Открой текст загруженного документа и выбери фрагмент.');
  }
  async function documentsPage() {
    if (!user) return requireLogin('Мои документы');
    const [docs, packs] = await Promise.all([api().documents(), api().studyPacks()]);
    return `<section class="container section">
      ${pageHead('ЛИЧНЫЕ МАТЕРИАЛЫ', 'Мои документы', 'Загрузи текст по любой учебной теме. По выбранному фрагменту локальный ИИ создаст мини-курс или тест.')}
      <div class="documents-layout">
        <div>
          <section class="panel">
            <div class="panel-heading"><h2>Загруженные файлы</h2><span class="mono">${docs.length}</span></div>
            ${docs.length ? docs.map(documentRow).join('') : empty('Пока нет документов', 'Загрузи первый учебный материал.')}
          </section>
          <section class="panel">
            <div class="panel-heading"><h2>Мои мини-курсы и тесты</h2></div>
            <div id="study-packs" data-watch="${packs.some(watchStudy)}">${packRows(packs)}</div>
            <p class="form-error study-poll-error" role="status"></p>
          </section>
        </div>
        <aside>
          <form data-form="upload" class="upload-card">
            <span class="upload-icon">${icon('upload')}</span>
            <h2>Добавить материал</h2>
            <p>Конспект, учебник или презентация.</p>
            <label class="file-label" for="upload-file">Выбрать файл</label>
            <input id="upload-file" name="file" type="file" accept=".pdf,.docx,.pptx,.txt" required>
            <span id="chosen-file" class="chosen-file">Файл не выбран</span>
            <div class="file-types">PDF · DOCX · PPTX · TXT<br>Максимальный размер — 20 МБ</div>
            <p class="form-error" role="alert"></p>
            <button class="button primary" type="submit">Загрузить документ ${icon('upload')}</button>
            <p class="small-note">Для PDF нужен текстовый слой.</p>
          </form>
        </aside>
      </div>
    </section>`;
  }
  async function documentPage(id) {
    if (!user) return { content: requireLogin('Мои документы') };
    const doc = await api().documentDetail(id);
    const source = doc.extracted_text || '';
    const length = Array.from(source).length;
    const canGenerate = doc.status === 'ready' && length >= 100;
    const content = `<section class="container section study-page">
      <a class="back-link" href="#/documents">← Мои документы</a>
      ${pageHead('ИСХОДНЫЙ ДОКУМЕНТ', escape(doc.title), doc.status === 'ready' ? `${format(length)} символов извлечённого текста` : '')}
      ${doc.status === 'ready' ? `<section class="panel study-block">
        <h2 id="source-title">Текст документа</h2>
        <div id="study-source" class="study-source preserve-lines" tabindex="0" role="region" aria-labelledby="source-title"></div>
      </section>` : `<section class="panel study-block">${status(doc.status)}
        <p>${doc.status === 'failed' ? escape(documentIssue(doc.error)) : 'Текст ещё обрабатывается.'}</p>
      </section>`}
      ${canGenerate ? `<form class="panel study-block" data-form="generate-study" data-id="${Number(id)}">
        <h2>Создать учебный материал</h2>
        <p class="subtle">Выбери от 100 до 6 000 символов. Можно выделить текст мышью или задать границы вручную. В материал войдёт только выбранный фрагмент.</p>
        <button class="button secondary compact" data-action="use-excerpt-selection" type="button">Использовать выделенный текст</button>
        <div class="study-range">
          <label>Первый символ <input name="first" type="number" min="1" max="${length}" value="1" required></label>
          <label>Последний символ <input name="last" type="number" min="1" max="${length}" value="${Math.min(length, 6000)}" required></label>
        </div>
        <p id="study-range-status" class="subtle" role="status"></p>
        <details class="study-citation" open><summary>Выбранный фрагмент</summary>
          <div id="study-excerpt" class="study-source preserve-lines" tabindex="0" role="region" aria-label="Выбранный фрагмент"></div>
        </details>
        <label class="study-mode" for="study-mode">Формат</label>
        <select id="study-mode" name="mode"><option value="course">Мини-курс с тестом</option><option value="test">Только тест</option></select>
        <p class="form-error" role="alert"></p>
        <button class="button primary" type="submit">Создать ${icon('spark')}</button>
      </form>` : doc.status === 'ready' ? '<p class="panel study-block">Для создания мини-курса или теста нужен текст длиной от 100 символов.</p>' : ''}
    </section>`;
    return { content, source };
  }
  function sourceRange(form, length) {
    const first = form.elements.first.valueAsNumber;
    const last = form.elements.last.valueAsNumber;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > length) return null;
    return { start: first - 1, end: last };
  }
  const studySources = new WeakMap();
  function updateExcerpt(form) {
    const chars = studySources.get(form);
    const range = sourceRange(form, chars.length);
    const count = range ? range.end - range.start : 0;
    const valid = count >= 100 && count <= 6000;
    $('#study-range-status', form).textContent = range
      ? `Символы ${format(range.start + 1)}–${format(range.end)} из ${format(chars.length)}. Выбрано ${format(count)}.${valid ? '' : ' Нужно от 100 до 6 000 символов.'}`
      : 'Укажи границы в пределах документа.';
    $('#study-excerpt', form).textContent = range && count <= 6000 ? chars.slice(range.start, range.end).join('') : '';
  }
  function mountDocument(source) {
    const region = $('#study-source');
    if (!region) return;
    region.textContent = source;
    const form = $('[data-form="generate-study"]');
    if (!form) return;
    studySources.set(form, Array.from(source));
    form.addEventListener('input', () => updateExcerpt(form));
    updateExcerpt(form);
  }
  function useExcerptSelection(control) {
    const form = control.form;
    const source = $('#study-source').firstChild;
    const selection = window.getSelection();
    const error = $('.form-error', form);
    if (!selection?.rangeCount || selection.isCollapsed || selection.anchorNode !== source || selection.focusNode !== source) {
      error.textContent = 'Выдели фрагмент в тексте документа или задай границы вручную.';
      return;
    }
    const range = selection.getRangeAt(0);
    const chars = studySources.get(form);
    const start = Array.from(source.data.slice(0, range.startOffset)).length;
    const end = Array.from(source.data.slice(0, range.endOffset)).length;
    form.elements.first.value = Math.min(start + 1, chars.length);
    form.elements.last.value = end;
    error.textContent = '';
    updateExcerpt(form);
  }

  function studyProgress(progress) {
    const { answered, total, score, max_score, percent, completed } = progress;
    const completion = Number(total) > 0 ? 100 * Number(answered) / Number(total) : 0;
    return `<p><strong>${format(answered)} из ${format(total)} ответов</strong> · ${format(score)} из ${format(max_score)} баллов (${format(percent)}%)${completed ? ' · Тест завершён' : ''}</p>${bar(completion)}`;
  }
  function citation(quote) {
    return `<details class="study-citation"><summary>Цитата из документа</summary><blockquote class="preserve-lines">${escape(quote)}</blockquote></details>`;
  }
  function studyResult(result, selectedOption) {
    const feedback = String(result.feedback ?? '').trim();
    const quote = String(result.source_quote ?? '').trim();
    const normalize = text => text.replace(/\s+/g, ' ').trim();
    const reason = normalize(feedback) === normalize(quote) ? '' : feedback;
    return `<div class="study-result study-result-${result.correct ? 'correct' : 'incorrect'}">
      <div class="study-result-heading"><strong>${result.correct ? 'Верно' : 'Неверно'}</strong><span>${format(result.score)} из ${format(result.max_score)} баллов</span></div>
      <dl class="study-answer-summary"><div><dt>Твой ответ</dt><dd>${escape(selectedOption)}</dd></div>${result.correct_option ? `<div><dt>Верный ответ</dt><dd>${escape(result.correct_option)}</dd></div>` : ''}</dl>
      ${reason ? `<div class="study-reason"><strong>Разбор ответа</strong><p class="preserve-lines">${escape(reason)}</p></div>` : ''}
      ${quote ? citation(quote) : ''}
    </div>`;
  }
  function questionCard(question, index) {
    const id = escape(question.id);
    return `<form class="panel study-block study-question" data-form="study-answer" data-question="${id}">
      <fieldset>
        <legend>${index + 1}. ${escape(question.prompt)}</legend>
        ${question.options.map((option, choice) => `<label class="study-option"><input type="radio" name="choice" value="${choice}" required><span>${escape(option)}</span></label>`).join('')}
      </fieldset>
      <div class="button-row">
        <button class="button primary compact" type="submit">Проверить ответ</button>
        <button class="button secondary compact" type="button" data-action="study-hint">Подсказка</button>
      </div>
      <p class="form-error" role="alert"></p>
      <div class="study-hint" role="status" hidden></div>
      <div class="study-feedback" aria-live="polite"></div>
    </form>`;
  }
  function studyContent(pack) {
    const range = `Символы ${format(Number(pack.source_start) + 1)}–${format(pack.source_end)} исходного документа`;
    const header = pageHead(modeLabel(pack.mode).toUpperCase(), escape(pack.title || modeLabel(pack.mode)), range);
    if (pack.status !== 'ready') {
      const messages = {
        queued: 'Запрос сохранён и ожидает обработки.',
        running: 'Локальный ИИ создаёт учебный материал. Можно закрыть эту страницу и открыть результат позже.',
        failed: 'Создание завершилось ошибкой. Материал и оценки не созданы.',
        unknown: 'Сервер ещё не подтвердил результат. Статус обновится, если результат удастся восстановить.'
      };
      return `${header}<div class="panel study-block" role="status">
        ${studyBadge(pack)}<p>${escape(messages[pack.status] || '')}</p>
        ${pack.status === 'failed' || pack.status === 'unknown' ? `<p class="subtle">${escape(studyIssue(pack.error_code))}</p>` : ''}
      </div>`;
    }
    const lessons = pack.lessons.map(lesson => `<article class="panel study-block">
      <h3>${escape(lesson.title)}</h3>
      <div class="preserve-lines">${escape(lesson.content)}</div>
      ${citation(lesson.source_quote)}
    </article>`).join('');
    return `${header}
      ${lessons ? `<section class="study-stack" aria-label="Уроки"><h2>Уроки</h2>${lessons}</section>` : ''}
      ${pack.source_excerpt ? `<details class="panel study-block" open><summary>Учебный фрагмент документа</summary><p class="subtle">Используй этот текст при работе с вопросами.</p><div class="preserve-lines">${escape(pack.source_excerpt)}</div></details>` : ''}
      <section class="study-stack" aria-label="Тест">
        <h2>Тест</h2>
        <div class="panel study-block">
          <p class="subtle">ИИ составил вопросы и ключи ответов. Система автоматически начисляет баллы по этим ключам. Вопросы и ключи могут содержать ошибки. В прогресс идёт последний ответ на каждый вопрос.</p>
          <div id="study-progress" class="study-progress" aria-live="polite">${studyProgress(pack.progress)}</div>
        </div>
        ${pack.questions.map(questionCard).join('')}
      </section>`;
  }
  async function studyPage(id) {
    if (!user) return requireLogin('Личный учебный материал');
    const pack = await api().studyPack(id);
    return `<section class="container section study-page">
      <a class="back-link" href="#/documents">← Мои документы</a>
      <div id="study-pack" data-id="${Number(pack.id)}" data-status="${escape(pack.status)}">${studyContent(pack)}</div>
      <p class="form-error study-poll-error" role="status"></p>
    </section>`;
  }
  function pollStudy(target, read, update) {
    const error = $('.study-poll-error', target.parentElement);
    const tick = async () => {
      if (!target.isConnected) return;
      let again = true;
      try {
        const data = await read();
        if (!target.isConnected) return;
        error.textContent = '';
        again = update(data);
      } catch (failure) {
        if (!target.isConnected) return;
        error.textContent = 'Не удалось обновить статус. ' + (failure.message || '');
        again = failure.status !== 401 && failure.status !== 404;
      }
      if (again) setTimeout(tick, 5000);
    };
    setTimeout(tick, 3000);
  }
  function mountStudyPolling() {
    const list = $('#study-packs[data-watch="true"]');
    if (list) {
      let markup = null;
      pollStudy(list, () => api().studyPacks(), packs => {
        const next = packRows(packs);
        if (markup !== next) {
          const activeHref = list.contains(document.activeElement) && document.activeElement.getAttribute('href');
          list.innerHTML = next;
          if (activeHref) Array.from(list.querySelectorAll('a')).find(a => a.getAttribute('href') === activeHref)?.focus();
          markup = next;
        }
        return packs.some(watchStudy);
      });
    }
    const target = $('#study-pack');
    if (target && watchStudy(target.dataset)) {
      pollStudy(target, () => api().studyPack(Number(target.dataset.id)), pack => {
        if (pack.status !== target.dataset.status) {
          target.dataset.status = pack.status;
          target.innerHTML = studyContent(pack);
        }
        return watchStudy(pack);
      });
    }
  }


  const issueMessages = {
    unsupported_type: 'Выбери PDF, DOCX, PPTX или TXT.',
    file_too_large: 'Файл превышает 20 МБ.',
    empty_document: 'В файле не найден текст. Для PDF нужен текстовый слой.',
    invalid_utf8: 'Сохрани TXT в кодировке UTF-8.',
    text_too_large: 'В документе больше 200 000 символов.',
    invalid_document: 'Не удалось прочитать файл. Проверь, открывается ли он.',
    encrypted_document: 'Загрузи документ без защиты паролем.',
    unsafe_archive: 'Не удалось безопасно распаковать документ.',
    parser_unavailable: 'Сервер не может обработать этот формат.',
    document_not_ready: 'Текст документа ещё недоступен.',
    invalid_range: 'Выбери от 100 до 6 000 символов в пределах документа.',
    request_conflict: 'Этот идентификатор уже использован с другими параметрами.',
    generation_active: 'Другой материал уже создаётся. Его статус доступен в разделе «Мои документы».',
    queue_full: 'Очередь заполнена. Попробуй позже.',
    pack_not_ready: 'Материал ещё не готов.',
    unknown_question: 'Вопрос не найден. Открой тест заново.',
    invalid_result: 'Ответ модели не прошёл проверку формата и цитат.',
    worker_unreachable: 'Сервер не получил подтверждение от локального ИИ.',
    receipt_missing: 'Сервер не нашёл сохранённый результат.',
    generation_unknown: 'Сервер ещё не подтвердил результат.'
  };
  const documentIssue = code => issueMessages[code] || 'Не удалось извлечь текст из файла.';
  const studyIssue = code => issueMessages[code] || '';
  const mutationMessage = error => issueMessages[error.details?.error] || error.message;
  const pendingStudyRequests = new Map();
  function requestIdentity(key) {
    const storageKey = 'lat-study-request:' + JSON.stringify([api().settings().baseUrl, user.id ?? user.email, ...key]);
    let requestId = pendingStudyRequests.get(storageKey);
    try { requestId ||= sessionStorage.getItem(storageKey); } catch { /* Private browsing may deny storage. */ }
    if (!requestId) {
      requestId = crypto.randomUUID();
      pendingStudyRequests.set(storageKey, requestId);
      try { sessionStorage.setItem(storageKey, requestId); } catch { /* Keep the ID in this view. */ }
    }
    return { requestId, finish() {
      pendingStudyRequests.delete(storageKey);
      try { sessionStorage.removeItem(storageKey); } catch { /* Already cleared in memory. */ }
    } };
  }
  const mayHaveCommitted = error => !error.status || error.status >= 500 || (error.status >= 200 && error.status < 300);
  async function generateStudy(form, data) {
    const id = Number(form.dataset.id);
    const chars = studySources.get(form);
    const range = sourceRange(form, chars.length);
    if (!range || range.end - range.start < 100 || range.end - range.start > 6000) throw new Error(issueMessages.invalid_range);
    const mode = data.get('mode');
    const identity = requestIdentity(['generate', id, mode, range.start, range.end]);
    let pack;
    try {
      pack = await api().generateStudyPack(id, {
        request_id: identity.requestId, mode, source_start: range.start, source_end: range.end
      });
      if (!Number.isSafeInteger(Number(pack?.id)) || Number(pack.id) <= 0) throw new Error('Сервер не вернул идентификатор материала.');
    } catch (error) {
      if (mayHaveCommitted(error)) throw new Error('Статус отправки неизвестен. Проверь «Мои мини-курсы и тесты» или повтори отправку с теми же параметрами.');
      throw error;
    }
    identity.finish();
    if (form.isConnected) location.hash = studyLink(pack).slice(1);
  }
  async function fetchStudyHint(control) {
    const form = control.form;
    const output = $('.study-hint', form);
    if (control.disabled || !output.hidden) return;
    const error = $('.form-error', form);
    control.disabled = true;
    error.textContent = '';
    try {
      const packId = Number(form.closest('#study-pack').dataset.id);
      const result = await api().studyHint(packId, form.dataset.question);
      if (form.isConnected) {
        output.hidden = false;
        output.innerHTML = `<strong>Подсказка</strong><p class="preserve-lines">${escape(result.hint)}</p>`;
      }
    } catch (failure) {
      if (form.isConnected) error.textContent = mutationMessage(failure);
    } finally {
      control.disabled = false;
    }
  }
  async function submitStudyAnswer(form, data) {
    const pack = form.closest('#study-pack');
    const packId = Number(pack.dataset.id);
    const question = form.dataset.question;
    const value = data.get('choice');
    if (value === null || !/^[0-3]$/.test(value)) throw new Error('Выбери один вариант ответа.');
    const choice = Number(value);
    const selectedOption = $(`.study-option input[value="${choice}"] + span`, form)?.textContent || `Вариант ${choice + 1}`;
    const submittedInput = $(`.study-option input[value="${choice}"]`, form);
    if (submittedInput) delete submittedInput.dataset.result;
    const identity = requestIdentity(['attempt', packId, question, choice]);
    const feedback = $('.study-feedback', form);
    const wasDisabled = [];
    for (const button of pack.querySelectorAll('button[type="submit"]:not(:disabled)')) {
      button.disabled = true;
      wasDisabled.push(button);
    }
    feedback.textContent = '';
    try {
      let result;
      try {
        result = await api().studyAttempt(packId, { request_id: identity.requestId, question_id: question, choice });
        if (typeof result?.correct !== 'boolean' || ![0, 1].includes(result.score) || result.max_score !== 1 || !result.progress) {
          throw new Error('Сервер не подтвердил проверку ответа.');
        }
      } catch (error) {
        if (mayHaveCommitted(error)) throw new Error('Проверка ответа не подтверждена. Повтори отправку того же варианта, чтобы получить результат.');
        throw error;
      }
      identity.finish();
      if (!form.isConnected) return;
      if (submittedInput) submittedInput.dataset.result = result.correct ? 'correct' : 'incorrect';
      feedback.innerHTML = studyResult(result, selectedOption);
      // A replayed receipt may carry an older progress snapshot.
      const fresh = await api().studyPack(packId).catch(() => null);
      if (!form.isConnected) return;
      if (fresh?.progress) $('#study-progress', pack).innerHTML = studyProgress(fresh.progress);
      else $('.form-error', form).textContent = 'Ответ проверен. Обнови страницу, чтобы получить текущий прогресс.';
    } finally {
      for (const button of wasDisabled) button.disabled = false;
    }
  }

  function tutor() { return `<section class="container section"><div class="coming-soon"><span class="feature-icon">${icon('spark')}</span><h1>Спроси о своём коде</h1><p>Открой подключённое задание курса Python. Код редактора прикладывается автоматически; выдели фрагмент, чтобы спросить именно о нём.</p>${button('Открыть курсы','#/courses')}<p class="small-note">Пояснения локальной модели могут содержать ошибки. Подсказки из каталога и резервные ответы помечены в репетиторе.</p></div></section>`; }
  async function render() {
    const ticket = ++renderId; const route = location.hash.slice(1) || '/';
    const previousNavigation = window.LATMotion?.snapshot();
    $('#app').innerHTML = `${header(route)}<main id="main" tabindex="-1"><div class="container section"><div class="loading-line"></div><p class="subtle">Загружаем…</p></div></main>${footer()}`;
    window.LATMotion?.shell(previousNavigation);
    try {
      let content, source;
      if(route==='/') content=await home(); else if(route==='/about') content=about(); else if(route==='/courses') content=await catalog(); else if(route==='/dashboard') content=await home(); else if(route==='/progress') content=await dashboard(true); else if(route==='/documents') content=await documentsPage(); else if(route==='/tutor') content=tutor();
      else if(/^\/documents\/\d+$/.test(route)) ({ content, source } = await documentPage(Number(route.split('/')[2])));
      else if(/^\/study\/\d+$/.test(route)) content = await studyPage(Number(route.split('/')[2]));
      else if(/^\/course\/\d+$/.test(route)) content=await coursePage(Number(route.split('/')[2]));
      else if(/^\/lesson\/\d+\/\d+$/.test(route)) content=await lessonPage(...route.split('/').slice(2).map(Number));
      else content=`<section class="container section">${empty('Такой страницы нет','Вернитесь на главную или откройте каталог.',button('На главную','#/'))}</section>`;
      if(ticket!==renderId)return; $('#main').innerHTML=content;
      if(/^\/lesson\/\d+\/\d+$/.test(route)&&user)window.LATTutor?.mount($('#main'),...route.split('/').slice(2).map(Number),api());
      if(route==='/courses' && user) filterCourses();
      if(source !== undefined) mountDocument(source);
      mountStudyPolling();
      window.LATMotion?.enter($('#main'));
    } catch(error) { if(ticket!==renderId)return; $('#main').innerHTML=`<section class="container section">${errorView(error)}</section>`; }
    if(ticket===renderId) { document.title=`${route==='/' ? 'Главная' : route==='/courses' ? 'Каталог курсов' : route==='/dashboard' ? 'Личный кабинет' : route==='/documents' ? 'Мои документы' : route==='/progress' ? 'Мой прогресс' : 'Обучение'} — LAT AI`; if(!$('#modal').open)$('#main').focus({preventScroll:true}); }
  }
  function openModal(content, wide = false) {
    const el = $('#modal'), wasOpen = el.open, previousHeight = el.offsetHeight;
    el.className = wide ? 'wide' : '';
    el.innerHTML = `<button class="modal-close icon-button" data-action="close" aria-label="Закрыть">${icon('close')}</button><div class="modal-content">${content}</div>`;
    if (!wasOpen) el.showModal();
    window.LATMotion?.dialog(el, {wasOpen, previousHeight});
    if (wasOpen) (el.querySelector('input, textarea, select') || el.querySelector('.modal-close')).focus({preventScroll: true});
  }
  function closeModal() {
    const el = $('#modal');
    if (window.LATMotion?.closeDialog) return window.LATMotion.closeDialog(el);
    el.close();
    return Promise.resolve();
  }
  function motionModal() {
    const motion = window.LATMotion.settings();
    openModal(`<span class="eyebrow">КОМФОРТНОЕ ОБУЧЕНИЕ</span><h2 id="modal-title">Анимации интерфейса</h2><p class="modal-intro">Выбери, как будут открываться окна и переключаться разделы LAT AI.</p><form data-form="motion"><label for="motion-mode">Плавные анимации</label><select id="motion-mode" name="mode">${[['auto','Как в системе'],['full','Включены'],['reduced','Без движения']].map(([value,label])=>`<option value="${value}" ${motion.mode===value?'selected':''}>${label}</option>`).join('')}</select><p class="small-note">${motion.systemReduced?'В системе сейчас включено уменьшение движения. Выбери «Включены», чтобы видеть анимации на этом сайте.':'Выбор применяется только к этому сайту и сохраняется в этом браузере.'}</p><p class="form-error" role="alert"></p><button class="button primary full-width" type="submit">Сохранить</button></form>`);
  }
  function appearanceControls() {
    return `<section class="profile-preferences" aria-label="Оформление"><h3>Оформление</h3><button type="button" class="preference-toggle" data-action="toggle-theme" role="switch" aria-checked="false" aria-label="Тёмная тема"><span><strong>Тёмная тема</strong><small>Мягкие цвета для вечернего обучения</small></span><span class="preference-state" aria-hidden="true"></span><span class="preference-track" aria-hidden="true"></span></button><button type="button" class="preference-toggle" data-action="toggle-motion" role="switch" aria-checked="false" aria-label="Анимации"><span><strong>Анимации</strong><small>Плавные переходы и эффекты</small></span><span class="preference-state" aria-hidden="true"></span><span class="preference-track" aria-hidden="true"></span></button><p class="small-note">Применяется сразу. Выбор сохраняется в этом браузере.</p><button type="button" class="preference-toggle" data-action="settings"><span><strong>Подключение к платформе</strong></span>${icon('arrow')}</button></section>`;
  }
  function refreshAppearanceControls() {
    for (const [action, enabled] of [['toggle-theme', window.LATAppearance.settings().theme === 'dark'], ['toggle-motion', document.documentElement.dataset.motion === 'full']]) {
      const control = document.querySelector(`[data-action="${action}"]`);
      if (!control) continue;
      control.setAttribute('aria-checked', String(enabled));
      control.querySelector('.preference-state').textContent = enabled ? 'Вкл.' : 'Выкл.';
    }
  }
  function profileModal() {
    const details = user ? `<dl class="profile-details"><dt>Электронная почта</dt><dd>${escape(user.email)}</dd><dt>Роль</dt><dd>${escape(({student:'Ученик',teacher:'Преподаватель',admin:'Администратор'})[user.role] || user.role)}</dd></dl>` : '';
    openModal(`<span class="eyebrow">ЛИЧНЫЙ ПРОФИЛЬ</span><h2 id="modal-title">${escape(user?.display_name || (user ? 'Мой профиль' : 'Настройки профиля'))}</h2>${details}${appearanceControls()}${user ? `<button class="button secondary full-width" data-action="logout">${icon('exit')} Выйти из аккаунта</button>` : '<button class="button secondary full-width" data-action="login">Войти в аккаунт</button>'}`);
    refreshAppearanceControls();
  }
  window.addEventListener('lat:appearance-change', refreshAppearanceControls);
  window.addEventListener('lat:motion-change', refreshAppearanceControls);
  function authModal(register = false) { openModal(`<span class="eyebrow">LAT AI · LEARN AND TALK</span><h2 id="modal-title">${register?'Начни свой путь':'С возвращением'}</h2><p class="modal-intro">${register?'Создай аккаунт и учись бесплатно.':'Войди, чтобы продолжить обучение.'}</p><form data-form="${register?'register':'login'}">${register?'<label for="display-name">Как тебя зовут?</label><input id="display-name" name="display_name" autocomplete="name" maxlength="120" required placeholder="Твоё имя">':''}<label for="auth-email">Электронная почта</label><input id="auth-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com"><label for="auth-password">Пароль</label><input id="auth-password" name="password" type="password" autocomplete="${register?'new-password':'current-password'}" ${register?'minlength="8"':''} required placeholder="${register?'Не менее 8 символов':'Твой пароль'}"><p class="form-error" role="alert"></p><button class="button primary full-width" type="submit">${register?'Создать аккаунт':'Войти'} ${icon('arrow')}</button></form><div class="modal-switch">${register?'Уже есть аккаунт?':'Ещё нет аккаунта?'} <button class="link-button" data-action="${register?'login':'register'}">${register?'Войти':'Зарегистрироваться'}</button></div>`); }
  function settingsModal() { openModal(`<span class="eyebrow">НАСТРОЙКИ ПОДКЛЮЧЕНИЯ</span><h2 id="modal-title">Сервер платформы</h2><p class="modal-intro">Укажи адрес вашего Django API. Курсы, аккаунты и результаты хранятся на этом сервере.</p><form data-form="settings"><label for="api-url">Адрес API</label><input id="api-url" name="baseUrl" type="url" required value="${escape(api().settings().baseUrl)}"><p class="small-note">Обычно: http://127.0.0.1:8000/api/v1<br>При смене адреса потребуется войти заново.</p><p class="form-error" role="alert"></p><button class="button primary full-width" type="submit">Сохранить подключение</button></form>`); }
  document.addEventListener('click', async event => {
    if(event.target.closest('.skip-link')){event.preventDefault();document.querySelector('#main').focus();return;} const control=event.target.closest('[data-action]'); if(!control)return; const action=control.dataset.action;
    if(control.closest('#modal.lat-modal-closing') && action!=='login' && action!=='register')return;
    if(action==='login'||action==='register')authModal(action==='register');
    else if(action==='close')closeModal();
    else if(action==='settings')settingsModal();
    else if(action==='motion-settings')motionModal();
    else if(action==='home-upload'){if(!user)authModal();else $('#home-upload').click();}
    else if(action==='retry')render();
    else if(action==='use-excerpt-selection')useExcerptSelection(control);
    else if(action==='study-hint')await fetchStudyHint(control);
    else if(action==='dashboard')location.hash='/dashboard';
    else if(action==='menu'){ const expanded=control.getAttribute('aria-expanded')==='true'; control.setAttribute('aria-expanded',String(!expanded)); $('.friendly-sidebar').classList.toggle('is-open',!expanded); }
    else if(action==='profile')profileModal();
    else if(action==='toggle-theme')window.LATAppearance.configure(window.LATAppearance.settings().theme === 'dark' ? 'light' : 'dark');
    else if(action==='toggle-motion')window.LATMotion.configure(document.documentElement.dataset.motion === 'full' ? 'reduced' : 'full');
    else if(action==='logout'){await api().logout();user=null;if(control.isConnected)await closeModal();location.hash='/';render();toast('Вы вышли из аккаунта');}
    else if(action==='delete-document')openModal(`<span class="eyebrow">МОИ МАТЕРИАЛЫ</span><h2 id="modal-title">Удалить документ?</h2><p class="modal-intro">«${escape(control.dataset.title)}» будет удалён вместе со связанными мини-курсами, тестами и ответами.</p><form data-form="delete" data-id="${Number(control.dataset.id)}"><p class="form-error" role="alert"></p><div class="button-row"><button class="button secondary" type="button" data-action="close">Оставить</button><button class="button destructive" type="submit">Удалить</button></div></form>`);
  });
  document.addEventListener('input',event=>{if(event.target.id==='course-query'){catalogQuery=event.target.value;filterCourses();}});
  document.addEventListener('change',async event=>{if(event.target.id==='home-upload'){const input=event.target,file=input.files[0];if(!file)return;const upload=$('.friendly-upload'),errorEl=$('.home-upload-error'),previousContent=upload.innerHTML;upload.disabled=true;upload.setAttribute('aria-busy','true');upload.textContent='Обрабатываем…';errorEl.textContent='';try{const doc=await api().uploadDocument(file);toast(doc?.status==='failed'?'Файл загружен, но не удалось обработать документ.':'Документ загружен');if(input.isConnected)location.hash=documentLink(doc).slice(1);}catch(error){errorEl.textContent=mutationMessage(error);input.value='';}finally{if(upload.isConnected){upload.disabled=false;upload.removeAttribute('aria-busy');upload.innerHTML=previousContent;}}return;}if(event.target.id==='course-subject'){catalogSubject=event.target.value;filterCourses();}if(event.target.id==='upload-file')$('#chosen-file').textContent=event.target.files[0]?.name || 'Файл не выбран';});
  document.addEventListener('submit',async event=>{
    if(event.target.closest('#modal.lat-modal-closing')){event.preventDefault();return;}
    const form=event.target.closest('form[data-form]');if(!form)return;event.preventDefault();const data=new FormData(form), submit=$('[type="submit"]',form), error=$('.form-error',form);if(submit.disabled)return;submit.disabled=true;submit.setAttribute('aria-busy','true');error.textContent='';
    try {
      if(form.dataset.form==='login'||form.dataset.form==='register') { user=form.dataset.form==='login'?await api().login(data.get('email'),data.get('password')):await api().register(Object.fromEntries(data));if(!user)throw new Error('Не удалось получить профиль. Войдите снова.');if(form.isConnected)await closeModal();form.reset();if(!location.hash||location.hash==='#/'||location.hash==='#/about')location.hash='/dashboard';else await render();toast('Добро пожаловать в LAT AI'); }
      else if(form.dataset.form==='motion'){window.LATMotion.configure(data.get('mode'));await closeModal();toast(data.get('mode')==='full'?'Плавные анимации включены':'Настройка анимаций сохранена');}
      else if(form.dataset.form==='settings'){await api().configure({mode:'api',baseUrl:data.get('baseUrl').trim()});user=await api().me();if(form.isConnected)await closeModal();await render();toast('Адрес сервера сохранён');}
      else if(form.dataset.form==='answer'){const answer=data.get('answer').trim();if(!answer)throw new Error('Напиши ответ перед отправкой.');const result=await api().submitAttempt(Number(form.dataset.exercise),answer);toast(result.status==='auto_checked'?'ИИ проверила ответ. Балл и прогресс обновлены.':result.status==='assessment_failed'?'Ответ сохранён. Автопроверка не завершена — смотри причину.':'Ответ сохранён для проверки.');await render();}
      else if(form.dataset.form==='upload'){const file=data.get('file');if(!file?.name)throw new Error('Сначала выбери файл.');const doc=await api().uploadDocument(file);toast(doc?.status==='failed'?'Файл загружен, но не удалось обработать документ.':'Документ загружен');if(form.isConnected)location.hash=documentLink(doc).slice(1);}
      else if(form.dataset.form==='delete'){await api().deleteDocument(Number(form.dataset.id));if(form.isConnected)await closeModal();await render();toast('Документ удалён');}
      else if(form.dataset.form==='generate-study')await generateStudy(form, data);
      else if(form.dataset.form==='study-answer')await submitStudyAnswer(form, data);
    } catch(err){error.textContent=mutationMessage(err) || 'Не удалось выполнить действие. Попробуйте снова.';}finally{submit.disabled=false;submit.removeAttribute('aria-busy');}
  });
  let backdropPress = false;
  $('#modal').addEventListener('pointerdown', event => { backdropPress = event.target === $('#modal'); });
  $('#modal').addEventListener('click',event=>{if(backdropPress && event.target===$('#modal')) {const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}backdropPress=false;});
  $('#modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
  window.addEventListener('hashchange',()=>{window.scrollTo({top:0,behavior:'instant'});render();});
  async function init(){try{user=await api().me();}catch{user=null;}await render();}
  init();
})();
