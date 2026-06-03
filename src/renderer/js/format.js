// format.js — TM.format: display formatting utilities.
// Classic script, no modules. Attaches to the shared global TM namespace.
// Windows 11 Task Manager style strings, en-US thousands separators.
window.TM = window.TM || {};

(function () {
  'use strict';

  var KB = 1024;
  var MB = 1024 * 1024;
  var GB = 1024 * 1024 * 1024;
  var TB = 1024 * 1024 * 1024 * 1024;

  // en-US grouped number formatters (cached for perf).
  var _nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  var _nf1 = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  var _nf2 = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  // Coerce to a finite number; non-finite/invalid -> NaN.
  function num(n) {
    if (n === null || n === undefined) return NaN;
    var v = typeof n === 'number' ? n : Number(n);
    return isFinite(v) ? v : NaN;
  }

  var DASH = '—'; // em dash, shown when a metric is unavailable

  var format = {
    // Em dash used by the renderer for unavailable metrics.
    dash: DASH,

    /**
     * Human-readable byte size, Windows Task Manager style.
     * <1 GB  -> "X.X MB"  (1 decimal, en-US grouping: "2,855.2 MB")
     * >=1 GB -> "X.X GB"  (1 decimal: "1.2 GB"); TB used past 1024 GB.
     * Values under 1 MB are still shown in MB (e.g. "0.1 MB") to match Win11.
     */
    bytes: function (n) {
      var v = num(n);
      if (isNaN(v)) return DASH;
      if (v < 0) v = 0;
      if (v >= TB) return _nf1.format(v / TB) + ' TB';
      if (v >= GB) return _nf1.format(v / GB) + ' GB';
      return _nf1.format(v / MB) + ' MB';
    },

    /**
     * Transfer rate. Picks a sensible unit; Windows shows disk/net in MB/s
     * but drops to KB/s for small rates and B/s for tiny ones. 1 decimal.
     * "0.1 MB/s", "12.3 KB/s", "0 B/s".
     */
    bytesPerSec: function (n) {
      var v = num(n);
      if (isNaN(v)) return DASH;
      if (v < 0) v = 0;
      if (v >= GB) return _nf1.format(v / GB) + ' GB/s';
      if (v >= MB) return _nf1.format(v / MB) + ' MB/s';
      if (v >= KB) return _nf1.format(v / KB) + ' KB/s';
      return _nf0.format(v) + ' B/s';
    },

    /**
     * Generic percent. Defaults to the cell variant (1 decimal).
     */
    percent: function (n) {
      return format.percentCell(n);
    },

    /** Data-cell percent: 1 decimal place, e.g. "5.2%". */
    percentCell: function (n) {
      var v = num(n);
      if (isNaN(v)) return DASH;
      if (v < 0) v = 0;
      return v.toFixed(1) + '%';
    },

    /** Header percent: whole number, e.g. "5%". */
    percentHeader: function (n) {
      var v = num(n);
      if (isNaN(v)) return DASH;
      if (v < 0) v = 0;
      return Math.round(v) + '%';
    },

    /** Clock speed in GHz with 2 decimals, e.g. "4.70 GHz". */
    ghz: function (n) {
      var v = num(n);
      if (isNaN(v)) return DASH;
      if (v < 0) v = 0;
      return _nf2.format(v) + ' GHz';
    },

    /**
     * Uptime as d:hh:mm:ss. Days only shown when > 0.
     * 7427272 -> "85:22:07:52"  ;  13672 -> "03:47:52".
     */
    uptime: function (sec) {
      var v = num(sec);
      if (isNaN(v) || v < 0) return DASH;
      v = Math.floor(v);
      var days = Math.floor(v / 86400);
      var hours = Math.floor((v % 86400) / 3600);
      var mins = Math.floor((v % 3600) / 60);
      var secs = v % 60;
      function pad(x) {
        return x < 10 ? '0' + x : String(x);
      }
      var tail = pad(hours) + ':' + pad(mins) + ':' + pad(secs);
      return days > 0 ? days + ':' + tail : tail;
    },

    /**
     * Number with en-US thousands separators. Preserves fractional part
     * if present (rounded to at most 2 decimals).
     * 126629 -> "126,629" ; 1234.5 -> "1,234.5".
     */
    number: function (n) {
      var v = num(n);
      if (isNaN(v)) return DASH;
      if (v % 1 === 0) return _nf0.format(v);
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);
    },

    /**
     * Integer count with separators, e.g. "4,804". Rounds to integer.
     */
    count: function (n) {
      var v = num(n);
      if (isNaN(v)) return DASH;
      return _nf0.format(Math.round(v));
    },

    /**
     * Heat bucket for usage cells -> integer 0..5 mapping to .heat-N classes.
     * 0 for ~0 (no tint), then a perceptual ramp up to 5 at/above max.
     * Buckets are weighted toward the low end so light loads still get a
     * faint tint, matching the Win11 cell shading.
     */
    heat: function (value, max) {
      var v = num(value);
      if (isNaN(v) || v <= 0) return 0;
      var m = num(max);
      if (isNaN(m) || m <= 0) m = 100;
      var ratio = v / m;
      if (ratio < 0) ratio = 0;
      if (ratio > 1) ratio = 1;
      // Anything with a real but tiny load gets at least bucket 1.
      // Thresholds (as fraction of max): 1>0, 2>=0.2, 3>=0.4, 4>=0.6, 5>=0.8.
      if (ratio >= 0.8) return 5;
      if (ratio >= 0.6) return 4;
      if (ratio >= 0.4) return 3;
      if (ratio >= 0.2) return 2;
      return 1;
    },
  };

  TM.format = format;
})();
