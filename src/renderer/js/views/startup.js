// TM.views.startup — Startup apps view.
// Lists StartupItem[] from window.api.getStartupItems(): LaunchAgents / LaunchDaemons /
// LoginItems. Fetched once in mount() and cached; update() just re-renders from cache.
// Columns: Name | Type | Status (Enabled/Disabled pill) | Startup impact.
window.TM = window.TM || {};
TM.views = TM.views || {};

(function () {
  'use strict';

  // ---- module-private state (cache + DOM refs) ----
  var items = null;      // StartupItem[] once loaded, else null
  var loading = false;   // fetch in flight
  var failed = false;    // fetch rejected
  var fetched = false;   // a fetch has completed (success or fail) — throttle: fetch once
  var root = null;       // container element
  var bodyEl = null;     // <tbody> we re-render into
  var statusEl = null;   // header subtitle (count)

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Friendly label for the StartupItem.type wire value.
  function typeLabel(type) {
    switch (type) {
      case 'LaunchAgent':  return 'Launch agent';
      case 'LaunchDaemon': return 'Launch daemon';
      case 'LoginItem':    return 'Login item';
      default:             return type ? String(type) : '—';
    }
  }

  // Map "High"|"Medium"|"Low"|"—" to a CSS modifier + display text.
  function impactInfo(impact) {
    switch (impact) {
      case 'High':   return { cls: 'impact-high',   text: 'High' };
      case 'Medium': return { cls: 'impact-medium', text: 'Medium' };
      case 'Low':    return { cls: 'impact-low',    text: 'Low' };
      default:       return { cls: 'impact-none',   text: 'Not measured' };
    }
  }

  function rowHtml(it) {
    var name = esc(it && it.name ? it.name : '(unknown)');
    var pathTitle = it && it.path ? esc(it.path) : '';
    var type = esc(typeLabel(it ? it.type : null));
    var enabled = !!(it && it.enabled);
    var label = esc(it && it.label ? it.label : (it && it.name) || '');
    var rawType = esc(it && it.type ? it.type : '');
    var imp = impactInfo(it ? it.impact : '—');

    return (
      '<tr class="startup-row" data-label="' + label + '" data-type="' + rawType + '">' +
        '<td class="col-name">' +
          '<span class="startup-check' + (enabled ? ' checked' : '') + '" role="checkbox" ' +
            'tabindex="0" aria-checked="' + enabled + '" ' +
            'title="' + (enabled ? 'Disable autostart' : 'Enable autostart') + '">' +
            checkGlyph(enabled) +
          '</span>' +
          '<span class="startup-name-text" title="' + pathTitle + '">' + name + '</span>' +
        '</td>' +
        '<td class="col-type">' + type + '</td>' +
        '<td class="col-status">' + statusPillHtml(enabled) + '</td>' +
        '<td class="col-impact"><span class="impact-label ' + imp.cls + '">' + esc(imp.text) + '</span></td>' +
      '</tr>'
    );
  }

  function statusPillHtml(enabled) {
    return '<span class="status-pill ' + (enabled ? 'pill-enabled' : 'pill-disabled') + '">' +
      (enabled ? 'Enabled' : 'Disabled') + '</span>';
  }

  // Checkbox glyph: a ticked box when enabled, an empty box when disabled.
  function checkGlyph(enabled) {
    if (enabled) {
      return (
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor"/>' +
        '<path d="M5 8.2l2 2 4-4.4" stroke="#1a1a1a" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
        '</svg>'
      );
    }
    return (
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<rect x="2.5" y="2.5" width="11" height="11" rx="3" ' +
      'stroke="currentColor" stroke-width="1.3"/>' +
      '</svg>'
    );
  }

  function setSubtitle(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // Render the body based on current cache state.
  function render() {
    if (!bodyEl) return;

    if (loading && !fetched) {
      bodyEl.innerHTML =
        '<tr class="startup-empty-row"><td colspan="4">' +
        '<div class="startup-message">Loading startup items…</div>' +
        '</td></tr>';
      setSubtitle('Loading…');
      return;
    }

    if (failed) {
      bodyEl.innerHTML =
        '<tr class="startup-empty-row"><td colspan="4">' +
        '<div class="startup-message">Could not read startup items.</div>' +
        '</td></tr>';
      setSubtitle('Unavailable');
      return;
    }

    var list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      bodyEl.innerHTML =
        '<tr class="startup-empty-row"><td colspan="4">' +
        '<div class="startup-message">No startup items found</div>' +
        '</td></tr>';
      setSubtitle('0 items');
      return;
    }

    // Sort: enabled first, then by impact weight, then by name (stable, friendly).
    var weight = { High: 3, Medium: 2, Low: 1 };
    var sorted = list.slice().sort(function (a, b) {
      var ae = a && a.enabled ? 1 : 0;
      var be = b && b.enabled ? 1 : 0;
      if (ae !== be) return be - ae;
      var aw = weight[a && a.impact] || 0;
      var bw = weight[b && b.impact] || 0;
      if (aw !== bw) return bw - aw;
      var an = (a && a.name ? a.name : '').toLowerCase();
      var bn = (b && b.name ? b.name : '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    var html = '';
    for (var i = 0; i < sorted.length; i++) html += rowHtml(sorted[i]);
    bodyEl.innerHTML = html;

    var enabledCount = 0;
    for (var j = 0; j < list.length; j++) if (list[j] && list[j].enabled) enabledCount++;
    setSubtitle(list.length + (list.length === 1 ? ' item' : ' items') +
      ' · ' + enabledCount + ' enabled');
  }

  // Fetch once and cache. Throttled via `fetched`/`loading` guards.
  function loadItems(force) {
    if (loading) return;
    if (fetched && !force) return;
    if (!window.api || typeof window.api.getStartupItems !== 'function') {
      failed = true;
      fetched = true;
      render();
      return;
    }
    loading = true;
    failed = false;
    render();
    Promise.resolve()
      .then(function () { return window.api.getStartupItems(); })
      .then(function (result) {
        items = Array.isArray(result) ? result : [];
        failed = false;
      })
      .catch(function (err) {
        // eslint-disable-next-line no-console
        try { console.error('[startup] getStartupItems failed:', err); } catch (e) {}
        items = [];
        failed = true;
      })
      .then(function () {
        loading = false;
        fetched = true;
        render();
      });
  }

  // ---- toggle machinery ----------------------------------------------------
  function enabledCount() {
    var list = Array.isArray(items) ? items : [];
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].enabled) n++;
    return n;
  }

  function updateSubtitle() {
    var list = Array.isArray(items) ? items : [];
    setSubtitle(list.length + (list.length === 1 ? ' item' : ' items') +
      ' · ' + enabledCount() + ' enabled');
  }

  var _flashTimer = null;
  function flashMessage(msg) {
    setSubtitle(msg);
    if (_flashTimer) clearTimeout(_flashTimer);
    _flashTimer = setTimeout(function () { _flashTimer = null; updateSubtitle(); }, 4000);
  }

  function findItem(label, type) {
    var list = Array.isArray(items) ? items : [];
    var exact = null, byLabel = null;
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (!x) continue;
      if (x.label === label && x.type === type) { exact = x; break; }
      if (!byLabel && x.label === label) byLabel = x;
    }
    return exact || byLabel;
  }

  function setRowUI(rowEl, enabled, pending) {
    if (!rowEl) return;
    rowEl.classList.toggle('pending', !!pending);
    var chk = rowEl.querySelector('.startup-check');
    if (chk) {
      chk.classList.toggle('checked', !!enabled);
      chk.setAttribute('aria-checked', String(!!enabled));
      chk.setAttribute('title', enabled ? 'Disable autostart' : 'Enable autostart');
      chk.innerHTML = checkGlyph(!!enabled);
    }
    var statusTd = rowEl.querySelector('.col-status');
    if (statusTd) statusTd.innerHTML = statusPillHtml(!!enabled);
  }

  function toggleRow(rowEl) {
    if (!rowEl || rowEl._pending) return;
    var label = rowEl.getAttribute('data-label');
    var type = rowEl.getAttribute('data-type');
    var it = findItem(label, type);
    if (!it) return;
    if (!window.api || typeof window.api.setStartupEnabled !== 'function') {
      flashMessage('Toggling is not available'); return;
    }
    var next = !it.enabled;
    rowEl._pending = true;
    setRowUI(rowEl, next, true); // optimistic
    if (type === 'LaunchDaemon') {
      setSubtitle('Authorizing… (an administrator password may be required)');
    }
    Promise.resolve(window.api.setStartupEnabled(label, type, next))
      .then(function (res) {
        rowEl._pending = false;
        if (res && res.ok) {
          it.enabled = next;
          setRowUI(rowEl, next, false);
          updateSubtitle();
        } else {
          setRowUI(rowEl, it.enabled, false); // revert
          flashMessage((res && res.error)
            ? ('Could not change autostart — ' + res.error)
            : 'Could not change autostart');
        }
      })
      .catch(function () {
        rowEl._pending = false;
        setRowUI(rowEl, it.enabled, false);
        flashMessage('Could not change autostart');
      });
  }

  function onBodyClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('.startup-check') && !t.closest('.status-pill')) return;
    var row = t.closest('tr.startup-row');
    if (row) { ev.preventDefault(); toggleRow(row); }
  }

  function onBodyKeydown(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
    var t = ev.target;
    if (!t || !t.closest || !t.closest('.startup-check')) return;
    var row = t.closest('tr.startup-row');
    if (row) { ev.preventDefault(); toggleRow(row); }
  }

  TM.views.startup = {
    id: 'startup',
    title: 'Startup apps',

    // Rocket glyph for the sidebar (16x16, currentColor).
    icon:
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" ' +
      'xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M9.6 1.8c2.2-.5 4.6 1.9 4.1 4.1-.4 1.9-1.7 3.6-3.2 5l-.4.4-2-.6-1.2-1.2-.6-2 .4-.4C8.1 5.6 9.8 4.3 11.7 3.9" ' +
      'transform="translate(-1 0)" stroke="currentColor" stroke-width="1.2" ' +
      'stroke-linejoin="round"/>' +
      '<path d="M6 10.2 4.1 8.3 2 9l1.4 1.4M5.8 13.9 7.2 12l1.4 1.4-.7 2.1-1.9-1.9z" ' +
      'transform="translate(0 -0.2)" stroke="currentColor" stroke-width="1.2" ' +
      'stroke-linejoin="round" fill="none"/>' +
      '<circle cx="9.5" cy="6.3" r="1.2" stroke="currentColor" stroke-width="1.2"/>' +
      '</svg>',

    mount: function (containerEl) {
      root = containerEl;
      // reset per-mount transient flags but keep cached items if already loaded
      loading = false;
      if (!Array.isArray(items)) { fetched = false; failed = false; }

      root.innerHTML =
        '<div class="view view-startup">' +
          '<header class="view-header">' +
            '<h1 class="view-title">Startup apps</h1>' +
            '<p class="view-subtitle" id="startup-subtitle">' +
              'Apps and services configured to launch when you sign in.' +
            '</p>' +
          '</header>' +
          '<div class="startup-table-wrap">' +
            '<table class="startup-table data-table">' +
              '<thead><tr>' +
                '<th class="col-name">Name</th>' +
                '<th class="col-type">Type</th>' +
                '<th class="col-status">Status</th>' +
                '<th class="col-impact">Startup impact</th>' +
              '</tr></thead>' +
              '<tbody id="startup-tbody"></tbody>' +
            '</table>' +
          '</div>' +
        '</div>';

      bodyEl = root.querySelector('#startup-tbody');
      statusEl = root.querySelector('#startup-subtitle');

      // Delegated toggle handlers (rows are re-rendered into bodyEl).
      if (bodyEl) {
        bodyEl.addEventListener('click', onBodyClick);
        bodyEl.addEventListener('keydown', onBodyKeydown);
      }

      // If we already have cached data from a prior mount, just render it.
      if (Array.isArray(items)) {
        render();
      } else {
        loadItems(false);
      }
    },

    // Called each poll tick. Data is cached (fetched once); only ensure a render
    // and kick off the initial fetch if it somehow hasn't happened yet.
    update: function () {
      if (!bodyEl) return;
      if (!fetched && !loading) {
        loadItems(false);
        return;
      }
      // No-op when already loaded: cached list does not change between fetches,
      // so avoid needless DOM thrash. (mount already rendered.)
    },

    unmount: function () {
      root = null;
      bodyEl = null;
      statusEl = null;
      loading = false;
      // keep `items` cache so re-entering the view is instant; allow refresh
      // by leaving fetched=true (data is static enough for this view).
    },
  };
})();
