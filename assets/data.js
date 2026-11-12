/* LAT AI: direct client for the supplied Django REST API. */
(function (global) {
  'use strict';
  const KEY = 'lat-ai-api-v1';
  const DEFAULT_BASE = 'http://127.0.0.1:8000/api/v1';
  const memory = Object.create(null);
  let generation = 0;
  let refreshFlight = null;
  function read(area, key, fallback) {
    if (Object.prototype.hasOwnProperty.call(memory, area + ':' + key)) return memory[area + ':' + key];
    try { const value = global[area].getItem(KEY + ':' + key); return value ? JSON.parse(value) : fallback; }
    catch (_) { return fallback; }
  }
  function write(area, key, value) {
    memory[area + ':' + key] = value;
    try { global[area].setItem(KEY + ':' + key, JSON.stringify(value)); } catch (_) { /* Memory-only session if storage is unavailable. */ }
  }
  function remove(area, key) {
    memory[area + ':' + key] = null;
    try { global[area].removeItem(KEY + ':' + key); } catch (_) { /* In-memory value already cleared. */ }
  }
  function fail(message, status, details) {
    const error = new Error(message);
    error.status = status || 0;
    error.details = details || null;
    return error;
  }
  function normalBase(value) {
    let url;
    try { url = new URL(String(value || DEFAULT_BASE).trim()); }
    catch (_) { throw fail('Укажите полный адрес API, например http://127.0.0.1:8000/api/v1.'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('Адрес API должен начинаться с http:// или https:// и не содержать пароль, параметры или #.');
    return url.href.replace(/\/+$/, '');
  }
  let config = read('localStorage', 'settings', { baseUrl: DEFAULT_BASE });
  try { config = { mode: 'api', baseUrl: normalBase(config && config.baseUrl) }; }
  catch (_) { config = { mode: 'api', baseUrl: DEFAULT_BASE }; }
  function mode() { return 'api'; }
  function settings() { return { ...config }; }
  function clearAuth() { generation++; remove('sessionStorage', 'tokens'); }
  function configure(options) {
    const next = normalBase(options && options.baseUrl || config.baseUrl);
    if (next !== config.baseUrl) { clearAuth(); aiTimeoutMs = 10000; }
    config = { mode: 'api', baseUrl: next };
    write('localStorage', 'settings', config);
    return settings();
  }
  function endpoint(path) {
    const base = new URL(config.baseUrl + '/');
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) throw fail('Сервер вернул ссылку за пределами настроенного API. Запрос отменён.');
    return url.href;
  }
  function errorText(body, fallback) {
    if (typeof body === 'string') return body.slice(0, 400) || fallback;
    if (!body || typeof body !== 'object') return fallback;
    if (body.error && typeof body.error.message === 'string') return body.error.message;
    if (body.detail || body.error) return String(body.detail || body.error);
    return Object.entries(body).map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join(' ') : typeof value === 'object' ? JSON.stringify(value) : value)).join('\n').slice(0, 800) || fallback;
  }
  async function raw(path, options, authenticated) {
    const opts = options || {};
    const url = endpoint(path);
    const headers = new Headers(opts.headers || {});
    const tokens = read('sessionStorage', 'tokens', null) || {};
    if (authenticated && tokens.access) headers.set('Authorization', 'Bearer ' + tokens.access);
    let body = opts.body;
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(body); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || (multipart ? 120000 : 30000));
    try {
      const response = await fetch(url, { method: opts.method || 'GET', headers, body, signal: controller.signal, credentials: 'omit', redirect: 'error' });
      const text = await response.text();
      let data = null;
      let validJson = true;
      try { data = text ? JSON.parse(text) : null; } catch (_) { validJson = false; }
      if (!response.ok) throw fail(errorText(data, 'Ошибка сервера (' + response.status + ').'), response.status, data);
      if (!validJson) throw fail('API вернул ответ не в формате JSON. Проверьте адрес сервера.', response.status);
      return data;
    } catch (error) {
      if (error.status !== undefined) throw error;
      if (error.name === 'AbortError') throw fail('Сервер не ответил вовремя. Попробуйте ещё раз.');
      throw fail('Не удалось подключиться к API. Проверьте адрес, доступность сервера и разрешение CORS для этой страницы.');
    } finally { clearTimeout(timeout); }
  }
  async function refresh() {
    if (refreshFlight && refreshFlight.generation === generation) return refreshFlight.promise;
    const started = generation;
    const token = (read('sessionStorage', 'tokens', null) || {}).refresh;
    if (!token) throw fail('Сессия завершена. Войдите снова.', 401);
    const flight = { generation: started, promise: null };
    flight.promise = (async () => {
      try {
        const data = await raw('auth/token/refresh/', { method: 'POST', body: { refresh: token } }, false);
        if (started !== generation) throw fail('Сессия изменена. Войдите снова.', 401);
        if (!data || !data.access) throw fail('Сервер не вернул токен доступа.', 401);
        write('sessionStorage', 'tokens', { access: data.access, refresh: data.refresh || token });
      } catch (error) {
        if (started === generation && error.status === 401) remove('sessionStorage', 'tokens');
        throw error;
      } finally { if (refreshFlight === flight) refreshFlight = null; }
    })();
    refreshFlight = flight;
    return flight.promise;
  }
  async function request(path, options) {
    const started = generation;
    const originalAccess = (read('sessionStorage', 'tokens', null) || {}).access;
    try {
      const result = await raw(path, options, true);
      if (started !== generation) throw fail('Сессия изменилась. Повторите действие.', 401);
      return result;
    } catch (error) {
      if (error.status !== 401 || started !== generation) throw error;
      const currentAccess = (read('sessionStorage', 'tokens', null) || {}).access;
      if (!currentAccess || currentAccess === originalAccess) await refresh();
      if (started !== generation) throw fail('Сессия изменилась. Войдите снова.', 401);
      try {
        const result = await raw(path, options, true);
        if (started !== generation) throw fail('Сессия изменилась. Повторите действие.', 401);
        return result;
      } catch (retryError) { if (retryError.status === 401 && started === generation) remove('sessionStorage', 'tokens'); throw retryError; }
    }
  }
  async function collection(path) {
    const result = [];
    const visited = new Set();
    const started = generation;
    let next = path;
    while (next) {
      if (started !== generation) throw fail('Сессия изменилась. Обновите страницу.', 401);
      const url = endpoint(next);
      if (visited.has(url) || visited.size >= 100) throw fail('Не удалось прочитать список: некорректная пагинация API.');
      visited.add(url);
      const data = await request(url);
      if (Array.isArray(data)) return result.concat(data);
      if (!data || !Array.isArray(data.results)) throw fail('API вернул список в неожиданном формате.');
      result.push(...data.results);
      next = data.next ? new URL(data.next, url).href : null;
    }
    return result;
  }
  function validId(id) {
    if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw fail('Некорректный идентификатор.');
    return Number(id);
  }
  function credentials(email, password, registration) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())) throw fail('Введите корректный адрес электронной почты.');
    if (!password || (registration && password.length < 8)) throw fail(registration ? 'Пароль должен содержать не менее 8 символов.' : 'Введите пароль.');
  }
  async function me() {
    const tokens = read('sessionStorage', 'tokens', null) || {};
    if (!tokens.access && !tokens.refresh) return null;
    try { return await request('accounts/me/'); }
    catch (error) { if (error.status === 401) return null; throw error; }
  }
  async function login(email, password) {
    credentials(email, password, false);
    clearAuth();
    const started = generation;
    const tokens = await raw('auth/token/', { method: 'POST', body: { email: String(email).trim(), password } }, false);
    if (started !== generation) throw fail('Вход отменён: настройки сессии изменились.');
    if (!tokens || !tokens.access || !tokens.refresh) throw fail('API не вернул токены авторизации.');
    write('sessionStorage', 'tokens', { access: tokens.access, refresh: tokens.refresh });
    const user = await me();
    if (!user) { clearAuth(); throw fail('Не удалось подтвердить сессию. Войдите снова.', 401); }
    return user;
  }
  async function register(input) {
    credentials(input.email, input.password, true);
    const started = generation;
    await raw('auth/register/', { method: 'POST', body: { email: input.email.trim(), password: input.password, display_name: String(input.display_name || '').trim() } }, false);
    if (started !== generation) throw fail('Аккаунт создан, но сессия изменилась. Войдите самостоятельно.');
    try { return await login(input.email, input.password); }
    catch (error) { throw fail('Аккаунт создан, но автоматический вход не удался. Попробуйте войти. ' + error.message, error.status); }
  }
  async function logout() { clearAuth(); }
  async function courses() { return collection('courses/'); }
  async function lessons(courseId) { return collection('courses/' + validId(courseId) + '/lessons/'); }
  async function exercises(courseId, lessonId) { return collection('courses/' + validId(courseId) + '/lessons/' + validId(lessonId) + '/exercises/'); }
  async function progress() { return collection('progress/'); }
  async function dashboard() { return request('progress/dashboard/'); }
  async function attempts() { return collection('progress/attempts/'); }
  async function submitAttempt(exercise, answer) {
    const id = validId(typeof exercise === 'object' && exercise ? exercise.id : exercise);
    const text = String(answer || '').trim();
    if (!text) throw fail('Напишите ответ перед отправкой.');
    return request('progress/attempts/', { method: 'POST', body: { exercise: id, answer: text }, timeoutMs: Math.max(30000, aiTimeoutMs) });
  }
  async function documents() { return collection('documents/'); }
  async function uploadDocument(file) {
    if (!file || !file.name || typeof file.size !== 'number') throw fail('Выберите файл для загрузки.');
    const ext = file.name.toLowerCase().match(/\.[^.]+$/);
    if (!ext || !['.pdf', '.docx', '.pptx', '.txt'].includes(ext[0])) throw fail('Поддерживаются только PDF, DOCX, PPTX и TXT.');
    if (file.size > 20 * 1024 * 1024) throw fail('Максимальный размер файла — 20 МБ.');
    const body = new FormData();
    body.append('file', file);
    return request('documents/', { method: 'POST', body });
  }
  async function deleteDocument(id) { return request('documents/' + validId(id) + '/', { method: 'DELETE' }); }
  async function documentDetail(id) { return request('documents/' + validId(id) + '/'); }
  async function generateStudyPack(id, body) {
    return request('documents/' + validId(id) + '/generate/', { method: 'POST', body });
  }
  async function studyPacks() { return collection('documents/packs/'); }
  function packPath(id) { return 'documents/packs/' + validId(id) + '/'; }
  async function studyPack(id) { return request(packPath(id)); }
  async function studyHint(id, question_id) {
    return request(packPath(id) + 'hints/', { method: 'POST', body: { question_id } });
  }
  async function studyAttempt(id, body) {
    return request(packPath(id) + 'attempts/', { method: 'POST', body });
  }
  let aiTimeoutMs = 10000;
  async function tutorStatus() { return request('tutor/status/'); }
  async function tutorAsk(body) { return request('tutor/ask/', {method:'POST',body,timeoutMs:aiTimeoutMs}); }
  async function tutorContext(courseId,lessonId) {
    const started = generation;
    const context = await request('tutor/context/?course_id='+validId(courseId)+'&lesson_id='+validId(lessonId));
    if (started === generation) aiTimeoutMs = Number.isInteger(context.timeout_ms) && context.timeout_ms >= 10000 && context.timeout_ms <= 80000 ? context.timeout_ms : 10000;
    return context;
  }
  global.LAT = Object.freeze({ mode, configure, settings, me, login, register, logout, courses, lessons, exercises, dashboard, attempts, submitAttempt, documents, uploadDocument, deleteDocument, documentDetail, generateStudyPack, studyPacks, studyPack, studyHint, studyAttempt, progress, tutorAsk, tutorContext, tutorStatus });
})(window);
