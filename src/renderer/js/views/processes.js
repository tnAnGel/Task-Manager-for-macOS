// processes.js — TM.views.processes.
// The flagship Processes view: command bar + grouped, sortable, heat-colored table.
// Classic script, no modules. Attaches to the shared global TM namespace.
window.TM = window.TM || {};
TM.views = TM.views || {};

(function () {
  'use strict';

  var fmt = TM.format;

  // Uniform row height (must match the CSS below: --row-h and .ghead height),
  // used by the virtualized renderer to map scroll position to row indices.
  var ROW_H = 30;

  // ---- Column model ---------------------------------------------------------
  // key       — sort key + identifier
  // label     — header text
  // numeric   — right-aligned, tabular, heat-colored
  // statKind  — which aggregate stat feeds the header cell (for numeric cols)
  var COLUMNS = [
    { key: 'name',   label: 'Name',    numeric: false },
    { key: 'state',  label: 'Status',  numeric: false },
    { key: 'cpu',    label: 'CPU',     numeric: true, statKind: 'cpu' },
    { key: 'mem',    label: 'Memory',  numeric: true, statKind: 'mem' },
    { key: 'disk',   label: 'Disk',    numeric: true, statKind: 'disk' },
    { key: 'net',    label: 'Network', numeric: true, statKind: 'net' },
    { key: 'gpu',    label: 'GPU',     numeric: true, statKind: 'gpu' }
  ];

  // Group definitions in display order. `key` matches TM.state.ui.expanded.* and
  // the Process.type values ('app' -> apps, 'background', 'system').
  var GROUPS = [
    { key: 'apps',       label: 'Apps',                type: 'app' },
    { key: 'background', label: 'Background processes', type: 'background' },
    { key: 'system',     label: 'System processes',    type: 'system' }
  ];

  // ---- Inline SVG icons -----------------------------------------------------
  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="2" width="5" height="5" rx="1"/>' +
    '<rect x="9" y="2" width="5" height="5" rx="1"/>' +
    '<rect x="2" y="9" width="5" height="5" rx="1"/>' +
    '<rect x="9" y="9" width="5" height="5" rx="1"/>' +
    '</svg>';

  function svgGlyph(d) {
    return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" ' +
      'xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }
  var ICON_RUN  = svgGlyph('<path d="M3 3.5h10M8 3.5v9M4.5 12.5h7"/>'); // simple plus-ish run
  var ICON_END  = svgGlyph('<path d="M4 4l8 8M12 4l-8 8"/>');
  var ICON_CHEV = '<svg class="tm-chev" width="12" height="12" viewBox="0 0 16 16" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
  // Generic fallback glyph for processes without a .app bundle (daemons/CLI).
  var ICON_DOT = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
    '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" opacity="0.6"/>' +
    '<circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" opacity="0.6"/></svg>';

  // Name cell inner: optional expander + app icon (lazy-loaded) + process name.
  function nameCellInner(proc, opts) {
    opts = opts || {};
    var expander;
    if (opts.childCount > 0) {
      expander = '<span class="row-expander" title="Show processes" role="button" ' +
        'aria-expanded="' + (opts.expanded ? 'true' : 'false') + '">' + ICON_CHEV + '</span>';
    } else {
      expander = '<span class="row-expander-spacer"></span>';
    }
    var iconHtml;
    if (proc.iconPath) {
      var cached = (TM.icons && TM.icons.cached) ? TM.icons.cached(proc.iconPath) : undefined;
      if (TM.icons && TM.icons.request) TM.icons.request(proc.iconPath);
      iconHtml = '<img class="app-icon' + (cached ? ' loaded' : '') + '" ' +
        'data-icon-path="' + escapeHtml(proc.iconPath) + '" alt=""' +
        (cached ? ' src="' + cached + '"' : '') + '>';
    } else {
      iconHtml = '<span class="app-glyph">' + ICON_DOT + '</span>';
    }
    return '<span class="tm-name-inner">' + expander + iconHtml +
      '<span class="tm-name-text">' + escapeHtml(proc.name || ('PID ' + proc.pid)) + '</span></span>';
  }

  // ---- One-time scoped styles (structural only; colors come from tokens.css).
  // processes.css owns the canonical styling; this is a fallback so
  // the flagship view is always usable even if loaded standalone. All rules are
  // namespaced under .tm-proc to avoid clobbering anything else.
  var STYLE_ID = 'tm-proc-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.tm-proc{display:flex;flex-direction:column;height:100%;min-height:0;',
      'font-family:var(--font-ui);color:var(--text-primary);}',
      '.tm-proc-cmdbar{display:flex;align-items:center;gap:var(--sp-2);',
      'height:var(--commandbar-h);padding:0 var(--sp-3);flex:0 0 auto;',
      'background:var(--bg-elevated);border-bottom:1px solid var(--border);}',
      '.tm-proc-btn{display:inline-flex;align-items:center;gap:var(--sp-2);',
      'height:30px;padding:0 var(--sp-3);border:1px solid var(--border-subtle);',
      'border-radius:var(--r-sm);background:var(--bg-input);color:var(--text-primary);',
      'font:inherit;font-size:var(--fs-md);cursor:pointer;white-space:nowrap;}',
      '.tm-proc-btn:hover:not(:disabled){background:var(--row-hover);}',
      '.tm-proc-btn:active:not(:disabled){background:var(--row-selected);}',
      '.tm-proc-btn:disabled{color:var(--text-disabled);cursor:default;opacity:.6;}',
      '.tm-proc-btn .tm-i{display:inline-flex;width:16px;height:16px;}',
      '.tm-proc-btn-end{color:var(--danger);} .tm-proc-btn-end:disabled{color:var(--text-disabled);}',
      '.tm-proc-spacer{flex:1 1 auto;}',
      '.tm-proc-tablewrap{flex:1 1 auto;min-height:0;overflow:auto;',
      'background:var(--bg-content);}',
      '.tm-proc-table{width:100%;border-collapse:collapse;table-layout:fixed;',
      'font-size:var(--fs-md);}',
      '.tm-proc-table col.c-name{width:auto;}',
      '.tm-proc-table col.c-status{width:90px;}',
      '.tm-proc-table col.c-num{width:96px;}',
      '.tm-proc-table thead th{position:sticky;top:0;z-index:2;',
      'background:var(--bg-header);color:var(--text-secondary);font-weight:var(--fw-normal);',
      'text-align:left;padding:6px var(--sp-3);border-bottom:1px solid var(--border-subtle);',
      'cursor:pointer;user-select:none;white-space:nowrap;}',
      '.tm-proc-table thead th.num{text-align:right;}',
      '.tm-proc-table thead th .agg{display:block;font-size:var(--fs-sm);',
      'color:var(--text-tertiary);font-weight:var(--fw-normal);}',
      '.tm-proc-table thead th.sorted{color:var(--text-primary);}',
      '.tm-proc-table thead th .sortcaret{font-size:9px;margin-left:4px;color:var(--accent);}',
      '.tm-grouprow td{background:var(--group-header);color:var(--text-primary);',
      'padding:0 var(--sp-3);cursor:pointer;border-bottom:1px solid var(--border);',
      'user-select:none;vertical-align:middle;}',
      '.tm-grouprow:hover td{background:var(--row-hover);}',
      '.tm-grouprow td.gname{padding-left:var(--sp-2);}',
      '.tm-grouprow .ghead{display:flex;align-items:center;gap:7px;height:30px;}',
      '.tm-proc-table tr.tm-spacer td{padding:0;border:0;line-height:0;font-size:0;}',
      '.tm-grouprow .tm-chev{width:11px;height:11px;flex:0 0 11px;',
      'color:var(--text-tertiary);transition:transform .12s ease;}',
      '.tm-grouprow.collapsed .tm-chev{transform:rotate(0deg);}',
      '.tm-grouprow:not(.collapsed) .tm-chev{transform:rotate(90deg);}',
      '.tm-grouprow .glabel{font-weight:var(--fw-semibold);color:var(--text-primary);}',
      '.tm-grouprow .gcount{color:var(--text-tertiary);font-weight:var(--fw-normal);',
      'font-size:var(--fs-sm);}',
      '.tm-grouprow td.num{text-align:right;font-family:var(--font-num);',
      'font-variant-numeric:tabular-nums;color:var(--text-secondary);font-weight:var(--fw-medium);}',
      '.tm-proc-row{height:var(--row-h);}',
      '.tm-proc-row td{padding:0 var(--sp-3);border-bottom:1px solid transparent;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:var(--row-h);',
      'line-height:var(--row-h);}',
      '.tm-proc-row td.num{text-align:right;font-family:var(--font-num);',
      'font-variant-numeric:tabular-nums;color:var(--text-secondary);}',
      '.tm-proc-row td.name{padding-left:12px;color:var(--text-primary);}',
      '.tm-proc-row.child td.name .tm-name-inner{padding-left:18px;}',
      '.tm-name-inner{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.tm-proc-row .row-expander{display:inline-flex;align-items:center;justify-content:center;',
      'width:14px;height:14px;flex:0 0 14px;color:var(--text-tertiary);cursor:pointer;',
      'transition:transform .12s ease;}',
      '.tm-proc-row .row-expander .tm-chev{width:8px;height:8px;}',
      '.tm-proc-row.expanded .row-expander{transform:rotate(90deg);}',
      '.tm-proc-row.collapsed .row-expander{transform:rotate(0deg);}',
      '.tm-proc-row .row-expander-spacer{display:inline-block;width:14px;height:14px;flex:0 0 14px;}',
      '.app-icon{width:16px;height:16px;flex:0 0 16px;object-fit:contain;',
      'opacity:0;transition:opacity .12s ease;}',
      '.app-icon.loaded{opacity:1;}',
      '.app-glyph{display:inline-flex;align-items:center;justify-content:center;',
      'width:16px;height:16px;flex:0 0 16px;color:var(--text-tertiary);}',
      '.tm-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
      '.tm-proc-row td.status{color:var(--text-tertiary);}',
      '.tm-proc-row:hover td{background:var(--row-hover);}',
      '.tm-proc-row.selected td{background:var(--row-selected);}',
      '.tm-proc-row.selected td.name{box-shadow:inset 3px 0 0 var(--accent);}',
      '.tm-proc-empty{padding:var(--sp-6);text-align:center;color:var(--text-tertiary);}',
      '.tm-modal-overlay{position:fixed;inset:0;z-index:2000;display:flex;',
      'align-items:center;justify-content:center;background:rgba(0,0,0,0.45);}',
      '.tm-modal{width:440px;max-width:90vw;background:var(--bg-menu);',
      'border:1px solid var(--border-subtle);border-radius:var(--r-lg);',
      'box-shadow:var(--shadow-flyout);padding:var(--sp-5);}',
      '.tm-modal-title{font-size:var(--fs-lg);font-weight:var(--fw-semibold);margin-bottom:var(--sp-2);}',
      '.tm-modal-sub{font-size:var(--fs-sm);color:var(--text-tertiary);margin-bottom:var(--sp-3);line-height:1.5;}',
      '.tm-modal-sub code{background:var(--bg-input);padding:1px 5px;border-radius:3px;font-family:var(--font-num);}',
      '.tm-modal-input{width:100%;height:34px;padding:0 var(--sp-3);background:var(--bg-input);',
      'border:1px solid var(--border-subtle);border-radius:var(--r-sm);color:var(--text-primary);',
      'font:inherit;font-size:var(--fs-md);outline:none;box-sizing:border-box;}',
      '.tm-modal-input:focus{border-color:var(--accent);}',
      '.tm-modal-err{min-height:16px;color:var(--danger);font-size:var(--fs-sm);margin-top:var(--sp-2);}',
      '.tm-modal-actions{display:flex;justify-content:flex-end;gap:var(--sp-2);margin-top:var(--sp-2);}',
      '.tm-modal-btn{height:30px;padding:0 var(--sp-4);border-radius:var(--r-sm);',
      'border:1px solid var(--border-subtle);background:var(--bg-input);color:var(--text-primary);',
      'font:inherit;cursor:pointer;}',
      '.tm-modal-btn:hover{background:var(--row-hover);}',
      '.tm-modal-btn.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent);}',
      '.tm-modal-btn.primary:hover{background:var(--accent-strong);}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ---- Heat maxima per column (what "100% hot" means for that metric) -------
  // CPU/GPU are 0-100. Memory uses % of total RAM for heat. Disk/Net per-proc
  // are unavailable on mac (always 0) -> never tinted.
  function heatClass(col, proc, stats) {
    var bucket = 0;
    if (col.key === 'cpu') {
      bucket = fmt.heat(proc.cpu, 100);
    } else if (col.key === 'mem') {
      bucket = fmt.heat(proc.memPercent, 50); // 50% of RAM == fully hot
    } else if (col.key === 'net') {
      bucket = fmt.heat(proc.netBytesSec, 2 * 1024 * 1024); // ~2 MB/s == fully hot
    } else if (col.key === 'gpu') {
      bucket = 0; // per-process GPU not available on mac
    } else {
      bucket = 0; // disk per-process not available on mac
    }
    return 'heat-' + bucket;
  }

  // ---- Per-process cell text ------------------------------------------------
  function cellText(col, proc) {
    switch (col.key) {
      case 'name':   return proc.name || ('PID ' + proc.pid);
      case 'state':  return statusLabel(proc.state);
      case 'cpu':    return fmt.percentCell(proc.cpu);
      case 'mem':    return fmt.bytes(proc.memBytes);
      case 'disk':   return '0 MB/s';
      case 'net':    return proc.netBytesSec > 0 ? fmt.bytesPerSec(proc.netBytesSec) : '0 KB/s';
      case 'gpu':    return fmt.dash;
      default:       return '';
    }
  }

  function statusLabel(state) {
    if (!state) return '';
    var s = String(state).toLowerCase();
    if (s.indexOf('run') === 0) return 'Running';
    if (s.indexOf('sleep') === 0) return '';      // Win11 shows blank for normal sleeping
    if (s.indexOf('stop') === 0) return 'Suspended';
    if (s.indexOf('zomb') === 0) return 'Zombie';
    if (s === 'idle') return '';
    return state.charAt(0).toUpperCase() + state.slice(1);
  }

  // ---- Sorting --------------------------------------------------------------
  function sortValue(key, proc) {
    switch (key) {
      case 'name':  return (proc.name || '').toLowerCase();
      case 'state': return (proc.state || '').toLowerCase();
      case 'cpu':   return num(proc.cpu);
      case 'mem':   return num(proc.memBytes);
      case 'disk':  return 0;
      case 'net':   return num(proc.netBytesSec);
      case 'gpu':   return 0;
      default:      return 0;
    }
  }

  function compareProcs(a, b, key, dir) {
    var av = sortValue(key, a);
    var bv = sortValue(key, b);
    var cmp;
    if (typeof av === 'string' || typeof bv === 'string') {
      cmp = String(av).localeCompare(String(bv));
    } else {
      cmp = av < bv ? -1 : (av > bv ? 1 : 0);
    }
    if (cmp === 0) cmp = num(a.pid) - num(b.pid); // stable tiebreak
    return dir === 'asc' ? cmp : -cmp;
  }

  function num(v) {
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : 0;
  }

  function compareNamePid(a, b) {
    var an = (a.name || '').toLowerCase();
    var bn = (b.name || '').toLowerCase();
    var cmp = an.localeCompare(bn);
    if (cmp === 0) cmp = num(a.pid) - num(b.pid);
    return cmp;
  }

  function isHelperProc(p) {
    var hay = ((p.name || '') + ' ' + (p.command || '') + ' ' + (p.path || '')).toLowerCase();
    return /helper/.test(hay) || / --type=/.test(' ' + (p.command || ''));
  }

  // Group identity:
  //   app:<bundlePath>  — same .app (helpers pulled in via iconPath or ppid-walk)
  //   name:<section>:<name> — exact display name within Apps / Background / System
  // Section is the process's own type so a background daemon named like an app
  // is not pulled into Apps. ppid-walk is helpers-only (node/zsh do not nest
  // under Cursor); same-name copies still group within their own section.
  function sectionKey(p) {
    if (p && p.type === 'app') return 'app';
    if (p && p.type === 'system') return 'system';
    return 'background';
  }

  function resolveGroupKey(p, byPid) {
    if (p.iconPath) return 'app:' + p.iconPath;
    if (isHelperProc(p)) {
      var seen = {};
      var cur = p;
      while (cur && cur.ppid && !seen[cur.pid]) {
        seen[cur.pid] = true;
        var parent = byPid[cur.ppid];
        if (!parent) break;
        if (parent.iconPath) return 'app:' + parent.iconPath;
        cur = parent;
      }
    }
    return 'name:' + sectionKey(p) + ':' + (p.name || ('PID ' + p.pid));
  }

  function clusterSectionType(members) {
    var hasApp = false;
    var allSystem = true;
    for (var i = 0; i < members.length; i++) {
      var t = members[i].type;
      if (t === 'app') hasApp = true;
      if (t !== 'system') allSystem = false;
    }
    if (hasApp) return 'app';
    if (allSystem) return 'system';
    return 'background';
  }

  function pickParent(members) {
    var best = members[0];
    var bestScore = -1;
    for (var i = 0; i < members.length; i++) {
      var p = members[i];
      var score = 0;
      if (p.type === 'app') score += 4;
      if (!isHelperProc(p)) score += 2;
      if (p.bundleName && p.name === p.bundleName) score += 1;
      if (score > bestScore || (score === bestScore && num(p.pid) < num(best.pid))) {
        best = p;
        bestScore = score;
      }
    }
    return best;
  }

  function procMatchesQuery(p, q) {
    if (!q) return true;
    if ((p.name || '').toLowerCase().indexOf(q) !== -1) return true;
    if ((p.bundleName || '').toLowerCase().indexOf(q) !== -1) return true;
    if (String(p.pid).indexOf(q) !== -1) return true;
    if ((p.command || '').toLowerCase().indexOf(q) !== -1) return true;
    return false;
  }

  // ---- Aggregate header percent for numeric columns ------------------------
  function aggForColumn(statKind, stats) {
    if (!stats) return null;
    try {
      switch (statKind) {
        case 'cpu':
          return stats.cpu ? stats.cpu.load : null;
        case 'mem':
          return stats.mem ? stats.mem.percent : null;
        case 'disk': {
          // Win11 disk header is a % busy; mac rarely reports it -> may be null.
          if (Array.isArray(stats.disks) && stats.disks.length) {
            var p = stats.disks[0].percent;
            return (p === null || p === undefined) ? null : p;
          }
          return null;
        }
        case 'net':
          return null; // network header has no single % in Win11; left blank
        case 'gpu':
          return stats.gpu ? stats.gpu.utilization : null;
        default:
          return null;
      }
    } catch (e) {
      return null;
    }
  }

  // ===========================================================================
  // View object
  // ===========================================================================
  var view = {
    id: 'processes',
    title: 'Processes',
    icon: ICON,

    _root: null,
    _tbody: null,
    _thead: null,
    _wrap: null,
    _endBtn: null,
    _mounted: false,

    mount: function (container) {
      ensureStyles();
      this._root = container;
      container.innerHTML = '';

      var root = document.createElement('div');
      root.className = 'tm-proc';

      // ---- Command bar ----
      var bar = document.createElement('div');
      bar.className = 'tm-proc-cmdbar';

      var runBtn = makeButton('Run new task', ICON_RUN, false);
      var endBtn = makeButton('End task', ICON_END, false);
      endBtn.classList.add('tm-proc-btn-end');
      endBtn.disabled = true; // enabled only when a process row is selected

      this._endBtn = endBtn;
      var self = this;
      runBtn.addEventListener('click', function () { self._openRunDialog(); });
      endBtn.addEventListener('click', function () { self._endSelected(false); });

      bar.appendChild(runBtn);
      bar.appendChild(endBtn);
      bar.appendChild(makeSpacer());

      // ---- Table ----
      var wrap = document.createElement('div');
      wrap.className = 'tm-proc-tablewrap';

      var table = document.createElement('table');
      table.className = 'tm-proc-table';

      var colgroup = document.createElement('colgroup');
      for (var ci = 0; ci < COLUMNS.length; ci++) {
        var col = document.createElement('col');
        if (COLUMNS[ci].key === 'name') col.className = 'c-name';
        else if (COLUMNS[ci].key === 'state') col.className = 'c-status';
        else col.className = 'c-num';
        colgroup.appendChild(col);
      }
      table.appendChild(colgroup);

      var thead = document.createElement('thead');
      var headRow = document.createElement('tr');
      headRow.addEventListener('click', function (e) {
        var th = e.target.closest ? e.target.closest('th[data-key]') : null;
        if (th) self._onSort(th.getAttribute('data-key'));
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      // Event delegation: select / context menu / group toggle.
      tbody.addEventListener('click', function (e) {
        var expander = e.target.closest ? e.target.closest('.row-expander') : null;
        if (expander) {
          var expRow = expander.closest ? expander.closest('.tm-proc-row') : null;
          if (expRow) self._toggleAppGroup(expRow.getAttribute('data-group-key'));
          return;
        }
        var group = e.target.closest ? e.target.closest('.tm-grouprow') : null;
        if (group) { self._toggleGroup(group.getAttribute('data-group')); return; }
        var row = e.target.closest ? e.target.closest('.tm-proc-row') : null;
        if (row) self._selectRow(parseInt(row.getAttribute('data-pid'), 10));
      });
      tbody.addEventListener('contextmenu', function (e) {
        var row = e.target.closest ? e.target.closest('.tm-proc-row') : null;
        if (!row) return;
        e.preventDefault();
        var pid = parseInt(row.getAttribute('data-pid'), 10);
        self._selectRow(pid);
        self._showMenu(e.clientX, e.clientY, pid);
      });
      table.appendChild(tbody);

      // Re-render the visible window on scroll (rAF-throttled, only ~visible rows).
      var scrollPending = false;
      wrap.addEventListener('scroll', function () {
        if (scrollPending) return;
        scrollPending = true;
        requestAnimationFrame(function () { scrollPending = false; self._renderWindow(); });
      });

      wrap.appendChild(table);
      root.appendChild(bar);
      root.appendChild(wrap);
      container.appendChild(root);

      this._thead = headRow;
      this._tbody = tbody;
      this._wrap = wrap;
      this._mounted = true;

      this._renderHeader(TM.state);
      this.update(TM.state);
    },

    unmount: function () {
      this._mounted = false;
      this._root = this._tbody = this._thead = this._wrap = this._endBtn = null;
      this._groupPids = {};
      this._flatItems = [];
    },

    // ---- Per-tick render ----
    update: function (state) {
      if (!this._mounted || !this._tbody) return;
      try {
        state = state || TM.state;
        this._renderHeader(state);
        this._rebuildFlat(state);
        this._renderWindow();
        // End-task button enabled only with a live selection present.
        var sel = state.ui.selectedPid;
        var exists = sel != null && hasPid(state.data.processes, sel);
        if (this._endBtn) this._endBtn.disabled = !exists;
      } catch (err) {
        if (console && console.error) console.error('processes.update error:', err);
      }
    },

    // ---- Header (labels + aggregate % + sort indicator) ----
    _renderHeader: function (state) {
      if (!this._thead) return;
      var ui = state.ui;
      var stats = state.data.stats;
      var html = '';
      for (var i = 0; i < COLUMNS.length; i++) {
        var col = COLUMNS[i];
        var cls = 'th' + (col.numeric ? ' num' : '');
        if (ui.sortKey === col.key) cls += ' sorted';
        var caret = '';
        if (ui.sortKey === col.key) {
          caret = '<span class="sortcaret">' + (ui.sortDir === 'asc' ? '▲' : '▼') + '</span>';
        }
        var agg = '';
        if (col.numeric) {
          var v = aggForColumn(col.statKind, stats);
          agg = '<span class="agg">' + (v === null || v === undefined ? '&nbsp;' : fmt.percentHeader(v)) + '</span>';
        }
        html += '<th class="' + cls + '" data-key="' + col.key + '" title="' +
          col.label + '">' + escapeHtml(col.label) + caret + agg + '</th>';
      }
      this._thead.innerHTML = html;
    },

    // ---- Build the flat, ordered list of render items (group + proc rows) ----
    // Heavy work (filter/bucket/sort) runs here once per tick; the actual DOM
    // render only touches the visible window (see _renderWindow), so a 700-row
    // table no longer rebuilds in full each tick — that was the micro-freeze.
    _rebuildFlat: function (state) {
      var ui = state.ui;
      var procs = Array.isArray(state.data.processes) ? state.data.processes : [];
      this._stats = state.data.stats;
      this._selectedPid = ui.selectedPid;
      this._groupPids = {};

      var q = (ui.search || '').trim().toLowerCase();

      var byPid = {};
      for (var i = 0; i < procs.length; i++) {
        if (procs[i]) byPid[procs[i].pid] = procs[i];
      }

      var clusters = {};
      var clusterKeys = [];
      for (var pi = 0; pi < procs.length; pi++) {
        var p = procs[pi];
        if (!p) continue;
        var key = resolveGroupKey(p, byPid);
        if (!clusters[key]) {
          clusters[key] = [];
          clusterKeys.push(key);
        }
        clusters[key].push(p);
      }

      var buckets = { app: [], background: [], system: [] };
      var matchedAny = false;

      for (var ck = 0; ck < clusterKeys.length; ck++) {
        var ckey = clusterKeys[ck];
        var members = clusters[ckey];
        if (q) {
          var anyMatch = false;
          for (var mi = 0; mi < members.length; mi++) {
            if (procMatchesQuery(members[mi], q)) { anyMatch = true; break; }
          }
          if (!anyMatch) continue;
        }
        matchedAny = true;

        var parent = pickParent(members);
        var sumCpu = 0, sumMem = 0, sumNet = 0, sumMemPct = 0;
        var pids = [];
        for (var s = 0; s < members.length; s++) {
          sumCpu += num(members[s].cpu);
          sumMem += num(members[s].memBytes);
          sumNet += num(members[s].netBytesSec);
          sumMemPct += num(members[s].memPercent);
          pids.push(members[s].pid);
        }

        var display = {
          pid: parent.pid,
          ppid: parent.ppid,
          name: (ckey.indexOf('app:') === 0 && parent.bundleName)
            ? parent.bundleName
            : parent.name,
          cpu: sumCpu,
          memBytes: sumMem,
          memPercent: sumMemPct,
          netBytesSec: sumNet,
          state: parent.state,
          path: parent.path,
          iconPath: parent.iconPath,
          command: parent.command,
          type: parent.type,
          bundleName: parent.bundleName
        };

        var children = [];
        for (var ch = 0; ch < members.length; ch++) {
          if (members[ch].pid !== parent.pid) children.push(members[ch]);
        }
        children.sort(compareNamePid);

        var hasKids = children.length > 0;
        var treeOpen = hasKids && (!!q || ui.expanded[ckey] === true);
        if (hasKids) this._groupPids[parent.pid] = pids;

        var section = clusterSectionType(members);
        buckets[section].push({
          proc: display,
          children: children,
          hasKids: hasKids,
          expanded: treeOpen,
          groupKey: ckey
        });
      }

      var sortKey = ui.sortKey || 'cpu';
      var sortDir = ui.sortDir || 'desc';

      var items = [];
      for (var g = 0; g < GROUPS.length; g++) {
        var grp = GROUPS[g];
        var listG = buckets[grp.type];
        listG.sort(function (a, b) { return compareProcs(a.proc, b.proc, sortKey, sortDir); });
        var expanded = ui.expanded[grp.key] !== false;
        var gCpu = 0, gMem = 0, gNet = 0;
        for (var gs = 0; gs < listG.length; gs++) {
          gCpu += num(listG[gs].proc.cpu);
          gMem += num(listG[gs].proc.memBytes);
          gNet += num(listG[gs].proc.netBytesSec);
        }
        items.push({ kind: 'group', grp: grp, count: listG.length, expanded: expanded,
          sumCpu: gCpu, sumMem: gMem, sumNet: gNet });
        if (expanded) {
          for (var r = 0; r < listG.length; r++) {
            var row = listG[r];
            items.push({
              kind: 'proc',
              proc: row.proc,
              depth: 0,
              childCount: row.hasKids ? row.children.length : 0,
              expanded: row.expanded,
              groupKey: row.groupKey
            });
            if (row.expanded) {
              for (var cr = 0; cr < row.children.length; cr++) {
                items.push({
                  kind: 'proc',
                  proc: row.children[cr],
                  depth: 1,
                  childCount: 0,
                  expanded: false,
                  groupKey: ''
                });
              }
            }
          }
        }
      }
      this._flatItems = items;
      this._emptyMsg = (!matchedAny && procs.length === 0)
        ? 'No processes.'
        : (!matchedAny && q)
          ? 'No processes match “' + escapeHtml(ui.search) + '”'
          : null;
    },

    // ---- Render only the rows in (and just around) the viewport ----
    _renderWindow: function () {
      if (!this._tbody || !this._wrap) return;
      var cols = COLUMNS.length;
      if (this._emptyMsg != null) {
        this._tbody.innerHTML = '<tr><td class="tm-proc-empty" colspan="' + cols + '">' +
          this._emptyMsg + '</td></tr>';
        return;
      }
      var items = this._flatItems || [];
      var total = items.length;
      var rh = ROW_H;
      var vh = this._wrap.clientHeight || 600;
      var scrollTop = this._wrap.scrollTop || 0;
      var BUFFER = 8;
      var start = Math.max(0, Math.floor(scrollTop / rh) - BUFFER);
      var end = Math.min(total, Math.ceil((scrollTop + vh) / rh) + BUFFER);
      var topH = start * rh;
      var botH = (total - end) * rh;

      var html = '';
      if (topH > 0) html += '<tr class="tm-spacer"><td colspan="' + cols + '" style="height:' + topH + 'px"></td></tr>';
      for (var i = start; i < end; i++) {
        var it = items[i];
        if (it.kind === 'group') html += this._groupRowHtml(it);
        else html += this._procRowHtml(it);
      }
      if (botH > 0) html += '<tr class="tm-spacer"><td colspan="' + cols + '" style="height:' + botH + 'px"></td></tr>';
      this._tbody.innerHTML = html;
    },

    _groupRowHtml: function (item) {
      var grp = item.grp;
      var cls = 'tm-grouprow' + (item.expanded ? '' : ' collapsed');
      var label = '<span class="ghead">' + ICON_CHEV +
        '<span class="glabel">' + escapeHtml(grp.label) + '</span>' +
        '<span class="gcount">' + item.count + '</span></span>';
      return '<tr class="' + cls + '" data-group="' + grp.key + '">' +
        '<td class="gname" colspan="2">' + label + '</td>' +
        '<td class="num gsum">' + fmt.percentCell(item.sumCpu) + '</td>' +
        '<td class="num gsum">' + fmt.bytes(item.sumMem) + '</td>' +
        '<td class="num gsum">0 MB/s</td>' +
        '<td class="num gsum">' + (item.sumNet > 0 ? fmt.bytesPerSec(item.sumNet) : '0 KB/s') + '</td>' +
        '<td class="num gsum">' + fmt.dash + '</td>' +
        '</tr>';
    },

    _procRowHtml: function (item) {
      var proc = item.proc;
      var selectedPid = this._selectedPid;
      var stats = this._stats;
      var selected = (proc.pid === selectedPid);
      var rowCls = 'tm-proc-row' + (selected ? ' selected' : '');
      if (item.depth) rowCls += ' child';
      if (item.childCount > 0) rowCls += item.expanded ? ' expanded' : ' collapsed';
      var cells = '';
      for (var i = 0; i < COLUMNS.length; i++) {
        var col = COLUMNS[i];
        var text = escapeHtml(cellText(col, proc));
        if (col.numeric) {
          var heat = heatClass(col, proc, stats);
          cells += '<td class="num ' + heat + '">' + text + '</td>';
        } else if (col.key === 'name') {
          cells += '<td class="name" title="' + escapeHtml(proc.command || proc.path || proc.name || '') +
            '">' + nameCellInner(proc, { childCount: item.childCount, expanded: item.expanded }) + '</td>';
        } else {
          cells += '<td class="status">' + text + '</td>';
        }
      }
      var attrs = ' class="' + rowCls + '" data-pid="' + proc.pid + '"';
      if (item.groupKey) attrs += ' data-group-key="' + escapeHtml(item.groupKey) + '"';
      return '<tr' + attrs + '>' + cells + '</tr>';
    },

    // ---- Interactions ----
    _onSort: function (key) {
      if (!key) return;
      var ui = TM.state.ui;
      if (ui.sortKey === key) {
        TM.state.set({ ui: { sortDir: ui.sortDir === 'asc' ? 'desc' : 'asc' } });
      } else {
        // New column: numeric defaults to desc (biggest first), text to asc.
        var col = COLUMNS.filter(function (c) { return c.key === key; })[0];
        var dir = (col && !col.numeric) ? 'asc' : 'desc';
        TM.state.set({ ui: { sortKey: key, sortDir: dir } });
      }
    },

    _toggleGroup: function (groupKey) {
      if (!groupKey) return;
      var cur = TM.state.ui.expanded[groupKey] !== false;
      var patch = {};
      patch[groupKey] = !cur;
      TM.state.set({ ui: { expanded: patch } });
    },

    // App trees default collapsed (absent key === false), unlike category rows.
    _toggleAppGroup: function (groupKey) {
      if (!groupKey) return;
      var cur = TM.state.ui.expanded[groupKey] === true;
      var patch = {};
      patch[groupKey] = !cur;
      TM.state.set({ ui: { expanded: patch } });
    },

    _selectRow: function (pid) {
      if (!isFinite(pid)) return;
      if (TM.state.ui.selectedPid === pid) return;
      TM.state.set({ ui: { selectedPid: pid } });
    },

    _endSelected: function (force) {
      var pid = TM.state.ui.selectedPid;
      if (pid == null) return;
      var pids = (this._groupPids && this._groupPids[pid]) || [pid];
      this._killPids(pids, force);
    },

    _killPid: function (pid, force) {
      this._killPids([pid], force);
    },

    _killPids: function (pids, force) {
      if (!window.api || typeof window.api.killProcess !== 'function') return;
      if (!pids || !pids.length) return;
      try {
        var selected = TM.state.ui.selectedPid;
        var jobs = [];
        for (var i = 0; i < pids.length; i++) {
          jobs.push(window.api.killProcess(pids[i], !!force));
        }
        Promise.all(jobs).then(function (results) {
          for (var r = 0; r < results.length; r++) {
            if (results[r] && results[r].ok === false && console && console.warn) {
              console.warn('End task failed for pid ' + pids[r] + ': ' + (results[r].error || 'unknown'));
            }
          }
          if (selected != null && pids.indexOf(selected) !== -1) {
            TM.state.set({ ui: { selectedPid: null } });
          }
        }).catch(function (err) {
          if (console && console.error) console.error('killProcess error:', err);
        });
      } catch (err) {
        if (console && console.error) console.error('killProcess threw:', err);
      }
    },

    _setPriority: function (pid, nice) {
      if (!window.api || typeof window.api.setPriority !== 'function') return;
      try {
        window.api.setPriority(pid, nice).catch(function (err) {
          if (console && console.error) console.error('setPriority error:', err);
        });
      } catch (err) {
        if (console && console.error) console.error('setPriority threw:', err);
      }
    },

    _reveal: function (path) {
      if (!path || !window.api || typeof window.api.revealInFinder !== 'function') return;
      try {
        window.api.revealInFinder(path).catch(function (err) {
          if (console && console.error) console.error('revealInFinder error:', err);
        });
      } catch (err) {
        if (console && console.error) console.error('revealInFinder threw:', err);
      }
    },

    _openRunDialog: function () {
      openRunDialog();
    },

    _showMenu: function (x, y, pid) {
      if (!TM.components || !TM.components.contextMenu) return;
      var proc = findPid(TM.state.data.processes, pid);
      if (!proc) return;
      var self = this;
      var hasPath = !!(proc.path && proc.path.length);

      var items = [
        { label: 'End task', danger: true, onClick: function () {
          var pids = (self._groupPids && self._groupPids[pid]) || [pid];
          self._killPids(pids, false);
        } },
        { separator: true },
        { label: 'Set priority (High)', onClick: function () { self._setPriority(pid, -10); } },
        { label: 'Set priority (Normal)', onClick: function () { self._setPriority(pid, 0); } },
        { label: 'Set priority (Low)', onClick: function () { self._setPriority(pid, 10); } },
        { separator: true },
        {
          label: 'Reveal in Finder',
          disabled: !hasPath,
          onClick: function () { self._reveal(proc.path); }
        }
      ];

      try {
        TM.components.contextMenu.show(x, y, items);
      } catch (err) {
        if (console && console.error) console.error('contextMenu.show error:', err);
      }
    }
  };

  // ---- "Run new task" modal -------------------------------------------------
  function openRunDialog() {
    if (document.getElementById('tm-run-dialog')) return;
    var overlay = document.createElement('div');
    overlay.id = 'tm-run-dialog';
    overlay.className = 'tm-modal-overlay';
    overlay.innerHTML =
      '<div class="tm-modal" role="dialog" aria-modal="true">' +
        '<div class="tm-modal-title">Run new task</div>' +
        '<div class="tm-modal-sub">Type a command or app to open — e.g. ' +
          '<code>open -a Safari</code>, <code>open .</code>, <code>top</code>.</div>' +
        '<input type="text" class="tm-modal-input" placeholder="Command…" ' +
          'autocomplete="off" spellcheck="false">' +
        '<div class="tm-modal-err"></div>' +
        '<div class="tm-modal-actions">' +
          '<button class="tm-modal-btn" data-act="cancel">Cancel</button>' +
          '<button class="tm-modal-btn primary" data-act="run">Run</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var input = overlay.querySelector('.tm-modal-input');
    var errEl = overlay.querySelector('.tm-modal-err');

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey, true);
    }
    function run() {
      var cmd = (input.value || '').trim();
      if (!cmd) { close(); return; }
      if (!window.api || typeof window.api.runNewTask !== 'function') { close(); return; }
      errEl.textContent = '';
      window.api.runNewTask(cmd).then(function (res) {
        if (res && res.ok) close();
        else errEl.textContent = (res && res.error) ? res.error : 'Could not run that command';
      }).catch(function () { errEl.textContent = 'Could not run that command'; });
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(); }
    }
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { close(); return; }
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      if (b.getAttribute('data-act') === 'cancel') close(); else run();
    });
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 30);
  }

  // ---- Small DOM helpers ----------------------------------------------------
  function makeButton(label, iconSvg, disabled) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tm-proc-btn';
    if (disabled) b.disabled = true;
    b.innerHTML = '<span class="tm-i">' + iconSvg + '</span><span>' + escapeHtml(label) + '</span>';
    return b;
  }

  function makeSpacer() {
    var s = document.createElement('span');
    s.className = 'tm-proc-spacer';
    return s;
  }

  function hasPid(list, pid) {
    return !!findPid(list, pid);
  }

  function findPid(list, pid) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].pid === pid) return list[i];
    }
    return null;
  }

  var ESC_RE = /[&<>"']/g;
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(ESC_RE, function (c) { return ESC_MAP[c]; });
  }

  TM.views.processes = view;
})();
