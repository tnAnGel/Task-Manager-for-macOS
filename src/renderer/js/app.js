// app.js — TM.app bootstrap + router + poll loop.
// Owns the sidebar, view switching, and the 1500ms metrics poll. Classic script.
window.TM = window.TM || {};

(function () {
  'use strict';

  var POLL_MS = 1500;
  var UPDATE_DEBOUNCE_MS = 120;

  // Sidebar order: Processes, Performance, Startup apps, Users, Details, Services.
  var VIEW_ORDER = ['processes', 'performance', 'startup', 'users', 'details', 'services'];
  var DEFAULT_VIEW = 'processes';

  // Fallback icons in case a view module forgot to provide one (keeps sidebar from breaking).
  var FALLBACK_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4">' +
    '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/></svg>';
  var HAMBURGER_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
    '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';

  TM.app = {
    started: false,
    _views: {},          // id -> view module
    _current: null,      // currently mounted view module
    _navItems: {},       // id -> sidebar <button> element
    _pollTimer: null,
    _pollInFlight: false,
    _stopped: false,
    _unsubState: null,
    _updateTimer: null,
    _contentEl: null,
    _sidebarEl: null,
  };

  // ---- helpers -------------------------------------------------------------

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function getViews() {
    var registered = (TM.views) || {};
    var ordered = [];
    for (var i = 0; i < VIEW_ORDER.length; i++) {
      var id = VIEW_ORDER[i];
      var v = registered[id];
      if (v && typeof v.mount === 'function') {
        v.id = v.id || id;
        ordered.push(v);
      }
    }
    return ordered;
  }

  // ---- sidebar -------------------------------------------------------------

  function buildSidebar(sidebarEl, views) {
    sidebarEl.innerHTML = '';
    TM.app._navItems = {};

    // Top: hamburger toggle (expands/collapses the rail).
    var top = el('div', 'sidebar-top');
    var hamburger = el('button', 'sidebar-item sidebar-hamburger');
    hamburger.type = 'button';
    hamburger.title = 'Expand';
    hamburger.setAttribute('aria-label', 'Toggle navigation');
    hamburger.appendChild(el('span', 'icon', HAMBURGER_ICON));
    hamburger.addEventListener('click', function () {
      var expanded = sidebarEl.classList.toggle('expanded');
      hamburger.title = expanded ? 'Collapse' : 'Expand';
    });
    top.appendChild(hamburger);

    // Nav items.
    var nav = el('div', 'sidebar-nav');
    for (var i = 0; i < views.length; i++) {
      (function (view) {
        var item = el('button', 'sidebar-item');
        item.type = 'button';
        item.dataset.view = view.id;
        item.title = view.title || view.id;
        item.setAttribute('aria-label', view.title || view.id);
        item.appendChild(el('span', 'icon', view.icon || FALLBACK_ICON));
        item.appendChild(el('span', 'label', escapeText(view.title || view.id)));
        item.addEventListener('click', function () { switchView(view.id); });
        nav.appendChild(item);
        TM.app._navItems[view.id] = item;
      })(views[i]);
    }

    sidebarEl.appendChild(top);
    sidebarEl.appendChild(nav);
  }

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setActiveNav(id) {
    for (var key in TM.app._navItems) {
      if (!Object.prototype.hasOwnProperty.call(TM.app._navItems, key)) continue;
      var item = TM.app._navItems[key];
      if (key === id) item.classList.add('active');
      else item.classList.remove('active');
    }
  }

  // ---- view router ---------------------------------------------------------

  function switchView(id) {
    var next = TM.app._views[id];
    if (!next) return;
    if (TM.app._current && TM.app._current.id === id) return;

    var content = TM.app._contentEl;

    // Unmount the previous view (optional hook).
    if (TM.app._current && typeof TM.app._current.unmount === 'function') {
      try { TM.app._current.unmount(); } catch (e) { logErr('unmount ' + TM.app._current.id, e); }
    }

    // Clear content surface.
    if (content) content.innerHTML = '';

    TM.app._current = next;

    try {
      next.mount(content);
    } catch (e) {
      logErr('mount ' + id, e);
      if (content) {
        content.innerHTML = '';
        content.appendChild(el('div', 'view-error',
          'Failed to load "' + escapeText(next.title || id) + '".'));
      }
    }

    setActiveNav(id);

    // Record active view in central state.
    try { TM.state.set({ ui: { view: id } }); } catch (e) {}

    // Push the freshest data we already have into the newly mounted view.
    runUpdate();
  }

  // ---- update / poll -------------------------------------------------------

  function runUpdate() {
    var view = TM.app._current;
    if (!view || typeof view.update !== 'function') return;
    try {
      view.update(TM.state);
    } catch (e) {
      logErr('update ' + view.id, e);
    }
  }

  function scheduleUpdate() {
    // Debounce rapid ui changes (search typing, sort clicks) into one update.
    if (TM.app._updateTimer) return;
    TM.app._updateTimer = setTimeout(function () {
      TM.app._updateTimer = null;
      runUpdate();
    }, UPDATE_DEBOUNCE_MS);
  }

  function poll() {
    if (TM.app._stopped || TM.app._pollInFlight) return;
    TM.app._pollInFlight = true;

    var pProcs = safeCall(function () { return window.api.listProcesses(); });
    var pStats = safeCall(function () { return window.api.getSystemStats(); });

    Promise.all([pProcs, pStats]).then(function (results) {
      var processes = results[0];
      var stats = results[1];

      try {
        var partial = { data: {} };
        if (Array.isArray(processes)) partial.data.processes = processes;
        if (stats) partial.data.stats = stats;
        TM.state.set(partial);
      } catch (e) {
        logErr('state.set(poll)', e);
      }

      if (stats) {
        try { TM.state.pushHistory(stats); } catch (e) { logErr('pushHistory', e); }
      }

      runUpdate();
    }).catch(function (e) {
      // A failed poll must never stop the loop.
      logErr('poll', e);
    }).then(function () {
      TM.app._pollInFlight = false;
    });
  }

  function safeCall(fn) {
    try {
      var r = fn();
      return (r && typeof r.then === 'function') ? r.catch(function (e) {
        logErr('api', e);
        return null;
      }) : Promise.resolve(r);
    } catch (e) {
      logErr('api(sync)', e);
      return Promise.resolve(null);
    }
  }

  function startPolling() {
    if (TM.app._pollTimer) return;
    TM.app._stopped = false;
    poll(); // immediate first fetch
    TM.app._pollTimer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    TM.app._stopped = true;
    if (TM.app._pollTimer) {
      clearInterval(TM.app._pollTimer);
      TM.app._pollTimer = null;
    }
  }

  function logErr(where, e) {
    try { console.error('[TM.app] ' + where + ':', e); } catch (_) {}
  }

  // ---- bootstrap -----------------------------------------------------------

  function boot() {
    if (TM.app.started) return;
    TM.app.started = true;

    var titlebarEl = document.getElementById('titlebar');
    var sidebarEl = document.getElementById('sidebar');
    var contentEl = document.getElementById('content');

    TM.app._sidebarEl = sidebarEl;
    TM.app._contentEl = contentEl;

    // Mount custom titlebar (search box + window controls).
    try {
      if (TM.components && TM.components.titlebar && typeof TM.components.titlebar.mount === 'function') {
        TM.components.titlebar.mount(titlebarEl);
      }
    } catch (e) {
      logErr('titlebar.mount', e);
    }

    // Collect & order the registered views, build the sidebar.
    var views = getViews();
    TM.app._views = {};
    for (var i = 0; i < views.length; i++) TM.app._views[views[i].id] = views[i];

    try {
      buildSidebar(sidebarEl, views);
    } catch (e) {
      logErr('buildSidebar', e);
    }

    // Subscribe to state so ui changes (search/sort) trigger an immediate update.
    // Skip ticks where the only thing that changed is the active view id (handled by switchView).
    try {
      TM.app._unsubState = TM.state.subscribe(function () {
        scheduleUpdate();
      });
    } catch (e) {
      logErr('state.subscribe', e);
    }

    // Pick the default (or last-remembered) view and mount it.
    var initial = DEFAULT_VIEW;
    try {
      if (TM.state.ui && TM.state.ui.view && TM.app._views[TM.state.ui.view]) {
        initial = TM.state.ui.view;
      }
    } catch (e) {}
    if (!TM.app._views[initial]) {
      initial = views.length ? views[0].id : null;
    }
    if (initial) switchView(initial);

    // Begin the metrics poll loop (does an immediate first fetch).
    startPolling();

    // Pause polling while the window is hidden to save work; resume on focus.
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          stopPolling();
        } else if (!TM.app._pollTimer) {
          startPolling();
        }
      });
    } catch (e) {}

    window.addEventListener('beforeunload', function () {
      stopPolling();
      if (TM.app._unsubState) { try { TM.app._unsubState(); } catch (_) {} }
    });
  }

  // Public API.
  TM.app.start = boot;
  TM.app.switchView = switchView;
  TM.app.refresh = poll;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
