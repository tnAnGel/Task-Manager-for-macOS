// views/details.js — TM.views.details
// A flat (ungrouped) high-density table of ALL processes, like the Windows
// Task Manager "Details" tab. Columns: Name | PID | Status | User name | CPU |
// Memory (active private bytes ~ memBytes) | Command line.
// Sortable, searchable (reuses TM.state.ui.search), row-select, right-click
// context menu (End task -> window.api.killProcess, Set priority, Reveal in
// Finder, Properties). Plain rows (no heat coloring), tabular numbers.
(function () {
  'use strict';
  window.TM = window.TM || {};
  TM.views = TM.views || {};

  // --- one-time injected styles (scoped to .dt-*) so this view renders
  //     correctly even if processes.css doesn't cover the details layout. ---
  var STYLE_ID = 'tm-details-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.dt-root{display:flex;flex-direction:column;height:100%;min-height:0;' +
        'background:var(--bg-content);color:var(--text-primary);' +
        'font-family:var(--font-ui);font-size:var(--fs-md);}' +
      '.dt-commandbar{display:flex;align-items:center;gap:var(--sp-2);' +
        'height:var(--commandbar-h);padding:0 var(--sp-3);flex:0 0 auto;' +
        'background:var(--bg-elevated);border-bottom:1px solid var(--border);}' +
      '.dt-btn{display:inline-flex;align-items:center;gap:var(--sp-2);' +
        'height:30px;padding:0 var(--sp-3);border:1px solid var(--border-subtle);' +
        'border-radius:var(--r-sm);background:var(--bg-input);' +
        'color:var(--text-primary);font-family:var(--font-ui);' +
        'font-size:var(--fs-sm);cursor:pointer;-webkit-app-region:no-drag;}' +
      '.dt-btn:hover:not(:disabled){background:var(--row-hover);}' +
      '.dt-btn:disabled{color:var(--text-disabled);cursor:default;opacity:.6;}' +
      '.dt-btn.danger:not(:disabled){color:var(--danger);' +
        'border-color:var(--danger);}' +
      '.dt-btn.danger:hover:not(:disabled){background:var(--danger-bg);}' +
      '.dt-btn svg{width:16px;height:16px;}' +
      '.dt-spacer{flex:1 1 auto;}' +
      '.dt-count{color:var(--text-tertiary);font-size:var(--fs-sm);' +
        'white-space:nowrap;}' +
      '.dt-scroll{flex:1 1 auto;min-height:0;overflow:auto;}' +
      '.dt-table{width:100%;border-collapse:collapse;table-layout:fixed;}' +
      '.dt-table th,.dt-table td{text-align:left;padding:0 var(--sp-3);' +
        'height:var(--row-h);line-height:var(--row-h);white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis;' +
        'border-bottom:1px solid var(--row-stripe);}' +
      '.dt-table thead th{position:sticky;top:0;z-index:2;' +
        'background:var(--bg-header);color:var(--text-secondary);' +
        'font-weight:var(--fw-semibold);font-size:var(--fs-sm);' +
        'border-bottom:1px solid var(--border);cursor:pointer;' +
        'user-select:none;}' +
      '.dt-table thead th:hover{background:var(--row-hover);}' +
      '.dt-table thead th .dt-arrow{margin-left:6px;font-size:10px;' +
        'color:var(--text-tertiary);}' +
      '.dt-num{text-align:right;font-family:var(--font-num);' +
        'font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}' +
      '.dt-mono{font-family:var(--font-num);font-variant-numeric:tabular-nums;}' +
      '.dt-cmd{color:var(--text-tertiary);font-size:var(--fs-sm);}' +
      '.dt-row{cursor:default;}' +
      '.dt-row:hover{background:var(--row-hover);}' +
      '.dt-row.selected{background:var(--row-selected);' +
        'box-shadow:inset 2px 0 0 var(--row-selected-accent);}' +
      '.dt-name{display:flex;align-items:center;gap:var(--sp-2);}' +
      '.dt-name .dt-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;}' +
      '.dt-name .dt-label{overflow:hidden;text-overflow:ellipsis;}' +
      '.dt-status{display:inline-flex;align-items:center;gap:6px;' +
        'color:var(--text-secondary);}' +
      '.dt-status .dt-sdot{width:7px;height:7px;border-radius:50%;' +
        'background:var(--text-tertiary);}' +
      '.dt-status.running .dt-sdot{background:var(--success);}' +
      '.dt-status.suspended .dt-sdot,.dt-status.stopped .dt-sdot{' +
        'background:var(--warning);}' +
      '.dt-status.zombie .dt-sdot{background:var(--danger);}' +
      '.dt-empty{padding:var(--sp-6);text-align:center;' +
        'color:var(--text-tertiary);}' +
      // colgroup widths
      '.dt-c-name{width:24%;}.dt-c-pid{width:70px;}.dt-c-status{width:110px;}' +
      '.dt-c-user{width:130px;}.dt-c-cpu{width:72px;}.dt-c-mem{width:120px;}' +
      '.dt-c-cmd{width:auto;}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  // --- column definitions ---
  // key matches the sort key; some derive from Process fields.
  var COLUMNS = [
    { key: 'name',    label: 'Name',         cls: 'dt-c-name',   align: 'left'  },
    { key: 'pid',     label: 'PID',          cls: 'dt-c-pid',    align: 'right' },
    { key: 'state',   label: 'Status',       cls: 'dt-c-status', align: 'left'  },
    { key: 'user',    label: 'User name',    cls: 'dt-c-user',   align: 'left'  },
    { key: 'cpu',     label: 'CPU',          cls: 'dt-c-cpu',    align: 'right' },
    { key: 'memBytes',label: 'Memory',       cls: 'dt-c-mem',    align: 'right' },
    { key: 'command', label: 'Command line', cls: 'dt-c-cmd',    align: 'left'  }
  ];

  var STATUS_LABELS = {
    running: 'Running',
    sleeping: 'Running',     // Windows shows sleeping user procs as Running
    stopped: 'Suspended',
    suspended: 'Suspended',
    zombie: 'Not responding',
    idle: 'Running',
    waiting: 'Running'
  };

  var TYPE_COLORS = {
    app: 'var(--accent)',
    background: 'var(--text-tertiary)',
    system: 'var(--text-disabled)'
  };

  // --- helpers (defensive; do not assume TM.format exists at all costs) ---
  function fmtBytes(n) {
    try {
      if (TM.format && typeof TM.format.bytes === 'function') {
        return TM.format.bytes(n);
      }
    } catch (e) { /* fall through */ }
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n < 1024 * 1024 * 1024) {
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }
  function fmtCpu(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toFixed(1) + '%';
  }
  function fmtNumber(n) {
    try {
      if (TM.format && typeof TM.format.number === 'function') {
        return TM.format.number(n);
      }
    } catch (e) { /* fall through */ }
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    return n.toLocaleString('en-US');
  }
  function statusInfo(state) {
    var s = (state || '').toLowerCase();
    var label = STATUS_LABELS[s] || (state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Running');
    var cls = 'running';
    if (s === 'stopped' || s === 'suspended') cls = 'suspended';
    else if (s === 'zombie') cls = 'zombie';
    return { label: label, cls: cls };
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- the view ---
  TM.views.details = {
    id: 'details',
    title: 'Details',
    icon:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
        'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ' +
        'stroke-linejoin="round">' +
        '<circle cx="2.4" cy="3.5" r=".9" fill="currentColor" stroke="none"/>' +
        '<line x1="5.5" y1="3.5" x2="14" y2="3.5"/>' +
        '<circle cx="2.4" cy="8" r=".9" fill="currentColor" stroke="none"/>' +
        '<line x1="5.5" y1="8" x2="14" y2="8"/>' +
        '<circle cx="2.4" cy="12.5" r=".9" fill="currentColor" stroke="none"/>' +
        '<line x1="5.5" y1="12.5" x2="14" y2="12.5"/>' +
      '</svg>',

    // internal refs
    _container: null,
    _tbody: null,
    _theadCells: null,
    _countEl: null,
    _endBtn: null,
    _priBtn: null,
    _lastRows: null,        // cached array of rendered process objects (by index)
    _lastSig: '',           // signature of last render to skip redundant work

    mount: function (containerEl) {
      ensureStyles();
      this._container = containerEl;
      containerEl.innerHTML = '';

      var root = document.createElement('div');
      root.className = 'dt-root';

      // ---- command bar ----
      var bar = document.createElement('div');
      bar.className = 'dt-commandbar';

      var endBtn = document.createElement('button');
      endBtn.className = 'dt-btn danger';
      endBtn.type = 'button';
      endBtn.disabled = true;
      endBtn.innerHTML =
        '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
          'stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
          '<line x1="4" y1="4" x2="12" y2="12"/>' +
          '<line x1="12" y1="4" x2="4" y2="12"/></svg>' +
        '<span>End task</span>';
      endBtn.addEventListener('click', function () {
        var self = TM.views.details;
        var pid = TM.state && TM.state.ui ? TM.state.ui.selectedPid : null;
        if (pid != null) self._endTask(pid, false);
      });

      var priBtn = document.createElement('button');
      priBtn.className = 'dt-btn';
      priBtn.type = 'button';
      priBtn.disabled = true;
      priBtn.textContent = 'Set priority';
      priBtn.addEventListener('click', function (ev) {
        var pid = TM.state && TM.state.ui ? TM.state.ui.selectedPid : null;
        if (pid == null) return;
        var proc = TM.views.details._findProc(pid);
        var r = priBtn.getBoundingClientRect();
        TM.views.details._showPriorityMenu(r.left, r.bottom + 2, proc);
      });

      var spacer = document.createElement('div');
      spacer.className = 'dt-spacer';

      var count = document.createElement('div');
      count.className = 'dt-count';
      count.textContent = '';

      bar.appendChild(endBtn);
      bar.appendChild(priBtn);
      bar.appendChild(spacer);
      bar.appendChild(count);

      // ---- table ----
      var scroll = document.createElement('div');
      scroll.className = 'dt-scroll';

      var table = document.createElement('table');
      table.className = 'dt-table';

      var colgroup = document.createElement('colgroup');
      COLUMNS.forEach(function (c) {
        var col = document.createElement('col');
        col.className = c.cls;
        colgroup.appendChild(col);
      });
      table.appendChild(colgroup);

      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      this._theadCells = [];
      var self = this;
      COLUMNS.forEach(function (c) {
        var th = document.createElement('th');
        th.dataset.key = c.key;
        if (c.align === 'right') th.classList.add('dt-num');
        th.innerHTML = '<span class="dt-th-label">' + esc(c.label) +
          '</span><span class="dt-arrow"></span>';
        th.addEventListener('click', function () { self._toggleSort(c.key); });
        htr.appendChild(th);
        self._theadCells.push(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      table.appendChild(tbody);

      // row interactions (event delegation)
      tbody.addEventListener('click', function (ev) {
        var tr = ev.target.closest('tr');
        if (!tr || !tr.dataset.pid) return;
        self._select(Number(tr.dataset.pid));
      });
      tbody.addEventListener('dblclick', function (ev) {
        var tr = ev.target.closest('tr');
        if (!tr || !tr.dataset.pid) return;
        var proc = self._findProc(Number(tr.dataset.pid));
        if (proc && proc.path) self._reveal(proc.path);
      });
      tbody.addEventListener('contextmenu', function (ev) {
        var tr = ev.target.closest('tr');
        if (!tr || !tr.dataset.pid) return;
        ev.preventDefault();
        var pid = Number(tr.dataset.pid);
        self._select(pid);
        self._showRowMenu(ev.clientX, ev.clientY, self._findProc(pid));
      });

      scroll.appendChild(table);
      root.appendChild(bar);
      root.appendChild(scroll);
      containerEl.appendChild(root);

      this._tbody = tbody;
      this._countEl = count;
      this._endBtn = endBtn;
      this._priBtn = priBtn;
      this._lastSig = '';
      this._lastRows = null;

      this._renderHeader();
      this.update(TM.state);
    },

    update: function (state) {
      if (!this._tbody) return;
      state = state || TM.state || {};
      var ui = state.ui || (TM.state && TM.state.ui) || {};
      var data = state.data || (TM.state && TM.state.data) || {};
      var procs = (data.processes || []).slice();

      // search filter
      var q = (ui.search || '').trim().toLowerCase();
      if (q) {
        procs = procs.filter(function (p) {
          return (p.name && p.name.toLowerCase().indexOf(q) !== -1) ||
                 (p.user && p.user.toLowerCase().indexOf(q) !== -1) ||
                 (p.command && p.command.toLowerCase().indexOf(q) !== -1) ||
                 String(p.pid).indexOf(q) !== -1;
        });
      }

      // sort
      var sortKey = ui.sortKey || 'cpu';
      var sortDir = ui.sortDir || 'desc';
      // if active sortKey isn't one of our columns, default sensibly
      var known = COLUMNS.some(function (c) { return c.key === sortKey; });
      if (!known) sortKey = 'cpu';
      this._sort(procs, sortKey, sortDir);

      this._renderHeader(sortKey, sortDir);

      // selection / button state
      var selectedPid = ui.selectedPid;
      var selExists = procs.some(function (p) { return p.pid === selectedPid; });
      this._endBtn.disabled = !selExists;
      this._priBtn.disabled = !selExists;

      // signature to skip rebuild when nothing visible changed
      var sig = sortKey + '|' + sortDir + '|' + q + '|' + procs.length + '|' +
        selectedPid + '|' + procs.map(function (p) {
          return p.pid + ':' + (p.cpu | 0) + ':' + Math.round(p.memBytes / 1048576) +
            ':' + p.state;
        }).join(',');
      if (sig === this._lastSig) return;
      this._lastSig = sig;

      this._renderRows(procs, selectedPid);

      // count text
      var total = (data.processes || []).length;
      var shown = procs.length;
      this._countEl.textContent = q
        ? (shown + ' of ' + total + ' processes')
        : (total + ' processes');
    },

    unmount: function () {
      // detach delegated listeners by dropping the container; app.js re-mounts.
      if (this._container) this._container.innerHTML = '';
      this._container = null;
      this._tbody = null;
      this._theadCells = null;
      this._countEl = null;
      this._endBtn = null;
      this._priBtn = null;
      this._lastSig = '';
      this._lastRows = null;
    },

    // ---------------- internals ----------------
    _findProc: function (pid) {
      var data = (TM.state && TM.state.data) || {};
      var list = data.processes || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].pid === pid) return list[i];
      }
      return null;
    },

    _sort: function (arr, key, dir) {
      var mul = dir === 'asc' ? 1 : -1;
      arr.sort(function (a, b) {
        var av = a[key], bv = b[key];
        if (key === 'name' || key === 'user' || key === 'state' || key === 'command') {
          av = (av || '').toLowerCase();
          bv = (bv || '').toLowerCase();
          if (av < bv) return -1 * mul;
          if (av > bv) return 1 * mul;
          // stable tiebreak by pid
          return (a.pid - b.pid) * mul;
        }
        // numeric
        av = typeof av === 'number' ? av : 0;
        bv = typeof bv === 'number' ? bv : 0;
        if (av < bv) return -1 * mul;
        if (av > bv) return 1 * mul;
        return (a.pid - b.pid) * mul;
      });
    },

    _toggleSort: function (key) {
      var ui = TM.state && TM.state.ui;
      if (!ui) return;
      var dir;
      if (ui.sortKey === key) {
        dir = ui.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        // default: text asc, numbers desc
        dir = (key === 'name' || key === 'user' || key === 'state' ||
               key === 'command') ? 'asc' : 'desc';
      }
      if (TM.state.set) {
        TM.state.set({ ui: Object.assign({}, ui, { sortKey: key, sortDir: dir }) });
      } else {
        ui.sortKey = key; ui.sortDir = dir;
      }
      // re-render immediately (set() may or may not emit synchronously)
      this._lastSig = '';
      this.update(TM.state);
    },

    _select: function (pid) {
      var ui = TM.state && TM.state.ui;
      if (!ui) return;
      if (TM.state.set) {
        TM.state.set({ ui: Object.assign({}, ui, { selectedPid: pid }) });
      } else {
        ui.selectedPid = pid;
      }
      // update row highlight + buttons without full rebuild
      this._applySelection(pid);
      this._endBtn.disabled = false;
      this._priBtn.disabled = false;
    },

    _applySelection: function (pid) {
      if (!this._tbody) return;
      var rows = this._tbody.children;
      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        if (Number(tr.dataset.pid) === pid) tr.classList.add('selected');
        else tr.classList.remove('selected');
      }
    },

    _renderHeader: function (sortKey, sortDir) {
      if (!this._theadCells) return;
      this._theadCells.forEach(function (th) {
        var arrow = th.querySelector('.dt-arrow');
        if (!arrow) return;
        if (th.dataset.key === sortKey) {
          arrow.textContent = sortDir === 'asc' ? '▲' : '▼';
        } else {
          arrow.textContent = '';
        }
      });
    },

    _renderRows: function (procs, selectedPid) {
      var html = [];
      if (!procs.length) {
        this._tbody.innerHTML =
          '<tr><td colspan="' + COLUMNS.length + '" class="dt-empty">' +
          'No matching processes.</td></tr>';
        return;
      }
      for (var i = 0; i < procs.length; i++) {
        var p = procs[i];
        var st = statusInfo(p.state);
        var dotColor = TYPE_COLORS[p.type] || 'var(--text-tertiary)';
        var name = esc(p.name || '(unknown)');
        var cmd = esc(p.command || p.path || '');
        var sel = p.pid === selectedPid ? ' selected' : '';
        html.push(
          '<tr class="dt-row' + sel + '" data-pid="' + p.pid + '">' +
            '<td><span class="dt-name">' +
              '<span class="dt-dot" style="background:' + dotColor + '"></span>' +
              '<span class="dt-label" title="' + name + '">' + name + '</span>' +
            '</span></td>' +
            '<td class="dt-num dt-mono">' + p.pid + '</td>' +
            '<td><span class="dt-status ' + st.cls + '">' +
              '<span class="dt-sdot"></span>' + esc(st.label) + '</span></td>' +
            '<td title="' + esc(p.user || '') + '">' + esc(p.user || '—') + '</td>' +
            '<td class="dt-num dt-mono">' + fmtCpu(p.cpu) + '</td>' +
            '<td class="dt-num dt-mono" title="' + esc(fmtBytes(p.memBytes)) + '">' +
              fmtBytes(p.memBytes) + '</td>' +
            '<td class="dt-cmd" title="' + cmd + '">' + cmd + '</td>' +
          '</tr>'
        );
      }
      this._tbody.innerHTML = html.join('');
    },

    // ---------------- context menus + actions ----------------
    _showRowMenu: function (x, y, proc) {
      if (!proc) return;
      var self = this;
      var hasPath = !!(proc.path && proc.path.length);
      var items = [
        {
          label: 'End task', danger: true,
          onClick: function () { self._endTask(proc.pid, false); }
        },
        {
          label: 'Force quit', danger: true,
          onClick: function () { self._endTask(proc.pid, true); }
        },
        { separator: true },
        {
          label: 'Set priority',
          onClick: function () { self._showPriorityMenu(x, y, proc); }
        },
        {
          label: 'Reveal in Finder', disabled: !hasPath,
          onClick: function () { self._reveal(proc.path); }
        },
        { separator: true },
        {
          label: 'Properties',
          onClick: function () { self._showProperties(proc); }
        }
      ];
      this._menu(x, y, items);
    },

    _showPriorityMenu: function (x, y, proc) {
      if (!proc) return;
      var self = this;
      // Windows-style priority classes mapped to nice values (lower = higher prio)
      var levels = [
        { label: 'Realtime',     nice: -20 },
        { label: 'High',         nice: -10 },
        { label: 'Above normal', nice: -5  },
        { label: 'Normal',       nice: 0   },
        { label: 'Below normal', nice: 5   },
        { label: 'Low',          nice: 19  }
      ];
      var cur = typeof proc.nice === 'number' ? proc.nice : 0;
      var items = levels.map(function (lv) {
        return {
          label: (cur === lv.nice ? '✓ ' : '   ') + lv.label,
          onClick: function () { self._setPriority(proc.pid, lv.nice); }
        };
      });
      this._menu(x, y, items);
    },

    _menu: function (x, y, items) {
      if (TM.components && TM.components.contextMenu &&
          typeof TM.components.contextMenu.show === 'function') {
        TM.components.contextMenu.show(x, y, items);
      }
    },

    _endTask: function (pid, force) {
      if (!window.api || typeof window.api.killProcess !== 'function') return;
      try {
        Promise.resolve(window.api.killProcess(pid, !!force)).then(function (res) {
          if (res && res.ok === false) {
            console.warn('killProcess failed:', res.error);
          }
        }).catch(function (err) {
          console.warn('killProcess error:', err);
        });
      } catch (err) {
        console.warn('killProcess threw:', err);
      }
      // optimistic: clear selection so the End button disables next tick
      var ui = TM.state && TM.state.ui;
      if (ui && ui.selectedPid === pid && TM.state.set) {
        TM.state.set({ ui: Object.assign({}, ui, { selectedPid: null }) });
      }
    },

    _setPriority: function (pid, nice) {
      if (!window.api || typeof window.api.setPriority !== 'function') return;
      try {
        Promise.resolve(window.api.setPriority(pid, nice)).then(function (res) {
          if (res && res.ok === false) {
            console.warn('setPriority failed:', res.error);
          }
        }).catch(function (err) {
          console.warn('setPriority error:', err);
        });
      } catch (err) {
        console.warn('setPriority threw:', err);
      }
    },

    _reveal: function (path) {
      if (!path || !window.api || typeof window.api.revealInFinder !== 'function') return;
      try {
        Promise.resolve(window.api.revealInFinder(path)).then(function (res) {
          if (res && res.ok === false) {
            console.warn('revealInFinder failed:', res.error);
          }
        }).catch(function (err) {
          console.warn('revealInFinder error:', err);
        });
      } catch (err) {
        console.warn('revealInFinder threw:', err);
      }
    },

    _showProperties: function (proc) {
      if (!proc) return;
      // Lightweight properties flyout. Self-contained so it works regardless of
      // whether a shared dialog component exists.
      ensureStyles();
      var existing = document.getElementById('dt-props');
      if (existing) existing.remove();

      var rows = [
        ['Name', proc.name],
        ['PID', proc.pid],
        ['Parent PID', proc.ppid],
        ['Status', statusInfo(proc.state).label],
        ['User name', proc.user || '—'],
        ['Type', proc.type || '—'],
        ['CPU', fmtCpu(proc.cpu)],
        ['Memory', fmtBytes(proc.memBytes)],
        ['Memory %', typeof proc.memPercent === 'number'
          ? proc.memPercent.toFixed(1) + '%' : '—'],
        ['Nice', typeof proc.nice === 'number' ? proc.nice : '—'],
        ['Started', proc.started || '—'],
        ['Path', proc.path || '—'],
        ['Command line', proc.command || '—']
      ];

      var overlay = document.createElement('div');
      overlay.id = 'dt-props';
      overlay.setAttribute('style',
        'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,0.45);');

      var card = document.createElement('div');
      card.setAttribute('style',
        'min-width:420px;max-width:680px;max-height:80vh;overflow:auto;' +
        'background:var(--bg-menu);color:var(--text-primary);' +
        'border:1px solid var(--border-subtle);border-radius:var(--r-lg);' +
        'box-shadow:var(--shadow-flyout);font-family:var(--font-ui);' +
        'font-size:var(--fs-md);');

      var head = document.createElement('div');
      head.setAttribute('style',
        'display:flex;align-items:center;justify-content:space-between;' +
        'padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border);' +
        'font-weight:var(--fw-semibold);font-size:var(--fs-lg);');
      head.innerHTML = '<span>' + esc(proc.name || 'Properties') + '</span>';

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '✕';
      closeBtn.setAttribute('style',
        'background:none;border:none;color:var(--text-secondary);' +
        'font-size:14px;cursor:pointer;padding:4px 8px;border-radius:var(--r-sm);');
      closeBtn.addEventListener('mouseenter', function () {
        closeBtn.style.background = 'var(--row-hover)';
      });
      closeBtn.addEventListener('mouseleave', function () {
        closeBtn.style.background = 'none';
      });
      head.appendChild(closeBtn);

      var body = document.createElement('div');
      body.setAttribute('style', 'padding:var(--sp-3) var(--sp-4);');
      var tbl = document.createElement('table');
      tbl.setAttribute('style', 'width:100%;border-collapse:collapse;');
      var inner = rows.map(function (r) {
        var valStyle = (r[0] === 'Path' || r[0] === 'Command line')
          ? 'font-family:var(--font-num);word-break:break-all;white-space:normal;'
          : 'font-family:var(--font-num);';
        return '<tr>' +
          '<td style="padding:6px 12px 6px 0;color:var(--text-tertiary);' +
            'white-space:nowrap;vertical-align:top;">' + esc(r[0]) + '</td>' +
          '<td style="padding:6px 0;color:var(--text-primary);' + valStyle + '">' +
            esc(r[1] == null ? '—' : r[1]) + '</td>' +
          '</tr>';
      }).join('');
      tbl.innerHTML = inner;
      body.appendChild(tbl);

      card.appendChild(head);
      card.appendChild(body);
      overlay.appendChild(card);

      function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      closeBtn.addEventListener('click', close);
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
      });
      document.addEventListener('keydown', onKey);

      var root = document.getElementById('overlay-root') || document.body;
      root.appendChild(overlay);
    }
  };
})();
