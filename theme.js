// Theme switch: default dark, persisted in localStorage.
(function () {
  var KEY = 'ms.theme';

  function label(theme) {
    return theme === 'light' ? '暗色' : '亮色';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) buttons[i].textContent = label(theme);
  }

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  apply(saved === 'dark' ? 'dark' : 'light');

  // The <html> attribute is set above before first paint; wire the click lazily
  // because the button may not be parsed yet when this script runs in <head>.
  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('[data-theme-toggle]') : null;
    if (!btn) return;
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
  });
})();
