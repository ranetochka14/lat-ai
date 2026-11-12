/* Gentle interaction feedback. Independent of API, navigation and form submission. */
(() => {
  'use strict';
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const preferenceKey = 'lat-ai-motion';
  const modes = ['auto', 'full', 'reduced'];
  let mode = 'auto';
  try { const saved = localStorage.getItem(preferenceKey); if (modes.includes(saved)) mode = saved; } catch {}
  const reduceMotion = () => mode === 'reduced' || (mode === 'auto' && preference.matches);
  const animations = new Set();
  const pressed = new Map();
  let navObserver = null;
  let dialogAnimations = [];
  let dialogVersion = 0;
  let closingDialog = null;
  const controlSelector = 'button, .button, .friendly-nav > a, .lesson-sidebar > a, .friendly-doc-row[href], .friendly-answer-row[href], .friendly-tutor, .course-card, .lesson-row';

  function animate(element, frames, options) {
    if (!element || reduceMotion() || !element.animate) return null;
    const animation = element.animate(frames, {duration: 280, easing: 'cubic-bezier(.2,.75,.25,1)', ...options});
    animations.add(animation);
    animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
    return animation;
  }
  function ripple(control, event) {
    if (reduceMotion() || !control.isConnected) return;
    const rect = control.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dot = document.createElement('span');
    dot.className = 'lat-ripple';
    dot.setAttribute('aria-hidden', 'true');
    const pageZoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const size = Math.hypot(rect.width, rect.height) * 2 / pageZoom;
    const pointer = event.type === 'pointerdown';
    dot.style.width = dot.style.height = size + 'px';
    dot.style.left = (pointer ? event.clientX - rect.left : rect.width / 2) / pageZoom + 'px';
    dot.style.top = (pointer ? event.clientY - rect.top : rect.height / 2) / pageZoom + 'px';
    if (getComputedStyle(control).position === 'static') control.classList.add('lat-ripple-static');
    control.classList.add('lat-ripple-host');
    control.append(dot);
    const pulse = animate(dot, [
      {transform: 'translate(-50%,-50%) scale(0)', opacity: .17},
      {transform: 'translate(-50%,-50%) scale(.65)', opacity: .10, offset: .6},
      {transform: 'translate(-50%,-50%) scale(1)', opacity: 0}
    ], {duration: 480, easing: 'cubic-bezier(.15,.6,.3,1)'});
    if (pulse) pulse.finished.then(() => dot.remove(), () => dot.remove());
    else dot.remove();
  }
  function getControl(event) {
    const control = event.target instanceof Element && event.target.closest(controlSelector);
    return control && !control.matches(':disabled, [aria-disabled="true"]') ? control : null;
  }
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const control = getControl(event);
    if (!control || reduceMotion()) return;
    pressed.set(event.pointerId, control);
    control.classList.add('lat-pressed');
    ripple(control, event);
  }, {passive: true});
  function release(event) {
    pressed.get(event.pointerId)?.classList.remove('lat-pressed');
    pressed.delete(event.pointerId);
  }
  document.addEventListener('pointerup', release, {passive: true});
  document.addEventListener('pointercancel', release, {passive: true});
  window.addEventListener('blur', () => { pressed.forEach(el => el.classList.remove('lat-pressed')); pressed.clear(); });
  // Native click from Enter/Space receives the same feedback without a second action.
  document.addEventListener('click', event => {
    if (event.detail !== 0) return;
    const control = getControl(event);
    if (!control) return;
    ripple(control, event);
    animate(control, [{scale: '1'}, {scale: '.97', offset: .35}, {scale: '1'}], {duration: 230});
  }, true);

  function snapshot() {
    const pill = document.querySelector('.lat-nav-pill');
    const active = document.querySelector('.friendly-nav > a[aria-current="page"]');
    return active ? {href: active.getAttribute('href'), rect: (pill || active).getBoundingClientRect()} : null;
  }
  function shell(previous) {
    navObserver?.disconnect();
    const nav = document.querySelector('.friendly-nav');
    const active = nav?.querySelector('a[aria-current="page"]');
    if (!nav || !active) return;
    nav.classList.add('lat-nav-ready');
    const pill = document.createElement('span');
    pill.className = 'lat-nav-pill';
    pill.setAttribute('aria-hidden', 'true');
    nav.prepend(pill);
    function position() {
      pill.style.top = active.offsetTop + 'px';
      pill.style.left = active.offsetLeft + 'px';
      pill.style.width = active.offsetWidth + 'px';
      pill.style.height = active.offsetHeight + 'px';
    }
    position();
    const now = pill.getBoundingClientRect();
    const pageZoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
    if (previous && previous.href !== active.getAttribute('href') && now.width && window.innerWidth > 740) {
      animate(pill, [
        {transform: `translateY(${(previous.rect.top - now.top) / pageZoom}px)`, opacity: .85},
        {transform: 'translateY(0)', opacity: 1}
      ], {duration: 340});
    }
    // Follow responsive dimensions; disconnect as soon as the router replaces this shell.
    if (window.ResizeObserver) {
      navObserver = new ResizeObserver(() => {
        if (!nav.isConnected) navObserver?.disconnect(); else position();
      });
      navObserver.observe(nav);
    }
  }
  function enter(main) {
    if (!main || reduceMotion()) return;
    animate(main, [{opacity: .25, transform: 'translateY(8px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: 260});
    const cards = main.querySelectorAll('.friendly-welcome, .friendly-course-card, .friendly-docs, .friendly-answers, .friendly-tutor, .course-card, .lesson-row, .panel, .auth-gate');
    [...cards].slice(0, 12).forEach((card, index) => {
      animate(card, [{opacity: 0, transform: 'translateY(12px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: 360, delay: Math.min(index, 5) * 35, fill: 'backwards'});
    });
    main.querySelectorAll('.progress-track > span').forEach(bar => {
      animate(bar, [{transform: 'scaleX(0)'}, {transform: 'scaleX(1)'}], {duration: 650, delay: 100, easing: 'cubic-bezier(.16,1,.3,1)'});
    });
  }
  function resetDialogMotion(element) {
    ++dialogVersion;
    dialogAnimations.forEach(animation => animation?.cancel());
    dialogAnimations = [];
    closingDialog = null;
    element.classList.remove('lat-modal-closing', 'lat-modal-resizing');
  }
  function dialog(element, {wasOpen = false, previousHeight = 0} = {}) {
    resetDialogMotion(element);
    if (reduceMotion()) return;
    const version = dialogVersion;
    const content = element.querySelector('.modal-content');
    if (wasOpen) {
      const height = element.offsetHeight;
      if (previousHeight && Math.abs(previousHeight - height) > 1) {
        element.classList.add('lat-modal-resizing');
        const resize = animate(element, [{height: previousHeight + 'px'}, {height: height + 'px'}], {duration: 320});
        dialogAnimations.push(resize);
        const restore = () => { if (version === dialogVersion) element.classList.remove('lat-modal-resizing'); };
        if (resize) resize.finished.then(restore, restore); else restore();
      }
      const direction = element.querySelector('[data-form="register"]') ? 1 : -1;
      dialogAnimations.push(animate(content, [
        {opacity: 0, transform: `translateX(${direction * 18}px)`},
        {opacity: 1, transform: 'translateX(0)'}
      ], {duration: 320}));
    } else {
      dialogAnimations.push(animate(element, [
        {opacity: 0, transform: 'translateY(40px) scale(.9)'},
        {opacity: 1, transform: 'translateY(0) scale(1)'}
      ], {duration: 600, easing: 'cubic-bezier(.22,.7,.25,1)'}));
      content?.querySelectorAll(':scope > .eyebrow, :scope > h2, :scope > .modal-intro, :scope > form, :scope > .modal-switch').forEach((part, index) => {
        dialogAnimations.push(animate(part, [
          {opacity: 0, transform: 'translateY(10px)'},
          {opacity: 1, transform: 'translateY(0)'}
        ], {duration: 360, delay: 100 + index * 45, fill: 'backwards'}));
      });
    }
  }
  function closeDialog(element) {
    if (!element.open) return Promise.resolve();
    if (closingDialog) return closingDialog;
    const current = getComputedStyle(element);
    const start = {opacity: current.opacity, transform: current.transform};
    resetDialogMotion(element);
    const version = dialogVersion;
    element.classList.add('lat-modal-closing');
    const exit = animate(element, [start, {opacity: 0, transform: 'translateY(14px) scale(.97)'}], {duration: 180, easing: 'ease-in'});
    dialogAnimations.push(exit);
    const finish = () => {
      if (version !== dialogVersion) return;
      element.close();
      element.classList.remove('lat-modal-closing');
      closingDialog = null;
    };
    if (!exit) { finish(); return Promise.resolve(); }
    // A fresh open invalidates this completion, including cancelled exit animations.
    closingDialog = exit.finished.then(finish, finish);
    return closingDialog;
  }
  function applyPreference() {
    document.documentElement.dataset.motion = reduceMotion() ? 'reduced' : 'full';
    window.dispatchEvent(new Event('lat:motion-change'));
    if (!reduceMotion()) return;
    animations.forEach(animation => animation.cancel());
    pressed.forEach(el => el.classList.remove('lat-pressed'));
    pressed.clear();
    document.querySelectorAll('.lat-ripple').forEach(el => el.remove());
  }
  function settings() { return {mode, systemReduced: preference.matches}; }
  function configure(value) {
    if (!modes.includes(value)) return;
    mode = value;
    try { localStorage.setItem(preferenceKey, mode); } catch {}
    applyPreference();
  }
  preference.addEventListener('change', applyPreference);
  window.addEventListener('storage', event => {
    if (event.key !== preferenceKey && event.key !== null) return;
    mode = modes.includes(event.newValue) ? event.newValue : 'auto';
    applyPreference();
  });
  applyPreference();
  window.LATMotion = Object.freeze({snapshot, shell, enter, dialog, closeDialog, settings, configure});
})();
