/* Apply saved theme before styles paint. Preferences belong to this browser. */
(() => {
  'use strict';
  const key = 'lat-ai-theme';
  let theme = 'light';
  try { if (localStorage.getItem(key) === 'dark') theme = 'dark'; } catch {}
  function apply() {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#14231f' : '#23483E';
    window.dispatchEvent(new Event('lat:appearance-change'));
  }
  function configure(value) {
    if (value !== 'light' && value !== 'dark') return;
    theme = value;
    try { localStorage.setItem(key, theme); } catch {}
    apply();
  }
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    theme = event.newValue === 'dark' ? 'dark' : 'light';
    apply();
  });
  window.LATAppearance = Object.freeze({configure, settings: () => ({theme})});
  apply();
})();
