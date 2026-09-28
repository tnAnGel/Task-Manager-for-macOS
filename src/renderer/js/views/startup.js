// TM.views.startup — Startup apps view.
// Lists StartupItem[] from window.api.getStartupItems(): LaunchAgents / LaunchDaemons
// with friendly names, app icons, and vendor groups (Adobe, Google, Docker, …).
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
  var expanded = {};     // groupKey -> true when the vendor/app tree is open

  var ICON_CHEV = '<svg class="tm-chev" width="12" height="12" viewBox="0 0 16 16" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';

  var ICON_DOT = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
    '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" opacity="0.6"/>' +
    '<circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" opacity="0.6"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function typeLabel(type) {
    switch (type) {
      case 'LaunchAgent':  return 'Launch agent';
      case 'LaunchDaemon': return 'Launch daemon';
      case 'LoginItem':    return 'Login item';
      default:             return type ? String(type) : '—';
    }
  }

  function impactInfo(impact) {
    switch (impact) {
      case 'High':   return { cls: 'impact-high',   text: 'High' };
      case 'Medium': return { cls: 'impact-medium', text: 'Medium' };
      case 'Low':    return { cls: 'impact-low',    text: 'Low' };
      default:       return { cls: 'impact-none',   text: 'Not measured' };
    }
  }

  function displayNameOf(it) {
    if (!it) return '(unknown)';
    return it.displayName || it.name || it.label || '(unknown)';
  }

  function childDisplayName(it, groupName) {
    var n = displayNameOf(it);
    if (groupName) {
      var prefix = groupName + ' ';
      if (n.toLowerCase().indexOf(prefix.toLowerCase()) === 0) {
        var rest = n.slice(prefix.length).trim();
        if (rest) return rest;
      }
    }
    return n;
  }

  function iconHtml(iconPath, glyphLetter) {
    var letter = (glyphLetter || '').trim().charAt(0);
    var glyph = letter
      ? '<span class="startup-glyph" aria-hidden="true">' + esc(letter.toUpperCase()) + '</span>'
      : '<span class="app-glyph">' + ICON_DOT + '</span>';
    if (!iconPath) return glyph;
    var cached = (TM.icons && TM.icons.cached) ? TM.icons.cached(iconPath) : undefined;
    if (cached === '') return glyph;
    if (TM.icons && TM.icons.request) TM.icons.request(iconPath);
    return '<span class="startup-icon-wrap">' + glyph +
      '<img class="app-icon startup-app-icon' + (cached ? ' loaded' : '') + '" ' +
      'data-icon-path="' + esc(iconPath) + '" alt=""' +
      (cached ? ' src="' + cached + '"' : '') + '>' +
      '</span>';
  }

  function nameStack(primary, secondary, title) {
    return (
      '<span class="startup-name-stack" title="' + esc(title || '') + '">' +
        '<span class="startup-name-primary">' + esc(primary) + '</span>' +
        (secondary
          ? '<span class="startup-name-sub">' + esc(secondary) + '</span>'
          : '') +
      '</span>'
    );
  }

  function statusPillHtml(enabled) {
    return '<span class="status-pill ' + (enabled ? 'pill-enabled' : 'pill-disabled') + '">' +
      (enabled ? 'Enabled' : 'Disabled') + '</span>';
  }

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

  function checkboxHtml(enabled) {
    return '<span class="startup-check' + (enabled ? ' checked' : '') + '" role="checkbox" ' +
      'tabindex="0" aria-checked="' + enabled + '" ' +
      'title="' + (enabled ? 'Disable autostart' : 'Enable autostart') + '">' +
      checkGlyph(enabled) +
      '</span>';
  }

  function expanderHtml(isOpen) {
    return '<span class="row-expander" title="' + (isOpen ? 'Collapse' : 'Show items') +
      '" role="button" tabindex="0" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
      ICON_CHEV + '</span>';
  }

  function spacerHtml() {
    return '<span class="row-expander-spacer"></span>';
  }

  function impactCell(it) {
    var imp = impactInfo(it ? it.impact : '—');
    return '<span class="impact-label ' + imp.cls + '">' + esc(imp.text) + '</span>';
  }

  function itemRowHtml(it, opts) {
    opts = opts || {};
    var enabled = !!(it && it.enabled);
    var label = esc(it && it.label ? it.label : (it && it.name) || '');
    var rawType = esc(it && it.type ? it.type : '');
    var pending = !!(it && it._pending);
    var primary = opts.primary || displayNameOf(it);
    var subtitle = it && it.label ? it.label : '';
    var title = [primary, subtitle, it && it.program, it && it.path]
      .filter(Boolean).join('\n');
    var cls = 'startup-row' + (opts.child ? ' startup-child' : '') +
      (pending ? ' pending' : '');
    var glyph = primary || (it && it.vendor) || '?';

    return (
      '<tr class="' + cls + '" data-label="' + label + '" data-type="' + rawType + '">' +
        '<td class="col-name">' +
          '<div class="startup-name-cell">' +
            spacerHtml() +
            checkboxHtml(enabled) +
            iconHtml(it && it.iconPath, glyph) +
            nameStack(primary, subtitle, title) +
          '</div>' +
        '</td>' +
        '<td class="col-type">' + esc(typeLabel(it ? it.type : null)) + '</td>' +
        '<td class="col-status">' + statusPillHtml(enabled) + '</td>' +
        '<td class="col-impact">' + impactCell(it) + '</td>' +
      '</tr>'
    );
  }

  function parentStatusHtml(list) {
    var n = list.length;
    var on = 0;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].enabled) on++;
    if (on === n) {
      return '<span class="status-pill pill-enabled">' +
        (n === 1 ? 'Enabled' : n + ' enabled') + '</span>';
    }
    if (on === 0) {
      return '<span class="status-pill pill-disabled">' +
        (n === 1 ? 'Disabled' : 'Disabled') + '</span>';
    }
    return '<span class="status-pill pill-mixed">' + on + ' of ' + n + ' enabled</span>';
  }

  function parentTypeLabel(list) {
    var t = list[0] && list[0].type;
    for (var i = 1; i < list.length; i++) {
      if (list[i] && list[i].type !== t) return 'Multiple';
    }
    return typeLabel(t);
  }

  function parentRowHtml(group) {
    var isOpen = !!group.expanded;
    var n = group.items.length;
    var iconPath = '';
    for (var i = 0; i < n; i++) {
      if (group.items[i] && group.items[i].iconPath) {
        iconPath = group.items[i].iconPath;
        break;
      }
    }
    var sub = n + (n === 1 ? ' item' : ' items');
    var title = group.name + ' — ' + sub;
    var cls = 'startup-row startup-parent' + (isOpen ? ' expanded' : ' collapsed');
    return (
      '<tr class="' + cls + '" data-group-key="' + esc(group.key) + '">' +
        '<td class="col-name">' +
          '<div class="startup-name-cell">' +
            expanderHtml(isOpen) +
            '<span class="startup-check-spacer"></span>' +
            iconHtml(iconPath, group.name) +
            nameStack(group.name, sub, title) +
          '</div>' +
        '</td>' +
        '<td class="col-type">' + esc(parentTypeLabel(group.items)) + '</td>' +
        '<td class="col-status">' + parentStatusHtml(group.items) + '</td>' +
        '<td class="col-impact"><span class="impact-label impact-none">Not measured</span></td>' +
      '</tr>'
    );
  }

  function setSubtitle(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function compareItems(a, b) {
    var ae = a && a.enabled ? 1 : 0;
    var be = b && b.enabled ? 1 : 0;
    if (ae !== be) return be - ae;
    var an = displayNameOf(a).toLowerCase();
    var bn = displayNameOf(b).toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  }

  function buildGroups(list) {
    var buckets = {};
    var singles = [];
    var order = [];

    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      var gk = it.groupKey || '';
      if (!gk) { singles.push(it); continue; }
      if (!buckets[gk]) {
        buckets[gk] = [];
        order.push(gk);
      }
      buckets[gk].push(it);
    }

    var groups = [];
    for (var o = 0; o < order.length; o++) {
      var key = order[o];
      var members = buckets[key];
      if (members.length < 2) {
        for (var m = 0; m < members.length; m++) singles.push(members[m]);
        continue;
      }
      members.sort(compareItems);
      groups.push({
        kind: 'group',
        key: key,
        name: members[0].groupName || members[0].vendor || key,
        items: members,
        expanded: expanded[key] === true,
      });
    }

    var rows = groups.concat(singles.map(function (it) {
      return { kind: 'item', item: it };
    }));
    rows.sort(function (a, b) {
      var an = (a.kind === 'group' ? a.name : displayNameOf(a.item)).toLowerCase();
      var bn = (b.kind === 'group' ? b.name : displayNameOf(b.item)).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return rows;
  }

  function emptyRow(msg) {
    return '<tr class="startup-empty-row"><td colspan="4">' +
      '<div class="startup-message">' + esc(msg) + '</div></td></tr>';
  }

  function render() {
    if (!bodyEl) return;

    if (loading && !fetched) {
      bodyEl.innerHTML = emptyRow('Loading startup items…');
      setSubtitle('Loading…');
      return;
    }

    if (failed) {
      bodyEl.innerHTML = emptyRow('Could not read startup items.');
      setSubtitle('Unavailable');
      return;
    }

    var list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      bodyEl.innerHTML = emptyRow('No startup items found');
      setSubtitle('0 items');
      return;
    }

    var rows = buildGroups(list);
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.kind === 'group') {
        html += parentRowHtml(row);
        if (row.expanded) {
          for (var c = 0; c < row.items.length; c++) {
            html += itemRowHtml(row.items[c], {
              child: true,
              primary: childDisplayName(row.items[c], row.name),
            });
          }
        }
      } else {
        html += itemRowHtml(row.item, { primary: displayNameOf(row.item) });
      }
    }
    bodyEl.innerHTML = html;

    var enabledCount = 0;
    for (var j = 0; j < list.length; j++) if (list[j] && list[j].enabled) enabledCount++;
    setSubtitle(list.length + (list.length === 1 ? ' item' : ' items') +
      ' · ' + enabledCount + ' enabled');
  }

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

  function wrapScrollTop() {
    var wrap = root && root.querySelector('.startup-table-wrap');
    return wrap ? wrap.scrollTop : 0;
  }

  function restoreScroll(top) {
    var wrap = root && root.querySelector('.startup-table-wrap');
    if (wrap) wrap.scrollTop = top || 0;
  }

  function toggleGroup(key) {
    if (!key) return;
    expanded[key] = expanded[key] !== true;
    var top = wrapScrollTop();
    render();
    restoreScroll(top);
  }

  function toggleRow(rowEl) {
    if (!rowEl) return;
    var label = rowEl.getAttribute('data-label');
    var type = rowEl.getAttribute('data-type');
    var it = findItem(label, type);
    if (!it || it._pending) return;
    if (!window.api || typeof window.api.setStartupEnabled !== 'function') {
      flashMessage('Toggling is not available'); return;
    }
    var next = !it.enabled;
    rowEl._pending = true;
    it._pending = true;
    setRowUI(rowEl, next, true);
    if (type === 'LaunchDaemon') {
      setSubtitle('Authorizing… (an administrator password may be required)');
    }
    Promise.resolve(window.api.setStartupEnabled(label, type, next))
      .then(function (res) {
        rowEl._pending = false;
        it._pending = false;
        if (res && res.ok) {
          it.enabled = next;
          var top = wrapScrollTop();
          render();
          restoreScroll(top);
        } else {
          setRowUI(rowEl, it.enabled, false);
          flashMessage((res && res.error)
            ? ('Could not change autostart — ' + res.error)
            : 'Could not change autostart');
        }
      })
      .catch(function () {
        rowEl._pending = false;
        it._pending = false;
        setRowUI(rowEl, it.enabled, false);
        flashMessage('Could not change autostart');
      });
  }

  function onBodyClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;

    var parent = t.closest('tr.startup-parent');
    if (parent) {
      ev.preventDefault();
      toggleGroup(parent.getAttribute('data-group-key'));
      return;
    }

    if (t.closest('.row-expander')) {
      var expRow = t.closest('tr.startup-row');
      if (expRow) {
        ev.preventDefault();
        toggleGroup(expRow.getAttribute('data-group-key'));
      }
      return;
    }

    if (!t.closest('.startup-check') && !t.closest('.status-pill')) return;
    var row = t.closest('tr.startup-row');
    if (row && !row.classList.contains('startup-parent')) {
      ev.preventDefault();
      toggleRow(row);
    }
  }

  function onBodyKeydown(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('.row-expander')) {
      var expRow = t.closest('tr.startup-parent') || t.closest('tr.startup-row');
      if (expRow) {
        ev.preventDefault();
        toggleGroup(expRow.getAttribute('data-group-key'));
      }
      return;
    }
    if (!t.closest('.startup-check')) return;
    var row = t.closest('tr.startup-row');
    if (row && !row.classList.contains('startup-parent')) {
      ev.preventDefault();
      toggleRow(row);
    }
  }

  TM.views.startup = {
    id: 'startup',
    title: 'Startup apps',

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
              '<colgroup>' +
                '<col class="c-name">' +
                '<col class="c-type">' +
                '<col class="c-status">' +
                '<col class="c-impact">' +
              '</colgroup>' +
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

      if (bodyEl) {
        bodyEl.addEventListener('click', onBodyClick);
        bodyEl.addEventListener('keydown', onBodyKeydown);
      }

      if (Array.isArray(items)) {
        render();
      } else {
        loadItems(false);
      }
    },

    update: function () {
      if (!bodyEl) return;
      if (!fetched && !loading) {
        loadItems(false);
      }
    },

    unmount: function () {
      root = null;
      bodyEl = null;
      statusEl = null;
      loading = false;
    },
  };
})();
