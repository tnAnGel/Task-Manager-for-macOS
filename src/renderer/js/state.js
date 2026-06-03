// state.js — TM.state central store + pub/sub.
// Classic script, no modules. Dependency-free. Attaches to window.TM.
window.TM = window.TM || {};

(function () {
  'use strict';

  var HISTORY_MAX = 60; // ring-buffer cap for chart sample arrays

  // Append a value to a number[] ring buffer and trim from the front to `max`.
  function pushTrim(arr, value, max) {
    arr.push(value);
    while (arr.length > max) arr.shift();
    return arr;
  }

  // Coerce to a finite number, otherwise fall back (default 0).
  function num(v, fallback) {
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  var TM = window.TM;

  TM.state = {
    // ---- Latest snapshot from main process ----
    data: {
      processes: [], // Process[]
      stats: null    // SystemStats | null
    },

    // ---- Ring buffers for the performance charts (each capped at 60 samples) ----
    history: {
      cpu: [],      // number[]   total CPU load %
      mem: [],      // number[]   memory usage %
      perCore: [],  // number[][] one inner array per logical core, each capped at 60
      net: [],      // number[]   total bytes/sec across interfaces
      disk: []      // number[]   total bytes/sec across disks
    },

    // ---- UI state ----
    ui: {
      view: 'processes',
      selectedPid: null,
      sortKey: 'cpu',
      sortDir: 'desc',
      search: '',
      expanded: { apps: true, background: true, system: true }
    },

    // Internal subscriber list.
    _subs: [],

    /**
     * Shallow-merge a partial update into `data` and/or `ui`, then notify.
     * Supported shapes:
     *   set({ data: { processes, stats } })   // shallow-merges into this.data
     *   set({ ui: { sortKey: 'mem', ... } })   // shallow-merges into this.ui
     *   set({ ui: { expanded: { apps:false } } }) // shallow-merges into ui.expanded
     * Calls emit() once after merging.
     */
    set: function (partial) {
      if (!partial || typeof partial !== 'object') return this;

      if (partial.data && typeof partial.data === 'object') {
        for (var dk in partial.data) {
          if (Object.prototype.hasOwnProperty.call(partial.data, dk)) {
            this.data[dk] = partial.data[dk];
          }
        }
      }

      if (partial.ui && typeof partial.ui === 'object') {
        for (var uk in partial.ui) {
          if (!Object.prototype.hasOwnProperty.call(partial.ui, uk)) continue;
          // `expanded` is a nested object — merge into it rather than replace,
          // so callers can toggle a single group.
          if (uk === 'expanded' && partial.ui.expanded &&
              typeof partial.ui.expanded === 'object') {
            for (var ek in partial.ui.expanded) {
              if (Object.prototype.hasOwnProperty.call(partial.ui.expanded, ek)) {
                this.ui.expanded[ek] = partial.ui.expanded[ek];
              }
            }
          } else {
            this.ui[uk] = partial.ui[uk];
          }
        }
      }

      this.emit();
      return this;
    },

    /**
     * Register a subscriber. Returns an unsubscribe function.
     * @param {(state: object) => void} fn
     * @returns {() => void}
     */
    subscribe: function (fn) {
      if (typeof fn !== 'function') return function () {};
      this._subs.push(fn);
      var self = this;
      var active = true;
      return function unsubscribe() {
        if (!active) return;
        active = false;
        var i = self._subs.indexOf(fn);
        if (i !== -1) self._subs.splice(i, 1);
      };
    },

    /** Notify all subscribers with the current state. Errors are isolated. */
    emit: function () {
      // Iterate a copy so unsubscribing during emit is safe.
      var subs = this._subs.slice();
      for (var i = 0; i < subs.length; i++) {
        try {
          subs[i](this);
        } catch (err) {
          // A misbehaving subscriber must not break the others.
          if (typeof console !== 'undefined' && console.error) {
            console.error('TM.state subscriber error:', err);
          }
        }
      }
      return this;
    },

    /**
     * Append the latest SystemStats to the chart ring buffers, trimming each
     * to 60 samples. Does NOT call emit() (the poll loop sets data + emits).
     * Tolerates partial/missing fields without throwing.
     * @param {object} stats SystemStats
     */
    pushHistory: function (stats) {
      try {
        if (!stats || typeof stats !== 'object') return this;
        var h = this.history;

        // CPU total load %
        var cpu = stats.cpu || {};
        pushTrim(h.cpu, num(cpu.load), HISTORY_MAX);

        // Memory usage %
        var mem = stats.mem || {};
        pushTrim(h.mem, num(mem.percent), HISTORY_MAX);

        // Per-core loads. Lazily size perCore to logicalCores (fall back to
        // the perCore array length we actually received).
        var perCore = (cpu.perCore && cpu.perCore.length) ? cpu.perCore : [];
        var coreCount = num(cpu.logicalCores, 0) || perCore.length || h.perCore.length;
        if (h.perCore.length !== coreCount && coreCount > 0) {
          // (Re)initialize / resize the array of per-core ring buffers,
          // preserving existing buffers where indices overlap.
          var resized = new Array(coreCount);
          for (var c = 0; c < coreCount; c++) {
            resized[c] = h.perCore[c] || [];
          }
          h.perCore = resized;
        }
        for (var i = 0; i < h.perCore.length; i++) {
          pushTrim(h.perCore[i], num(perCore[i]), HISTORY_MAX);
        }

        // Network total bytes/sec across all interfaces (rx + tx).
        var netTotal = 0;
        if (Array.isArray(stats.net)) {
          for (var n = 0; n < stats.net.length; n++) {
            var ni = stats.net[n] || {};
            netTotal += num(ni.rxBytesSec) + num(ni.txBytesSec);
          }
        }
        pushTrim(h.net, netTotal, HISTORY_MAX);

        // Disk total bytes/sec across all disks (read + write).
        var diskTotal = 0;
        if (Array.isArray(stats.disks)) {
          for (var d = 0; d < stats.disks.length; d++) {
            var di = stats.disks[d] || {};
            diskTotal += num(di.readBytesSec) + num(di.writeBytesSec);
          }
        }
        pushTrim(h.disk, diskTotal, HISTORY_MAX);
      } catch (err) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('TM.state.pushHistory error:', err);
        }
      }
      return this;
    }
  };
})();
