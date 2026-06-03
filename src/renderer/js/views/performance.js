// performance.js — TM.views.performance.
// Windows 11 Task Manager "Performance" page for macOS.
// Left column: a list of metric cards (CPU, Memory, each Disk, each Net iface, GPU),
// each with a label, a small sparkline canvas (TM.charts.Sparkline) and a current value.
// Right column: a big panel for the selected metric — title, big line chart
// (TM.charts.LineChart, 60s window) and a stats grid. CPU also shows a grid of
// per-logical-core mini area charts.
//
// Classic script — attaches to the shared global TM namespace.
window.TM = window.TM || {};
TM.views = TM.views || {};

(function () {
  'use strict';

  var fmt = function () { return TM.format || {}; };
  var DASH = '—';

  // ---- Inline SVG glyphs ---------------------------------------------------

  // Sidebar icon: activity / pulse glyph (16x16, currentColor).
  var ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M1 8h3l2 5 4-10 2 5h3" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---- Helpers -------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function num(v, fb) {
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : (fb === undefined ? 0 : fb);
  }

  var ESC_RE = /[&<>"]/g;
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(ESC_RE, function (c) { return ESC_MAP[c]; });
  }

  // Per-metric color tokens (line + fill come from the same hue family).
  var COLORS = {
    cpu:  { line: '--graph-cpu',  fill: '--graph-cpu-fill' },
    mem:  { line: '--graph-mem',  fill: '--graph-mem-fill' },
    disk: { line: '--graph-disk', fill: '--graph-disk-fill' },
    net:  { line: '--graph-net',  fill: '--graph-net-fill' },
    gpu:  { line: '--graph-gpu',  fill: '--graph-gpu-fill' }
  };

  function colorFor(family) {
    var c = COLORS[family] || COLORS.cpu;
    return {
      line: cssVar(c.line, '#3a96dd'),
      fill: cssVar(c.fill, 'rgba(58,150,221,0.22)')
    };
  }

  // ---- View ----------------------------------------------------------------

  TM.views.performance = {
    id: 'performance',
    title: 'Performance',
    icon: ICON,

    // Persistent DOM/state across update() calls (set up in mount()).
    _container: null,
    _listEl: null,
    _panelEl: null,
    _selected: 'cpu',       // metric key: 'cpu' | 'mem' | 'disk:<i>' | 'net:<i>' | 'gpu'
    _cards: {},             // key -> { root, valueEl, spark, canvas, family }
    _cardOrder: [],         // ordered list of metric keys present in the sidebar list
    _bigChart: null,        // TM.charts.LineChart for the selected metric
    _bigCanvas: null,
    _bigKey: null,          // metric key the big chart currently represents
    _coreCharts: [],        // TM.charts.Sparkline[] for per-core grid
    _coreCount: 0,          // logical core count the core grid was built for
    _panelRefs: null,       // cached DOM refs inside the right panel
    _diskCount: 0,          // sidebar-built disk/net counts (to detect topology change)
    _netCount: 0,
    _hasGpu: false,

    // ---------------------------------------------------------------- mount
    mount: function (container) {
      this._container = container;
      container.innerHTML = '';

      var root = el('div', 'perf');

      var list = el('div', 'perf-list');
      list.setAttribute('role', 'tablist');
      var panel = el('div', 'perf-panel');

      root.appendChild(list);
      root.appendChild(panel);
      container.appendChild(root);

      this._listEl = list;
      this._panelEl = panel;
      this._cards = {};
      this._cardOrder = [];
      this._coreCharts = [];
      this._coreCount = 0;
      this._bigChart = null;
      this._bigCanvas = null;
      this._bigKey = null;
      this._panelRefs = null;
      this._diskCount = 0;
      this._netCount = 0;
      this._hasGpu = false;

      // Default selection.
      if (!this._selected) this._selected = 'cpu';

      // Build whatever we can from the current state immediately so the page
      // isn't blank before the first poll lands.
      try {
        this._rebuildList((TM.state && TM.state.data && TM.state.data.stats) || null);
        this._buildPanel();
        this.update(TM.state);
      } catch (e) {
        try { console.error('performance.mount error:', e); } catch (_) {}
      }
    },

    unmount: function () {
      // Drop cached chart instances so they get rebuilt cleanly next mount.
      this._cards = {};
      this._cardOrder = [];
      this._coreCharts = [];
      this._coreCount = 0;
      this._bigChart = null;
      this._bigCanvas = null;
      this._bigKey = null;
      this._panelRefs = null;
      if (this._container) this._container.innerHTML = '';
    },

    // ------------------------------------------------------- sidebar cards
    // Build the metric list from current stats. Each metric becomes a card with
    // a sparkline. Rebuilt only when the device topology changes (disk/net/gpu
    // count), so sparkline instances persist across normal updates.
    _rebuildList: function (stats) {
      var self = this;
      var list = this._listEl;
      if (!list) return;

      var disks = (stats && Array.isArray(stats.disks)) ? stats.disks : [];
      var nets = (stats && Array.isArray(stats.net)) ? stats.net : [];
      var gpu = stats && stats.gpu;
      var hasGpu = !!(gpu && (gpu.model || gpu.utilization != null));

      list.innerHTML = '';
      this._cards = {};
      this._cardOrder = [];

      // CPU
      this._addCard('cpu', 'cpu', 'CPU',
        (stats && stats.cpu && stats.cpu.brand) ? stats.cpu.brand : '');
      // Memory
      this._addCard('mem', 'mem', 'Memory',
        (stats && stats.mem) ? '' : '');
      // Disks
      for (var d = 0; d < disks.length; d++) {
        var dn = (disks[d] && disks[d].name) ? disks[d].name : ('Disk ' + d);
        this._addCard('disk:' + d, 'disk', 'Disk ' + d, dn);
      }
      if (disks.length === 0) {
        // Always show at least one Disk card so the layout matches Windows.
        this._addCard('disk:0', 'disk', 'Disk 0', '');
      }
      // Network interfaces (label primary one "Ethernet" like Windows).
      for (var n = 0; n < nets.length; n++) {
        var iface = (nets[n] && nets[n].iface) ? nets[n].iface : ('net' + n);
        var label = (n === 0) ? 'Ethernet' : 'Network';
        this._addCard('net:' + n, 'net', label, iface);
      }
      if (nets.length === 0) {
        this._addCard('net:0', 'net', 'Ethernet', '');
      }
      // GPU
      if (hasGpu) {
        this._addCard('gpu', 'gpu', 'GPU', gpu.model || '');
      }

      this._diskCount = disks.length || 1;
      this._netCount = nets.length || 1;
      this._hasGpu = hasGpu;

      // If the previously-selected metric no longer exists, fall back to cpu.
      if (!this._cards[this._selected]) {
        this._selected = 'cpu';
        this._bigKey = null; // force panel rebuild
      }
      this._syncSelectedCard();

      // Clicking a card selects that metric.
      list.onclick = function (ev) {
        var card = ev.target.closest ? ev.target.closest('.perf-card') : null;
        if (!card || !card.dataset || !card.dataset.key) return;
        self._select(card.dataset.key);
      };
    },

    _addCard: function (key, family, label, sub) {
      var card = el('div', 'perf-card');
      card.dataset.key = key;
      card.dataset.family = family;
      card.setAttribute('role', 'tab');
      card.tabIndex = 0;

      // Small sparkline canvas.
      var graphWrap = el('div', 'perf-card-graph');
      var canvas = document.createElement('canvas');
      canvas.className = 'perf-card-spark';
      graphWrap.appendChild(canvas);

      // Text block: label (top) + current value (bottom).
      var textWrap = el('div', 'perf-card-text');
      var nameEl = el('div', 'perf-card-name', label);
      var valEl = el('div', 'perf-card-value', DASH);
      var subEl = null;
      if (sub) {
        subEl = el('div', 'perf-card-sub', sub);
        subEl.title = sub;
      }
      textWrap.appendChild(nameEl);
      if (subEl) textWrap.appendChild(subEl);
      textWrap.appendChild(valEl);

      card.appendChild(graphWrap);
      card.appendChild(textWrap);
      this._listEl.appendChild(card);

      var col = colorFor(family);
      var spark = null;
      try {
        spark = new TM.charts.Sparkline(canvas, {
          color: col.line,
          fillColor: col.fill,
          // net/disk use auto scaling; pass a sentinel and we render via 'auto'.
          max: (family === 'net' || family === 'disk') ? undefined : 100
        });
      } catch (e) {
        try { console.error('Sparkline init failed for', key, e); } catch (_) {}
      }

      this._cards[key] = {
        root: card,
        valueEl: valEl,
        spark: spark,
        canvas: canvas,
        family: family
      };
      this._cardOrder.push(key);
    },

    _select: function (key) {
      if (!this._cards[key]) return;
      if (this._selected === key) return;
      this._selected = key;
      this._syncSelectedCard();
      this._buildPanel();
      // Immediately repopulate the panel from history.
      try { this.update(TM.state); } catch (e) {}
    },

    _syncSelectedCard: function () {
      for (var k in this._cards) {
        if (!Object.prototype.hasOwnProperty.call(this._cards, k)) continue;
        var c = this._cards[k];
        if (!c || !c.root) continue;
        if (k === this._selected) {
          c.root.classList.add('selected');
          c.root.setAttribute('aria-selected', 'true');
        } else {
          c.root.classList.remove('selected');
          c.root.setAttribute('aria-selected', 'false');
        }
      }
    },

    // -------------------------------------------------------- right panel
    // (Re)build the big panel for the currently-selected metric. Cheap to call;
    // skips work when the panel already represents the selected metric and the
    // CPU core count is unchanged.
    _buildPanel: function () {
      var panel = this._panelEl;
      if (!panel) return;

      var family = this._familyOf(this._selected);
      var stats = (TM.state && TM.state.data && TM.state.data.stats) || null;

      // For CPU, the per-core grid depends on logicalCores; rebuild on change.
      var coreCount = 0;
      if (family === 'cpu' && stats && stats.cpu) {
        coreCount = num(stats.cpu.logicalCores, 0);
        if (!coreCount && Array.isArray(stats.cpu.perCore)) {
          coreCount = stats.cpu.perCore.length;
        }
      }

      var needRebuild =
        this._bigKey !== this._selected ||
        (family === 'cpu' && coreCount !== this._coreCount);

      if (!needRebuild) return;

      panel.innerHTML = '';
      this._coreCharts = [];
      this._bigChart = null;
      this._bigCanvas = null;
      this._panelRefs = null;

      var col = colorFor(family);

      // Header: big title + subtitle (device name).
      var head = el('div', 'perf-panel-head');
      var title = el('div', 'perf-panel-title', this._titleFor(this._selected, stats));
      var subtitle = el('div', 'perf-panel-subtitle', this._subtitleFor(this._selected, stats));
      head.appendChild(title);
      head.appendChild(subtitle);
      panel.appendChild(head);

      var refs = { title: title, subtitle: subtitle };

      if (family === 'cpu') {
        // CPU shows EITHER one big chart OR a grid of per-core mini charts.
        // Match Windows: render the per-logical-core grid as the main visual.
        var graphLabel = el('div', 'perf-graph-label');
        graphLabel.appendChild(el('span', null, '% Utilization over logical processors'));
        graphLabel.appendChild(el('span', 'perf-graph-scale', '100%'));
        panel.appendChild(graphLabel);

        var grid = el('div', 'perf-core-grid');
        var cols = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(coreCount || 1))));
        grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
        for (var i = 0; i < coreCount; i++) {
          var cell = el('div', 'perf-core-cell');
          var cv = document.createElement('canvas');
          cv.className = 'perf-core-spark';
          cell.appendChild(cv);
          grid.appendChild(cell);
          try {
            this._coreCharts.push(new TM.charts.Sparkline(cv, {
              color: col.line, fillColor: col.fill, max: 100
            }));
          } catch (e) {
            this._coreCharts.push(null);
          }
        }
        panel.appendChild(grid);
        this._coreCount = coreCount;
        refs.grid = grid;
      } else {
        // Big single line chart (60s window) for mem/disk/net/gpu.
        var axis = el('div', 'perf-graph-label');
        axis.appendChild(el('span', null, this._axisLabel(family)));
        var scaleEl = el('span', 'perf-graph-scale', family === 'mem' ? '100%' : '');
        axis.appendChild(scaleEl);
        panel.appendChild(axis);
        refs.scaleEl = scaleEl;

        var chartWrap = el('div', 'perf-chart');
        var canvas = document.createElement('canvas');
        canvas.className = 'perf-chart-canvas';
        chartWrap.appendChild(canvas);
        panel.appendChild(chartWrap);

        // mem -> fixed 100% max; disk/net -> auto.
        var maxOpt = (family === 'net' || family === 'disk') ? 'auto' : 100;
        try {
          this._bigChart = new TM.charts.LineChart(canvas, {
            color: col.line,
            fillColor: col.fill,
            max: maxOpt,
            fill: true
          });
        } catch (e) {
          this._bigChart = null;
        }
        this._bigCanvas = canvas;

        // 60s time-window labels under the chart.
        var timeRow = el('div', 'perf-time-row');
        timeRow.appendChild(el('span', null, '60 seconds'));
        timeRow.appendChild(el('span', null, '0'));
        panel.appendChild(timeRow);
      }

      // Stats grid below.
      var statsWrap = el('div', 'perf-stats');
      panel.appendChild(statsWrap);
      refs.statsWrap = statsWrap;
      refs.stats = this._buildStatsGrid(statsWrap, family);

      // Top processes (CPU / Memory only; per-process disk/net/gpu unavailable).
      var top = el('div', 'perf-top');
      var topHead = el('div', 'perf-top-head', 'Top processes');
      var topList = el('div', 'perf-top-list');
      top.appendChild(topHead);
      top.appendChild(topList);
      panel.appendChild(top);
      refs.top = top;
      refs.topHead = topHead;
      refs.topList = topList;

      this._panelRefs = refs;
      this._bigKey = this._selected;
    },

    // Build the stats grid skeleton for a family; returns a map name->valueEl.
    _buildStatsGrid: function (wrap, family) {
      var defs = this._statDefs(family);
      var map = {};
      for (var i = 0; i < defs.length; i++) {
        var d = defs[i];
        var item = el('div', 'perf-stat' + (d.big ? ' perf-stat-big' : ''));
        var label = el('div', 'perf-stat-label', d.label);
        var value = el('div', 'perf-stat-value', DASH);
        item.appendChild(label);
        item.appendChild(value);
        wrap.appendChild(item);
        map[d.key] = value;
      }
      return map;
    },

    _statDefs: function (family) {
      if (family === 'cpu') {
        return [
          { key: 'util', label: 'Utilization', big: true },
          { key: 'loadavg', label: 'Load average (1 · 5 · 15 min)', big: true },
          { key: 'split', label: 'User / System' },
          { key: 'cores', label: 'Cores' },
          { key: 'pe', label: 'Performance / Efficiency' },
          { key: 'logical', label: 'Logical processors' },
          { key: 'procs', label: 'Processes' },
          { key: 'threads', label: 'Threads' },
          { key: 'uptime', label: 'Up time' }
        ];
      }
      if (family === 'mem') {
        return [
          { key: 'inuse', label: 'In use', big: true },
          { key: 'available', label: 'Available', big: true },
          { key: 'app', label: 'App memory' },
          { key: 'wired', label: 'Wired' },
          { key: 'compressed', label: 'Compressed' },
          { key: 'cached', label: 'Cached files' },
          { key: 'swap', label: 'Swap (used / total)' },
          { key: 'total', label: 'Total' }
        ];
      }
      if (family === 'disk') {
        return [
          { key: 'read', label: 'Read speed', big: true },
          { key: 'write', label: 'Write speed', big: true },
          { key: 'capacity', label: 'Capacity' },
          { key: 'used', label: 'Used' }
        ];
      }
      if (family === 'net') {
        return [
          { key: 'send', label: 'Send', big: true },
          { key: 'receive', label: 'Receive', big: true },
          { key: 'iface', label: 'Adapter name' },
          { key: 'ip', label: 'IP address' }
        ];
      }
      if (family === 'gpu') {
        return [
          { key: 'util', label: 'Utilization', big: true },
          { key: 'cores', label: 'GPU cores' },
          { key: 'model', label: 'Model' }
        ];
      }
      return [];
    },

    _axisLabel: function (family) {
      if (family === 'mem') return '% Memory usage';
      if (family === 'disk') return 'Disk transfer rate';
      if (family === 'net') return 'Throughput';
      if (family === 'gpu') return '% GPU utilization';
      return 'Utilization';
    },

    _familyOf: function (key) {
      if (key === 'cpu') return 'cpu';
      if (key === 'mem') return 'mem';
      if (key === 'gpu') return 'gpu';
      if (key.indexOf('disk:') === 0) return 'disk';
      if (key.indexOf('net:') === 0) return 'net';
      return 'cpu';
    },

    _indexOf: function (key) {
      var i = key.indexOf(':');
      if (i < 0) return 0;
      var n = parseInt(key.slice(i + 1), 10);
      return isFinite(n) ? n : 0;
    },

    _titleFor: function (key, stats) {
      var fam = this._familyOf(key);
      if (fam === 'cpu') return 'CPU';
      if (fam === 'mem') return 'Memory';
      if (fam === 'gpu') return 'GPU';
      if (fam === 'disk') return 'Disk ' + this._indexOf(key);
      if (fam === 'net') {
        return this._indexOf(key) === 0 ? 'Ethernet' : 'Network';
      }
      return key;
    },

    _subtitleFor: function (key, stats) {
      var fam = this._familyOf(key);
      try {
        if (fam === 'cpu') return (stats && stats.cpu && stats.cpu.brand) || '';
        if (fam === 'mem') {
          if (stats && stats.mem) return fmt().bytes(stats.mem.totalBytes);
          return '';
        }
        if (fam === 'gpu') return (stats && stats.gpu && stats.gpu.model) || '';
        if (fam === 'disk') {
          var di = stats && stats.disks && stats.disks[this._indexOf(key)];
          return (di && di.name) || '';
        }
        if (fam === 'net') {
          var ni = stats && stats.net && stats.net[this._indexOf(key)];
          return (ni && ni.iface) || '';
        }
      } catch (e) {}
      return '';
    },

    // ---------------------------------------------------------------- update
    update: function (state) {
      try {
        state = state || TM.state;
        var stats = state && state.data && state.data.stats;
        var history = (state && state.history) || (TM.state && TM.state.history) || {};

        // Detect topology changes that require rebuilding the sidebar list.
        if (stats) {
          var disks = Array.isArray(stats.disks) ? stats.disks.length : 0;
          var nets = Array.isArray(stats.net) ? stats.net.length : 0;
          var hasGpu = !!(stats.gpu && (stats.gpu.model || stats.gpu.utilization != null));
          var dCount = disks || 1;
          var nCount = nets || 1;
          if (dCount !== this._diskCount || nCount !== this._netCount ||
              hasGpu !== this._hasGpu || this._cardOrder.length === 0) {
            this._rebuildList(stats);
            // selection may have changed/cleared -> ensure panel matches.
            this._buildPanel();
          }
        }

        this._updateCards(stats, history);
        this._updatePanel(stats, history);
      } catch (e) {
        try { console.error('performance.update error:', e); } catch (_) {}
      }
    },

    // Refresh each sidebar card's sparkline + current value.
    _updateCards: function (stats, history) {
      var F = fmt();
      for (var c = 0; c < this._cardOrder.length; c++) {
        var key = this._cardOrder[c];
        var card = this._cards[key];
        if (!card) continue;
        var fam = card.family;
        var series = null;
        var valueText = DASH;
        var autoMax = false;

        if (fam === 'cpu') {
          series = history.cpu;
          valueText = stats && stats.cpu != null
            ? F.percentHeader(stats.cpu.load) : DASH;
        } else if (fam === 'mem') {
          series = history.mem;
          if (stats && stats.mem) {
            valueText = F.bytes(stats.mem.usedBytes) + ' (' +
              F.percentHeader(stats.mem.percent) + ')';
          }
        } else if (fam === 'disk') {
          series = history.disk;
          autoMax = true;
          var di = stats && stats.disks && stats.disks[this._indexOf(key)];
          if (di) {
            valueText = F.bytesPerSec(num(di.readBytesSec) + num(di.writeBytesSec));
          }
        } else if (fam === 'net') {
          series = history.net;
          autoMax = true;
          var ni = stats && stats.net && stats.net[this._indexOf(key)];
          if (ni) {
            valueText = F.bytesPerSec(num(ni.rxBytesSec) + num(ni.txBytesSec));
          }
        } else if (fam === 'gpu') {
          series = history.cpu && []; // gpu has no dedicated ring buffer
          series = this._gpuSeries(history, stats);
          if (stats && stats.gpu && stats.gpu.utilization != null) {
            valueText = F.percentHeader(stats.gpu.utilization);
          }
        }

        // Update value text.
        if (card.valueEl && card.valueEl.textContent !== valueText) {
          card.valueEl.textContent = valueText;
        }

        // Render sparkline. For auto-scaled metrics, set max to series peak.
        if (card.spark && Array.isArray(series)) {
          if (autoMax) {
            var peak = 0;
            for (var i = 0; i < series.length; i++) {
              if (series[i] > peak) peak = series[i];
            }
            card.spark.max = peak > 0 ? peak * 1.15 : 1;
          }
          card.spark.render(series);
        }
      }
    },

    // GPU has no dedicated history ring; synthesize a short rolling series from
    // the latest utilization so the sparkline still animates. Cached per-view.
    _gpuSeries: function (history, stats) {
      if (!this._gpuRing) this._gpuRing = [];
      var u = (stats && stats.gpu && stats.gpu.utilization != null)
        ? num(stats.gpu.utilization) : 0;
      this._gpuRing.push(u);
      if (this._gpuRing.length > 60) this._gpuRing.shift();
      return this._gpuRing;
    },

    // Refresh the right panel: big chart / core grid + stats grid.
    _updatePanel: function (stats, history) {
      var refs = this._panelRefs;
      if (!refs) return;
      var F = fmt();
      var family = this._familyOf(this._selected);

      // Keep title/subtitle fresh (subtitle may change once stats arrive).
      if (refs.subtitle) {
        var sub = this._subtitleFor(this._selected, stats);
        if (refs.subtitle.textContent !== sub) refs.subtitle.textContent = sub;
      }

      this._updateTopProcs(family, refs);

      if (family === 'cpu') {
        this._updateCpuPanel(stats, history, refs, F);
        return;
      }

      // Big line chart for mem/disk/net/gpu.
      var chart = this._bigChart;
      var series = null;
      var autoMax = false;

      if (family === 'mem') {
        series = history.mem;
      } else if (family === 'disk') {
        series = history.disk; autoMax = true;
      } else if (family === 'net') {
        series = history.net; autoMax = true;
      } else if (family === 'gpu') {
        series = this._gpuRing || [];
      }

      if (chart && Array.isArray(series)) {
        if (autoMax) {
          chart.setMax('auto');
          // Update the dynamic scale label (top-right) with the auto peak.
          if (refs.scaleEl) {
            var peak = 0;
            for (var i = 0; i < series.length; i++) if (series[i] > peak) peak = series[i];
            refs.scaleEl.textContent = peak > 0 ? F.bytesPerSec(peak) : '';
          }
        }
        chart.render(series);
      }

      // Stats.
      if (family === 'mem') this._updateMemStats(stats, refs, F);
      else if (family === 'disk') this._updateDiskStats(stats, refs, F);
      else if (family === 'net') this._updateNetStats(stats, refs, F);
      else if (family === 'gpu') this._updateGpuStats(stats, refs, F);
    },

    // Top consumers list. Supported for CPU (by cpu%) and Memory (by RSS); the
    // section is hidden for disk/net/gpu since per-process values aren't available.
    _updateTopProcs: function (family, refs) {
      if (!refs || !refs.top || !refs.topList) return;
      var supported = (family === 'cpu' || family === 'mem');
      refs.top.style.display = supported ? '' : 'none';
      if (!supported) return;

      var F = fmt();
      var procs = (TM.state && TM.state.data && Array.isArray(TM.state.data.processes))
        ? TM.state.data.processes.slice() : [];
      var key = family === 'cpu' ? 'cpu' : 'memBytes';
      procs.sort(function (a, b) { return num(b && b[key]) - num(a && a[key]); });
      var top = procs.slice(0, 6);

      refs.topHead.textContent = family === 'cpu' ? 'Top processes by CPU' : 'Top processes by memory';

      var html = '';
      for (var i = 0; i < top.length; i++) {
        var p = top[i];
        if (!p) continue;
        var val = family === 'cpu' ? F.percentCell(num(p.cpu)) : F.bytes(num(p.memBytes));
        var iconHtml;
        if (p.iconPath) {
          var cached = (TM.icons && TM.icons.cached) ? TM.icons.cached(p.iconPath) : undefined;
          if (TM.icons && TM.icons.request) TM.icons.request(p.iconPath);
          iconHtml = '<img class="app-icon' + (cached ? ' loaded' : '') + '" ' +
            'data-icon-path="' + esc(p.iconPath) + '" alt=""' +
            (cached ? ' src="' + cached + '"' : '') + '>';
        } else {
          iconHtml = '<span class="perf-top-dot"></span>';
        }
        html += '<div class="perf-top-row">' +
          '<span class="perf-top-ic">' + iconHtml + '</span>' +
          '<span class="perf-top-name">' + esc(p.name || ('PID ' + p.pid)) + '</span>' +
          '<span class="perf-top-val">' + val + '</span></div>';
      }
      refs.topList.innerHTML = html ||
        '<div class="perf-top-empty">No data</div>';
    },

    _setStat: function (refs, key, text) {
      if (refs && refs.stats && refs.stats[key]) {
        var t = (text == null || text === '') ? DASH : text;
        if (refs.stats[key].textContent !== t) refs.stats[key].textContent = t;
      }
    },

    _updateCpuPanel: function (stats, history, refs, F) {
      var cpu = stats && stats.cpu;
      var proc = stats && stats.process;

      // Per-core mini area charts.
      var per = history.perCore || [];
      for (var i = 0; i < this._coreCharts.length; i++) {
        var ch = this._coreCharts[i];
        if (!ch) continue;
        var s = per[i];
        if (Array.isArray(s)) ch.render(s);
        else if (cpu && cpu.perCore && cpu.perCore[i] != null) {
          ch.push(num(cpu.perCore[i]));
        }
      }

      // Stats.
      this._setStat(refs, 'util', cpu ? F.percentHeader(cpu.load) : DASH);
      var la = cpu && Array.isArray(cpu.loadAvg) ? cpu.loadAvg : null;
      this._setStat(refs, 'loadavg',
        la ? (la[0].toFixed(2) + '  ·  ' + la[1].toFixed(2) + '  ·  ' + la[2].toFixed(2)) : DASH);
      this._setStat(refs, 'split',
        (cpu && cpu.loadUser != null)
          ? (F.percentCell(cpu.loadUser) + ' / ' + F.percentCell(cpu.loadSystem)) : DASH);
      this._setStat(refs, 'cores', cpu ? F.count(cpu.physicalCores) : DASH);
      this._setStat(refs, 'pe',
        (cpu && cpu.perfCores != null)
          ? (F.count(cpu.perfCores) + 'P + ' + F.count(cpu.effCores) + 'E') : DASH);
      this._setStat(refs, 'logical', cpu ? F.count(cpu.logicalCores) : DASH);
      this._setStat(refs, 'procs', proc ? F.count(proc.total) : DASH);
      this._setStat(refs, 'threads', proc ? F.count(proc.threads) : DASH);
      this._setStat(refs, 'uptime', cpu ? F.uptime(cpu.uptimeSec) : DASH);
    },

    _updateMemStats: function (stats, refs, F) {
      var m = stats && stats.mem;
      if (!m) {
        ['inuse', 'available', 'app', 'wired', 'compressed', 'cached', 'swap', 'total']
          .forEach(function (k) { this._setStat(refs, k, DASH); }, this);
        return;
      }
      // macOS (Activity Monitor) semantics: available = total - used.
      var available = (m.availableBytes != null)
        ? m.availableBytes
        : (m.totalBytes != null && m.usedBytes != null ? m.totalBytes - m.usedBytes : num(m.freeBytes));
      this._setStat(refs, 'inuse', F.bytes(m.usedBytes));
      this._setStat(refs, 'available', available != null ? F.bytes(available) : DASH);
      this._setStat(refs, 'app', m.appBytes != null ? F.bytes(m.appBytes) : DASH);
      this._setStat(refs, 'wired', m.wiredBytes != null ? F.bytes(m.wiredBytes) : DASH);
      this._setStat(refs, 'compressed', m.compressedBytes != null ? F.bytes(m.compressedBytes) : DASH);
      this._setStat(refs, 'cached', m.cachedBytes != null ? F.bytes(m.cachedBytes) : DASH);
      this._setStat(refs, 'swap',
        (m.swapTotalBytes != null && m.swapTotalBytes > 0)
          ? (F.bytes(m.swapUsedBytes) + ' / ' + F.bytes(m.swapTotalBytes)) : DASH);
      this._setStat(refs, 'total', F.bytes(m.totalBytes));
    },

    _updateDiskStats: function (stats, refs, F) {
      var di = stats && stats.disks && stats.disks[this._indexOf(this._selected)];
      if (!di) {
        this._setStat(refs, 'read', DASH);
        this._setStat(refs, 'write', DASH);
        this._setStat(refs, 'capacity', DASH);
        this._setStat(refs, 'used', DASH);
        return;
      }
      this._setStat(refs, 'read',
        di.readBytesSec != null ? F.bytesPerSec(di.readBytesSec) : DASH);
      this._setStat(refs, 'write',
        di.writeBytesSec != null ? F.bytesPerSec(di.writeBytesSec) : DASH);
      this._setStat(refs, 'capacity', di.sizeBytes != null ? F.bytes(di.sizeBytes) : DASH);
      this._setStat(refs, 'used',
        (di.diskUsedBytes != null)
          ? (F.bytes(di.diskUsedBytes) + (di.usePercent != null ? ' (' + Math.round(di.usePercent) + '%)' : ''))
          : DASH);
    },

    _updateNetStats: function (stats, refs, F) {
      var ni = stats && stats.net && stats.net[this._indexOf(this._selected)];
      if (!ni) {
        this._setStat(refs, 'send', DASH);
        this._setStat(refs, 'receive', DASH);
        this._setStat(refs, 'iface', DASH);
        this._setStat(refs, 'ip', DASH);
        return;
      }
      this._setStat(refs, 'send',
        ni.txBytesSec != null ? F.bytesPerSec(ni.txBytesSec) : DASH);
      this._setStat(refs, 'receive',
        ni.rxBytesSec != null ? F.bytesPerSec(ni.rxBytesSec) : DASH);
      this._setStat(refs, 'iface', ni.iface || DASH);
      this._setStat(refs, 'ip', ni.ip4 || DASH);
    },

    _updateGpuStats: function (stats, refs, F) {
      var g = stats && stats.gpu;
      if (!g) {
        this._setStat(refs, 'util', DASH);
        this._setStat(refs, 'cores', DASH);
        this._setStat(refs, 'model', DASH);
        return;
      }
      // Apple Silicon doesn't expose live GPU utilization without elevated tools.
      this._setStat(refs, 'util',
        g.utilization != null ? F.percentHeader(g.utilization) : 'N/A on Apple Silicon');
      this._setStat(refs, 'cores', g.cores != null ? F.count(g.cores) : DASH);
      this._setStat(refs, 'model', g.model || DASH);
    }
  };
})();
