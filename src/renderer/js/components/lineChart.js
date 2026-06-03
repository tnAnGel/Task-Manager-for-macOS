// lineChart.js — TM.charts.LineChart
// Windows 11 Task Manager-style big live line chart. Canvas 2D, devicePixelRatio-aware.
// Faint grid, area fill under line, newest sample pinned to the right edge, scaled to `max`
// (max may be 'auto' to compute from data, used for net/disk). 60-sample rolling buffer.
window.TM = window.TM || {};
TM.charts = TM.charts || {};

(function () {
  'use strict';

  var MAX_SAMPLES = 60;

  // Resolve a CSS custom property (e.g. "--graph-cpu") to its value, with fallback.
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  // Derive a translucent fill from a solid line color. Accepts #rgb/#rrggbb or rgb()/rgba().
  function toFill(color, alpha) {
    try {
      if (!color) return 'rgba(58,150,221,0.22)';
      color = color.trim();
      if (color[0] === '#') {
        var hex = color.slice(1);
        if (hex.length === 3) {
          hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        if (isNaN(r) || isNaN(g) || isNaN(b)) return 'rgba(58,150,221,0.22)';
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
      }
      var m = color.match(/rgba?\(([^)]+)\)/i);
      if (m) {
        var parts = m[1].split(',');
        return 'rgba(' + (parts[0] || 0).trim() + ',' + (parts[1] || 0).trim() + ',' +
          (parts[2] || 0).trim() + ',' + alpha + ')';
      }
      return color;
    } catch (e) {
      return 'rgba(58,150,221,0.22)';
    }
  }

  function LineChart(canvasEl, opts) {
    opts = opts || {};
    this.canvas = canvasEl;
    this.ctx = canvasEl ? canvasEl.getContext('2d') : null;
    this.color = opts.color || cssVar('--graph-cpu', '#3a96dd');
    this.fillColor = opts.fillColor || toFill(this.color, 0.22);
    this.fill = opts.fill !== false; // default true
    this.grid = opts.grid !== false; // default true
    this.max = opts.max === undefined ? 100 : opts.max; // number or 'auto'
    this.values = [];
    this.dpr = window.devicePixelRatio || 1;
    this._gridColor = cssVar('--graph-grid', 'rgba(255,255,255,0.06)');
    this._axisColor = cssVar('--graph-axis', 'rgba(255,255,255,0.12)');
  }

  // Replace the buffer with the supplied samples (capped to MAX_SAMPLES from the tail) and draw.
  LineChart.prototype.render = function (values) {
    if (Array.isArray(values)) {
      var src = values;
      if (src.length > MAX_SAMPLES) src = src.slice(src.length - MAX_SAMPLES);
      this.values = src.slice();
    }
    this._draw();
    return this;
  };

  // Append one sample, cap at MAX_SAMPLES, and redraw.
  LineChart.prototype.push = function (v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    this.values.push(n);
    if (this.values.length > MAX_SAMPLES) {
      this.values.splice(0, this.values.length - MAX_SAMPLES);
    }
    this._draw();
    return this;
  };

  // Update the scale ceiling. Pass a positive number or 'auto'.
  LineChart.prototype.setMax = function (max) {
    this.max = max;
    this._draw();
    return this;
  };

  LineChart.prototype.setColor = function (color) {
    this.color = color || this.color;
    this.fillColor = toFill(this.color, 0.22);
    this._draw();
    return this;
  };

  LineChart.prototype.clear = function () {
    this.values = [];
    this._draw();
    return this;
  };

  // Compute the effective vertical scale ceiling for the current samples.
  LineChart.prototype._scaleMax = function () {
    if (this.max === 'auto' || this.max == null) {
      var peak = 0;
      for (var i = 0; i < this.values.length; i++) {
        var v = this.values[i];
        if (isFinite(v) && v > peak) peak = v;
      }
      if (peak <= 0) return 1; // avoid divide-by-zero; flat line at bottom
      // Headroom so the line never touches the very top, like Windows.
      return peak * 1.15;
    }
    var m = Number(this.max);
    return (isFinite(m) && m > 0) ? m : 100;
  };

  // Match the backing-store resolution to the element's CSS box * devicePixelRatio.
  LineChart.prototype._resize = function () {
    var c = this.canvas;
    if (!c) return null;
    this.dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth || c.width || 0;
    var h = c.clientHeight || c.height || 0;
    if (w <= 0 || h <= 0) return null;
    var bw = Math.max(1, Math.round(w * this.dpr));
    var bh = Math.max(1, Math.round(h * this.dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    return { w: w, h: h };
  };

  LineChart.prototype._draw = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    var size = this._resize();
    if (!size) return;
    var w = size.w, h = size.h, dpr = this.dpr;

    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 1px inset so the 1px stroke isn't clipped at the edges.
      var pad = 0.5;
      var left = pad, right = w - pad, top = pad, bottom = h - pad;
      var plotW = Math.max(1, right - left);
      var plotH = Math.max(1, bottom - top);

      // --- Grid: square cells like Windows Task Manager. Height is divided into
      //     a fixed number of rows; vertical lines use the SAME pixel spacing
      //     (so cells are square) and are anchored to the right edge. ---
      if (this.grid) {
        var rows = 10;
        var step = plotH / rows;
        ctx.lineWidth = 1;
        ctx.strokeStyle = this._gridColor;
        ctx.beginPath();
        for (var gy = 1; gy < rows; gy++) {
          var py = Math.round(top + step * gy) + 0.5;
          ctx.moveTo(left, py);
          ctx.lineTo(right, py);
        }
        for (var gx = right - step; gx > left; gx -= step) {
          var px = Math.round(gx) + 0.5;
          ctx.moveTo(px, top);
          ctx.lineTo(px, bottom);
        }
        ctx.stroke();

        // Outer frame (slightly stronger axis color).
        ctx.strokeStyle = this._axisColor;
        ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5,
          Math.round(plotW) - 1, Math.round(plotH) - 1);
      }

      var vals = this.values;
      var n = vals.length;
      if (n === 0) return;

      var scaleMax = this._scaleMax();

      // Map sample index -> x so the NEWEST sample sits at the right edge and the line
      // spans the full width (using MAX_SAMPLES-1 as the time axis denominator).
      var denom = Math.max(1, MAX_SAMPLES - 1);
      function xAt(i) {
        // i counts from the oldest (0) to newest (n-1). Pin newest to the right.
        var fromRight = (n - 1) - i; // 0 for newest
        return right - (fromRight * plotW) / denom;
      }
      function yAt(v) {
        if (!isFinite(v)) v = 0;
        var frac = v / scaleMax;
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
        return bottom - frac * plotH;
      }

      // --- Area fill under the line ---
      if (this.fill) {
        ctx.beginPath();
        var startX = (n === 1) ? left : xAt(0);
        ctx.moveTo(startX, bottom);
        if (n === 1) {
          // single sample -> flat fill across the width
          ctx.lineTo(left, yAt(vals[0]));
          ctx.lineTo(right, yAt(vals[0]));
        } else {
          for (var fi = 0; fi < n; fi++) {
            ctx.lineTo(xAt(fi), yAt(vals[fi]));
          }
        }
        ctx.lineTo(right, bottom);
        ctx.closePath();
        ctx.fillStyle = this.fillColor;
        ctx.fill();
      }

      // --- Line stroke ---
      ctx.beginPath();
      if (n === 1) {
        ctx.moveTo(left, yAt(vals[0]));
        ctx.lineTo(right, yAt(vals[0]));
      } else {
        for (var li = 0; li < n; li++) {
          var lx = xAt(li), ly = yAt(vals[li]);
          if (li === 0) ctx.moveTo(lx, ly);
          else ctx.lineTo(lx, ly);
        }
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = this.color;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } catch (e) {
      // Never let a draw failure break the poll loop.
      try { console.error('LineChart draw error:', e); } catch (_) {}
    }
  };

  TM.charts.LineChart = LineChart;
})();
