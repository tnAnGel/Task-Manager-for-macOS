// icons.js — TM.icons: lazy, cached app-icon loader shared by the process views.
// The main process returns each app's icon as a data URL (see actions.appIconDataUrl).
// Rows render <img class="app-icon" data-icon-path="<bundle>"> and we fill src when
// it loads, so a full table re-render isn't needed and 700 rows don't each refetch.
window.TM = window.TM || {};

(function () {
  'use strict';

  var cache = {};    // path -> dataURL ('' = known to have none)
  var pending = {};

  function applyTo(path, url) {
    if (!url) return;
    var key;
    try {
      key = (window.CSS && CSS.escape) ? CSS.escape(path) : path.replace(/"/g, '\\"');
    } catch (e) { return; }
    var imgs = document.querySelectorAll('img.app-icon[data-icon-path="' + key + '"]');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].src = url;
      imgs[i].classList.add('loaded');
    }
  }

  TM.icons = {
    // Synchronous cache lookup: dataURL, '' (no icon), or undefined (not fetched).
    cached: function (path) { return cache[path]; },

    // Kick off a fetch (no-op if cached/in-flight); fills matching <img> on load.
    request: function (path) {
      if (!path) return;
      if (path in cache || pending[path]) return;
      if (!window.api || typeof window.api.getAppIcon !== 'function') {
        cache[path] = '';
        return;
      }
      pending[path] = true;
      window.api.getAppIcon(path)
        .then(function (url) {
          cache[path] = url || '';
          delete pending[path];
          applyTo(path, url);
        })
        .catch(function () { cache[path] = ''; delete pending[path]; });
    },
  };
})();
