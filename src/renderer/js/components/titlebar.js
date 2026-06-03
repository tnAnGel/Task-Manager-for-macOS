// titlebar.js — TM.components.titlebar
// Custom frameless titlebar: draggable header with a left app
// title + icon, a centered search box, and right-aligned window controls.
// macOS note: native traffic lights are hidden in main.js, so we place the
// min/max/close buttons on the RIGHT to match the Windows 11 layout.
window.TM = window.TM || {};
TM.components = TM.components || {};

(function () {
  'use strict';

  // 16x16 inline SVGs (currentColor). Window control glyphs mimic Win11 (10x10 box).
  var ICON_APP =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">' +
    '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/>' +
    '<rect x="3.4" y="5.2" width="3.2" height="6.2" rx="0.6" fill="currentColor"/>' +
    '<rect x="7.4" y="7.4" width="3.2" height="4" rx="0.6" fill="currentColor"/>' +
    '<rect x="3.4" y="5.2" width="0" height="0"/>' +
    '</svg>';

  var ICON_SEARCH =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.3"/>' +
    '<line x1="10.2" y1="10.2" x2="13.5" y2="13.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</svg>';

  var ICON_MIN =
    '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
    '<line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1"/></svg>';

  var ICON_MAX =
    '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true">' +
    '<rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1"/></svg>';

  var ICON_CLOSE =
    '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
    '<line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.1"/>' +
    '<line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" stroke-width="1.1"/></svg>';

  function injectStyles() {
    if (document.getElementById('tm-titlebar-styles')) return;
    var css =
      '#titlebar{' +
        'display:flex;align-items:center;height:var(--titlebar-h);' +
        'background:var(--bg-titlebar);color:var(--text-primary);' +
        'font-family:var(--font-ui);font-size:var(--fs-md);' +
        'border-bottom:1px solid var(--border);' +
        // leave room on the LEFT for the native macOS traffic lights.
        'padding:0 var(--sp-4) 0 84px;position:relative;' +
        'user-select:none;-webkit-user-select:none;' +
        '-webkit-app-region:drag;' +
      '}' +
      '.tm-tb-brand{' +
        'display:flex;align-items:center;gap:var(--sp-2);' +
        'color:var(--text-secondary);flex:0 0 auto;' +
        'min-width:150px;' +
      '}' +
      '.tm-tb-brand .tm-tb-icon{display:inline-flex;color:var(--accent);}' +
      '.tm-tb-title{' +
        'font-size:var(--fs-md);font-weight:var(--fw-semibold);' +
        'color:var(--text-secondary);white-space:nowrap;' +
      '}' +
      // Absolutely centered in the window so it stays centered regardless of
      // the brand width (there are no right-side controls anymore).
      '.tm-tb-search-wrap{' +
        'position:absolute;left:0;right:0;top:0;bottom:0;' +
        'display:flex;align-items:center;justify-content:center;' +
        'pointer-events:none;' +
      '}' +
      '.tm-tb-search{' +
        'position:relative;display:flex;align-items:center;' +
        'width:min(420px,46vw);height:28px;pointer-events:auto;' +
        '-webkit-app-region:no-drag;' +
      '}' +
      '.tm-tb-search .tm-tb-search-ico{' +
        'position:absolute;left:8px;top:50%;transform:translateY(-50%);' +
        'display:inline-flex;color:var(--text-tertiary);pointer-events:none;' +
      '}' +
      '.tm-tb-search input{' +
        'width:100%;height:28px;box-sizing:border-box;' +
        'padding:0 28px 0 28px;' +
        'background:var(--bg-input);color:var(--text-primary);' +
        'border:1px solid var(--border-subtle);border-radius:var(--r-sm);' +
        'font-family:var(--font-ui);font-size:var(--fs-sm);' +
        'outline:none;' +
      '}' +
      '.tm-tb-search input::placeholder{color:var(--text-tertiary);}' +
      '.tm-tb-search input:hover{background:#3a3a3a;}' +
      '.tm-tb-search input:focus{' +
        'border-color:var(--focus-ring);' +
        'box-shadow:0 1px 0 0 var(--accent);' +
      '}' +
      '.tm-tb-search-clear{' +
        'position:absolute;right:4px;top:50%;transform:translateY(-50%);' +
        'display:none;align-items:center;justify-content:center;' +
        'width:20px;height:20px;padding:0;border:0;cursor:default;' +
        'background:transparent;color:var(--text-tertiary);' +
        'border-radius:var(--r-sm);font-size:14px;line-height:1;' +
        '-webkit-app-region:no-drag;' +
      '}' +
      '.tm-tb-search-clear:hover{background:var(--row-hover);color:var(--text-primary);}' +
      '.tm-tb-search.has-text .tm-tb-search-clear{display:inline-flex;}' +
      '.tm-tb-controls{' +
        'flex:0 0 auto;display:flex;align-items:stretch;height:100%;' +
        '-webkit-app-region:no-drag;' +
      '}' +
      '.tm-tb-btn{' +
        'display:inline-flex;align-items:center;justify-content:center;' +
        'width:46px;height:var(--titlebar-h);padding:0;border:0;' +
        'background:transparent;color:var(--text-secondary);' +
        'cursor:default;outline:none;' +
        'transition:background-color .08s ease,color .08s ease;' +
      '}' +
      '.tm-tb-btn:hover{background:var(--row-hover);color:var(--text-primary);}' +
      '.tm-tb-btn:active{background:var(--border-subtle);}' +
      '.tm-tb-btn.tm-tb-close:hover{background:#c42b1c;color:#ffffff;}' +
      '.tm-tb-btn.tm-tb-close:active{background:#b0271a;color:#ffffff;}';

    var style = document.createElement('style');
    style.id = 'tm-titlebar-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function safeWin(method) {
    try {
      if (window.api && window.api.win && typeof window.api.win[method] === 'function') {
        var r = window.api.win[method]();
        if (r && typeof r.catch === 'function') r.catch(function () {});
      }
    } catch (e) {
      // Never let a window-control failure crash the renderer.
    }
  }

  function setSearch(value) {
    try {
      TM.state = TM.state || {};
      TM.state.ui = TM.state.ui || {};
      TM.state.ui.search = value;
      if (TM.state && typeof TM.state.emit === 'function') {
        TM.state.emit();
      }
    } catch (e) {
      // ignore — search is non-critical
    }
  }

  TM.components.titlebar = {
    el: null,
    input: null,

    mount: function (el) {
      try {
        el = el || document.getElementById('titlebar');
        if (!el) return;
        this.el = el;

        injectStyles();
        el.innerHTML = '';

        // ---- Left: brand ----
        var brand = document.createElement('div');
        brand.className = 'tm-tb-brand';
        var icon = document.createElement('span');
        icon.className = 'tm-tb-icon';
        icon.innerHTML = ICON_APP;
        var title = document.createElement('span');
        title.className = 'tm-tb-title';
        title.textContent = 'Task Manager';
        brand.appendChild(icon);
        brand.appendChild(title);

        // ---- Center: search ----
        var searchWrap = document.createElement('div');
        searchWrap.className = 'tm-tb-search-wrap';
        var search = document.createElement('div');
        search.className = 'tm-tb-search';

        var sIco = document.createElement('span');
        sIco.className = 'tm-tb-search-ico';
        sIco.innerHTML = ICON_SEARCH;

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'tm-tb-search-input';
        input.placeholder = 'Type a name, publisher, or PID to search';
        input.setAttribute('aria-label', 'Search processes');
        input.autocomplete = 'off';
        input.spellcheck = false;
        this.input = input;

        var clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'tm-tb-search-clear';
        clear.title = 'Clear search';
        clear.setAttribute('aria-label', 'Clear search');
        clear.textContent = '✕';

        // sync initial value from state if any
        try {
          if (TM.state && TM.state.ui && TM.state.ui.search) {
            input.value = TM.state.ui.search;
          }
        } catch (e) {}
        if (input.value) search.classList.add('has-text');

        var updateClearVisibility = function () {
          if (input.value) search.classList.add('has-text');
          else search.classList.remove('has-text');
        };

        input.addEventListener('input', function () {
          updateClearVisibility();
          setSearch(input.value);
        });
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape' && input.value) {
            ev.stopPropagation();
            input.value = '';
            updateClearVisibility();
            setSearch('');
          }
        });
        clear.addEventListener('click', function () {
          input.value = '';
          updateClearVisibility();
          setSearch('');
          input.focus();
        });

        search.appendChild(sIco);
        search.appendChild(input);
        search.appendChild(clear);
        searchWrap.appendChild(search);

        // No custom window controls: macOS draws native traffic lights
        // (close / minimize / zoom) on the left via titleBarStyle:'hidden'.
        el.appendChild(brand);
        el.appendChild(searchWrap);
      } catch (e) {
        try { console.error('titlebar.mount failed', e); } catch (_) {}
      }
    },

    // Optional: focus the search box (e.g. on Ctrl/Cmd+F from app.js).
    focusSearch: function () {
      if (this.input) {
        try { this.input.focus(); this.input.select(); } catch (e) {}
      }
    }
  };
})();
