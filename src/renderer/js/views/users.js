// TM.views.users — Users page.
// A flat table of UserSession from window.api.getUsers():
//   columns: User | Status | CPU (%) | Memory | Processes
// Fetches in mount() and re-fetches in update() throttled to every few ticks.
(function () {
  'use strict';
  window.TM = window.TM || {};
  TM.views = TM.views || {};

  // People glyph (16x16, currentColor) — two figures.
  var ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="6" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M1.5 13.5c0-2.2 2-3.6 4.5-3.6s4.5 1.4 4.5 3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<path d="M11 3.2a2.3 2.3 0 0 1 .3 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<path d="M11.8 9.6c1.9.2 3.2 1.5 3.2 3.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>';

  // Refresh every N poll ticks (~1.5s each) to keep things cheap.
  var REFRESH_EVERY = 3;

  var els = null;        // cached DOM references
  var tickCount = 0;     // number of update() calls since mount
  var users = [];        // last fetched UserSession[]
  var fetching = false;  // in-flight guard
  var loaded = false;    // got at least one successful payload
  var errored = false;   // last fetch failed

  function fmtBytes(n) {
    try {
      if (TM.format && typeof TM.format.bytes === 'function' &&
          typeof n === 'number' && isFinite(n)) {
        return TM.format.bytes(n);
      }
    } catch (e) { /* fall through */ }
    return '—';
  }

  function fmtPercentCell(n) {
    try {
      if (TM.format && typeof TM.format.percent === 'function' &&
          typeof n === 'number' && isFinite(n)) {
        return TM.format.percent(n);
      }
    } catch (e) { /* fall through */ }
    if (typeof n === 'number' && isFinite(n)) return n.toFixed(1) + '%';
    return '—';
  }

  function fmtCount(n) {
    try {
      if (TM.format && typeof TM.format.count === 'function' &&
          typeof n === 'number' && isFinite(n)) {
        return TM.format.count(n);
      }
    } catch (e) { /* fall through */ }
    if (typeof n === 'number' && isFinite(n)) return String(n);
    return '—';
  }

  // Heat bucket (0..5) for a 0-100 percent value, mirroring processes table.
  function heatBucket(pct) {
    if (typeof pct !== 'number' || !isFinite(pct) || pct <= 0) return 0;
    if (pct < 5) return 1;
    if (pct < 20) return 2;
    if (pct < 40) return 3;
    if (pct < 70) return 4;
    return 5;
  }

  function statusLabel(s) {
    return s === 'Disconnected' ? 'Disconnected' : 'Active';
  }

  function buildSkeleton(container) {
    container.innerHTML = '';

    var page = document.createElement('div');
    page.className = 'users-page';

    var head = document.createElement('div');
    head.className = 'users-head';
    var h = document.createElement('h2');
    h.className = 'users-title';
    h.textContent = 'Users';
    head.appendChild(h);
    page.appendChild(head);

    var tableWrap = document.createElement('div');
    tableWrap.className = 'users-table-wrap table-scroll';

    var table = document.createElement('table');
    table.className = 'users-table data-table';

    var colgroup = document.createElement('colgroup');
    ['col-user', 'col-status', 'col-cpu', 'col-mem', 'col-proc'].forEach(function (c) {
      var col = document.createElement('col');
      col.className = c;
      colgroup.appendChild(col);
    });
    table.appendChild(colgroup);

    var thead = document.createElement('thead');
    var trh = document.createElement('tr');
    var headers = [
      { label: 'User', cls: 'col-name' },
      { label: 'Status', cls: 'col-text' },
      { label: 'CPU', cls: 'col-num' },
      { label: 'Memory', cls: 'col-num' },
      { label: 'Processes', cls: 'col-num' }
    ];
    headers.forEach(function (hd) {
      var th = document.createElement('th');
      th.className = hd.cls;
      th.textContent = hd.label;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    table.appendChild(tbody);

    tableWrap.appendChild(table);
    page.appendChild(tableWrap);

    var empty = document.createElement('div');
    empty.className = 'users-empty';
    empty.textContent = 'Loading users…';
    page.appendChild(empty);

    container.appendChild(page);

    els = { page: page, tbody: tbody, empty: empty, tableWrap: tableWrap };
  }

  function render() {
    if (!els) return;

    if (errored && !loaded) {
      els.tableWrap.style.display = 'none';
      els.empty.style.display = '';
      els.empty.textContent = 'Unable to load user sessions.';
      return;
    }

    if (!loaded) {
      els.tableWrap.style.display = 'none';
      els.empty.style.display = '';
      els.empty.textContent = 'Loading users…';
      return;
    }

    if (!users || users.length === 0) {
      els.tableWrap.style.display = 'none';
      els.empty.style.display = '';
      els.empty.textContent = 'No active user sessions.';
      return;
    }

    els.empty.style.display = 'none';
    els.tableWrap.style.display = '';

    // Stable, readable order: most CPU first, then by name.
    var rows = users.slice().sort(function (a, b) {
      var ac = (typeof a.cpu === 'number' && isFinite(a.cpu)) ? a.cpu : -1;
      var bc = (typeof b.cpu === 'number' && isFinite(b.cpu)) ? b.cpu : -1;
      if (bc !== ac) return bc - ac;
      return String(a.user || '').localeCompare(String(b.user || ''));
    });

    var tbody = els.tbody;
    tbody.innerHTML = '';

    rows.forEach(function (u) {
      var tr = document.createElement('tr');
      tr.className = 'users-row';

      // User (name) — with a small avatar disc.
      var tdUser = document.createElement('td');
      tdUser.className = 'col-name';
      var nameWrap = document.createElement('div');
      nameWrap.className = 'user-name-cell';
      var avatar = document.createElement('span');
      avatar.className = 'user-avatar';
      avatar.innerHTML = ICON;
      var nameText = document.createElement('span');
      nameText.className = 'user-name-text';
      nameText.textContent = (u && u.user) ? String(u.user) : '—';
      nameWrap.appendChild(avatar);
      nameWrap.appendChild(nameText);
      tdUser.appendChild(nameWrap);
      tr.appendChild(tdUser);

      // Status
      var tdStatus = document.createElement('td');
      tdStatus.className = 'col-text';
      var st = statusLabel(u && u.status);
      var dot = document.createElement('span');
      dot.className = 'user-status user-status-' +
        (st === 'Active' ? 'active' : 'disconnected');
      dot.textContent = st;
      tdStatus.appendChild(dot);
      tr.appendChild(tdStatus);

      // CPU (%)
      var cpuVal = (u && typeof u.cpu === 'number') ? u.cpu : null;
      var tdCpu = document.createElement('td');
      tdCpu.className = 'col-num heat-' + heatBucket(cpuVal);
      tdCpu.textContent = fmtPercentCell(cpuVal);
      tr.appendChild(tdCpu);

      // Memory
      var memVal = (u && typeof u.memBytes === 'number') ? u.memBytes : null;
      var memPct = null;
      try {
        var stats = TM.state && TM.state.data && TM.state.data.stats;
        if (stats && stats.mem && typeof stats.mem.totalBytes === 'number' &&
            stats.mem.totalBytes > 0 && typeof memVal === 'number') {
          memPct = (memVal / stats.mem.totalBytes) * 100;
        }
      } catch (e) { memPct = null; }
      var tdMem = document.createElement('td');
      tdMem.className = 'col-num heat-' + heatBucket(memPct);
      tdMem.textContent = fmtBytes(memVal);
      tr.appendChild(tdMem);

      // Processes
      var procVal = (u && typeof u.processes === 'number') ? u.processes : null;
      var tdProc = document.createElement('td');
      tdProc.className = 'col-num';
      tdProc.textContent = fmtCount(procVal);
      tr.appendChild(tdProc);

      tbody.appendChild(tr);
    });
  }

  function fetchUsers() {
    if (fetching) return;
    if (!window.api || typeof window.api.getUsers !== 'function') {
      errored = true;
      render();
      return;
    }
    fetching = true;
    Promise.resolve()
      .then(function () { return window.api.getUsers(); })
      .then(function (list) {
        users = Array.isArray(list) ? list : [];
        loaded = true;
        errored = false;
      })
      .catch(function (err) {
        // Keep last good data if we have it; otherwise show error.
        errored = true;
        if (typeof console !== 'undefined' && console.error) {
          console.error('[users] getUsers failed:', err);
        }
      })
      .then(function () {
        fetching = false;
        render();
      });
  }

  TM.views.users = {
    id: 'users',
    title: 'Users',
    icon: ICON,

    mount: function (containerEl) {
      try {
        tickCount = 0;
        users = [];
        loaded = false;
        errored = false;
        buildSkeleton(containerEl);
        render();
        fetchUsers();
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[users] mount failed:', e);
        }
      }
    },

    update: function (/* state */) {
      try {
        tickCount++;
        if (tickCount % REFRESH_EVERY === 0) {
          fetchUsers();
        } else if (loaded) {
          // Cheap re-render keeps memory heat fresh as stats change.
          render();
        }
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[users] update failed:', e);
        }
      }
    },

    unmount: function () {
      els = null;
      tickCount = 0;
      // Keep `users` cached so a quick re-visit shows data immediately,
      // but reset load flags so the skeleton/refetch path runs on next mount.
      loaded = users.length > 0;
      errored = false;
    }
  };
})();
