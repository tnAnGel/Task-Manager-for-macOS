// services.js — TM.views.services.
// Classic script, no modules. Attaches to the shared global TM namespace.
// Table of ServiceItem from window.api.getServices():
//   columns: Name (label) | PID | Status (running/stopped pill).
// Searchable via TM.state.ui.search. Fetch in mount, cache, refresh on update
// (throttled). Right-click -> Start/Stop via window.api.toggleService(label,on).
window.TM = window.TM || {};
TM.views = TM.views || {};

(function () {
  'use strict';

  var TM = window.TM;

  // Throttle interval for background refreshes off the poll tick (ms).
  var REFRESH_MS = 4000;

  // ---- View-local state -------------------------------------------------
  var el = null;          // root container element
  var tbodyEl = null;     // <tbody> we render rows into
  var countEl = null;     // "N services" count label
  var emptyEl = null;     // empty-state element
  var services = [];      // cached ServiceItem[]
  var lastFetch = 0;      // timestamp of last successful/attempted fetch
  var fetching = false;   // in-flight guard
  var lastSearch = null;  // last search string we rendered with
  var lastSig = null;     // signature of last-rendered service data (skip no-op re-renders)
  var menuRow = null;     // <tr> currently showing a context menu (for highlight)

  // ---- Helpers ----------------------------------------------------------

  function esc(s) {
    s = (s === null || s === undefined) ? '' : String(s);
    return s.replace(/[&<>"']/g, function (c) {
      switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default:  return '&#39;';
      }
    });
  }

  // Normalize a raw item from the IPC payload into a safe ServiceItem.
  function normalize(it) {
    if (!it || typeof it !== 'object') return null;
    var label = it.label === null || it.label === undefined ? '' : String(it.label);
    if (!label) return null;
    var pid = (typeof it.pid === 'number' && isFinite(it.pid)) ? it.pid : null;
    var status = it.status === 'running' ? 'running' : 'stopped';
    var type = it.type === 'system' ? 'system' : 'user';
    return { label: label, pid: pid, status: status, type: type };
  }

  // Compute the filtered + sorted list for the current search query.
  function visible() {
    var q = (TM.state && TM.state.ui && TM.state.ui.search ? TM.state.ui.search : '')
      .trim().toLowerCase();
    var list = services;
    if (q) {
      list = list.filter(function (s) {
        return s.label.toLowerCase().indexOf(q) !== -1;
      });
    }
    // Stable display order: running first, then by label (case-insensitive).
    return list.slice().sort(function (a, b) {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      var al = a.label.toLowerCase(), bl = b.label.toLowerCase();
      if (al < bl) return -1;
      if (al > bl) return 1;
      return 0;
    });
  }

  // Cheap signature so update() can skip identical re-renders.
  function signature(list) {
    var parts = new Array(list.length);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      parts[i] = s.label + '|' + (s.pid === null ? '' : s.pid) + '|' + s.status;
    }
    return parts.join('');
  }

  // ---- Data fetching ----------------------------------------------------

  function fetchServices(force) {
    if (fetching) return;
    var now = Date.now();
    if (!force && (now - lastFetch) < REFRESH_MS) return;
    if (!window.api || typeof window.api.getServices !== 'function') {
      lastFetch = now;
      render();
      return;
    }
    fetching = true;
    lastFetch = now;
    var p;
    try {
      p = window.api.getServices();
    } catch (err) {
      fetching = false;
      return;
    }
    Promise.resolve(p).then(function (list) {
      fetching = false;
      var out = [];
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i++) {
          var n = normalize(list[i]);
          if (n) out.push(n);
        }
      }
      services = out;
      // Force a render after fresh data even if signature matches (status flips).
      lastSig = null;
      if (el) render();
    }).catch(function (err) {
      fetching = false;
      if (typeof console !== 'undefined' && console.error) {
        console.error('TM.views.services getServices failed:', err);
      }
    });
  }

  // Optimistic local update after a toggle, then a forced refetch to confirm.
  function applyToggle(label, on) {
    if (!window.api || typeof window.api.toggleService !== 'function') return;
    // Optimistic: flip the cached status immediately for responsiveness.
    for (var i = 0; i < services.length; i++) {
      if (services[i].label === label) {
        services[i].status = on ? 'running' : 'stopped';
        if (!on) services[i].pid = null;
        break;
      }
    }
    lastSig = null;
    render();

    var p;
    try {
      p = window.api.toggleService(label, on);
    } catch (err) {
      fetchServices(true);
      return;
    }
    Promise.resolve(p).then(function (res) {
      if (res && res.ok === false && typeof console !== 'undefined' && console.warn) {
        console.warn('toggleService(' + label + ', ' + on + ') failed:',
          res.error || 'unknown error');
      }
    }).catch(function (err) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('toggleService error:', err);
      }
    }).then(function () {
      // Confirm actual state from the OS shortly after.
      lastFetch = 0;
      fetchServices(true);
    });
  }

  // ---- Context menu -----------------------------------------------------

  function showMenu(x, y, svc, rowEl) {
    if (!TM.components || !TM.components.contextMenu ||
        typeof TM.components.contextMenu.show !== 'function') {
      return;
    }
    menuRow = rowEl || null;
    if (menuRow) menuRow.classList.add('is-menu');

    var running = svc.status === 'running';
    var items = [
      {
        label: 'Start',
        disabled: running,
        onClick: function () { applyToggle(svc.label, true); }
      },
      {
        label: 'Stop',
        danger: true,
        disabled: !running,
        onClick: function () { applyToggle(svc.label, false); }
      }
    ];
    TM.components.contextMenu.show(x, y, items);
  }

  function clearMenuHighlight() {
    if (menuRow) {
      menuRow.classList.remove('is-menu');
      menuRow = null;
    }
  }

  // ---- Rendering --------------------------------------------------------

  function rowHtml(s) {
    var pidText = s.pid === null ? TM.format.dash : TM.format.count(s.pid);
    var pillClass = s.status === 'running' ? 'svc-pill svc-pill--running'
                                           : 'svc-pill svc-pill--stopped';
    var pillText = s.status === 'running' ? 'Running' : 'Stopped';
    return (
      '<tr class="svc-row" data-label="' + esc(s.label) + '">' +
        '<td class="svc-name" title="' + esc(s.label) + '">' + esc(s.label) + '</td>' +
        '<td class="svc-pid num">' + pidText + '</td>' +
        '<td class="svc-status">' +
          '<span class="' + pillClass + '">' + pillText + '</span>' +
        '</td>' +
      '</tr>'
    );
  }

  function render() {
    if (!el || !tbodyEl) return;
    var list = visible();
    var q = (TM.state && TM.state.ui && TM.state.ui.search ? TM.state.ui.search : '');
    var sig = signature(list);

    // Skip when nothing relevant changed (data + search query identical).
    if (sig === lastSig && q === lastSearch) return;
    lastSig = sig;
    lastSearch = q;
    clearMenuHighlight();

    // Count reflects total cached services (not just filtered), Win11-style.
    if (countEl) {
      var total = services.length;
      countEl.textContent = total + (total === 1 ? ' service' : ' services');
    }

    if (!list.length) {
      tbodyEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = services.length
          ? 'No services match "' + q + '".'
          : 'No services found.';
      }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    var html = '';
    for (var i = 0; i < list.length; i++) html += rowHtml(list[i]);
    tbodyEl.innerHTML = html;
  }

  // Find the cached service for a given <tr> by its data-label.
  function svcForRow(tr) {
    if (!tr) return null;
    var label = tr.getAttribute('data-label');
    if (label === null) return null;
    for (var i = 0; i < services.length; i++) {
      if (services[i].label === label) return services[i];
    }
    return null;
  }

  // ---- Event handlers (bound once in mount, delegated) ------------------

  function onContextMenu(e) {
    var tr = e.target && e.target.closest ? e.target.closest('tr.svc-row') : null;
    if (!tr) return;
    var svc = svcForRow(tr);
    if (!svc) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, svc, tr);
  }

  // ---- View interface ---------------------------------------------------

  TM.views.services = {
    id: 'services',
    title: 'Services',
    // Inline 16x16 gear/cog glyph, currentColor.
    icon:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path fill="currentColor" d="M8 5.25A2.75 2.75 0 1 0 8 10.75 2.75 2.75 0 0 0 8 5.25Zm0 1.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"/>' +
      '<path fill="currentColor" d="M6.94.75a.75.75 0 0 0-.74.63l-.2 1.23a5.4 5.4 0 0 0-1.06.61l-1.16-.46a.75.75 0 0 0-.92.33l-1.06 1.83a.75.75 0 0 0 .18.96l.97.78a5.5 5.5 0 0 0 0 1.22l-.97.78a.75.75 0 0 0-.18.96l1.06 1.83a.75.75 0 0 0 .92.33l1.16-.46c.33.25.69.45 1.06.61l.2 1.23a.75.75 0 0 0 .74.63h2.12a.75.75 0 0 0 .74-.63l.2-1.23c.37-.16.73-.36 1.06-.61l1.16.46a.75.75 0 0 0 .92-.33l1.06-1.83a.75.75 0 0 0-.18-.96l-.97-.78a5.5 5.5 0 0 0 0-1.22l.97-.78a.75.75 0 0 0 .18-.96l-1.06-1.83a.75.75 0 0 0-.92-.33l-1.16.46a5.4 5.4 0 0 0-1.06-.61l-.2-1.23a.75.75 0 0 0-.74-.63H6.94Zm.64 1.5h.84l.16 1.01a.75.75 0 0 0 .5.59c.46.15.89.4 1.26.72a.75.75 0 0 0 .77.13l.96-.38.42.72-.8.65a.75.75 0 0 0-.27.73 4 4 0 0 1 0 1.46.75.75 0 0 0 .27.73l.8.65-.42.72-.96-.38a.75.75 0 0 0-.77.13c-.37.32-.8.57-1.26.72a.75.75 0 0 0-.5.59l-.16 1.01h-.84l-.16-1.01a.75.75 0 0 0-.5-.59 3.9 3.9 0 0 1-1.26-.72.75.75 0 0 0-.77-.13l-.96.38-.42-.72.8-.65a.75.75 0 0 0 .27-.73 4 4 0 0 1 0-1.46.75.75 0 0 0-.27-.73l-.8-.65.42-.72.96.38a.75.75 0 0 0 .77-.13c.37-.32.8-.57 1.26-.72a.75.75 0 0 0 .5-.59l.16-1.01Z"/>' +
      '</svg>',

    mount: function (containerEl) {
      el = containerEl;
      lastSig = null;
      lastSearch = null;
      menuRow = null;

      el.innerHTML =
        '<div class="svc-view">' +
          '<div class="svc-toolbar">' +
            '<span class="svc-count" id="svc-count">0 services</span>' +
          '</div>' +
          '<div class="svc-table-wrap">' +
            '<table class="svc-table" role="grid">' +
              '<thead>' +
                '<tr>' +
                  '<th class="svc-col-name">Name</th>' +
                  '<th class="svc-col-pid num">PID</th>' +
                  '<th class="svc-col-status">Status</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody id="svc-tbody"></tbody>' +
            '</table>' +
            '<div class="svc-empty" id="svc-empty" hidden>No services found.</div>' +
          '</div>' +
        '</div>';

      tbodyEl = el.querySelector('#svc-tbody');
      countEl = el.querySelector('#svc-count');
      emptyEl = el.querySelector('#svc-empty');

      // Inject view-scoped styles once (token-driven, no hardcoded colors).
      injectStyles();

      // Delegated right-click for Start/Stop.
      el.addEventListener('contextmenu', onContextMenu);

      // Initial fetch (force) + first paint.
      fetchServices(true);
      render();
    },

    update: function (/* state */) {
      if (!el) return;
      // Throttled background refresh off the poll tick.
      fetchServices(false);
      // Re-render to reflect any search-box changes immediately (cheap; skips
      // when the signature + query are unchanged).
      render();
    },

    unmount: function () {
      if (el) {
        el.removeEventListener('contextmenu', onContextMenu);
        el.innerHTML = '';
      }
      clearMenuHighlight();
      el = null;
      tbodyEl = null;
      countEl = null;
      emptyEl = null;
      lastSig = null;
      lastSearch = null;
    }
  };

  // ---- Scoped styles (services view only) -------------------------------
  // The view ships its own
  // styles via a single injected <style>, using only tokens.css variables.
  function injectStyles() {
    if (document.getElementById('tm-services-styles')) return;
    var css =
      '.svc-view{display:flex;flex-direction:column;height:100%;font-family:var(--font-ui);' +
        'color:var(--text-primary);background:var(--bg-content);}' +
      '.svc-toolbar{display:flex;align-items:center;height:var(--commandbar-h);' +
        'padding:0 var(--sp-4);border-bottom:1px solid var(--border);' +
        'background:var(--bg-elevated);flex:0 0 auto;}' +
      '.svc-count{font-size:var(--fs-sm);color:var(--text-tertiary);}' +
      '.svc-table-wrap{flex:1 1 auto;overflow:auto;position:relative;}' +
      '.svc-table{width:100%;border-collapse:collapse;table-layout:fixed;' +
        'font-size:var(--fs-md);}' +
      '.svc-table thead th{position:sticky;top:0;z-index:1;text-align:left;' +
        'font-weight:var(--fw-semibold);font-size:var(--fs-sm);' +
        'color:var(--text-secondary);background:var(--bg-header);' +
        'padding:0 var(--sp-4);height:34px;border-bottom:1px solid var(--border);' +
        'white-space:nowrap;}' +
      '.svc-table th.num,.svc-table td.num{text-align:right;' +
        'font-family:var(--font-num);font-variant-numeric:tabular-nums;}' +
      '.svc-col-pid{width:96px;}' +
      '.svc-col-status{width:140px;}' +
      '.svc-table tbody td{padding:0 var(--sp-4);height:var(--row-h);' +
        'border-bottom:1px solid var(--row-stripe);color:var(--text-primary);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.svc-row{cursor:default;}' +
      '.svc-row:hover{background:var(--row-hover);}' +
      '.svc-row.is-menu{background:var(--row-selected);' +
        'box-shadow:inset 2px 0 0 var(--row-selected-accent);}' +
      '.svc-name{color:var(--text-primary);}' +
      '.svc-pid{color:var(--text-secondary);}' +
      '.svc-pill{display:inline-flex;align-items:center;gap:6px;' +
        'padding:1px 10px 1px 8px;border-radius:var(--r-pill);' +
        'font-size:var(--fs-xs);font-weight:var(--fw-medium);line-height:18px;}' +
      '.svc-pill::before{content:"";width:7px;height:7px;border-radius:50%;' +
        'background:currentColor;}' +
      '.svc-pill--running{color:var(--success);' +
        'background:rgba(108,203,95,0.12);}' +
      '.svc-pill--stopped{color:var(--text-tertiary);' +
        'background:rgba(255,255,255,0.06);}' +
      '.svc-empty{padding:var(--sp-6) var(--sp-4);color:var(--text-tertiary);' +
        'font-size:var(--fs-md);text-align:center;}';
    var style = document.createElement('style');
    style.id = 'tm-services-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }
})();
