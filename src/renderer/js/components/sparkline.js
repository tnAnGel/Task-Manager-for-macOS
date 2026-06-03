// sparkline.js — TM.charts.Sparkline
// Tiny inline area/line graph for the performance sidebar mini-graphs and the
// per-logical-core grid. Canvas 2D, devicePixelRatio-aware. Latest sample at the
// right edge. Faint Windows-11 styling: thin line + translucent area fill.
//
// Classic script — attaches to the shared global TM namespace.
//   new TM.charts.Sparkline(canvasEl, { color, fill = true, max = 100 })
//   .render(values[])  draw an explicit series (latest at right)
//   .push(v)           append to an internal ring buffer (<=60) and re-render

window.TM = window.TM || {};
TM.charts = TM.charts || {};

(function () {
  'use strict';

  var MAX_SAMPLES = 60;

  function readVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement)
        .getPropertyValue(name);
      v = v && v.trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  // Derive a faint fill from a solid stroke color. We can't reliably parse every
  // CSS color form, so we lean on the browser: paint the color into a 1x1 canvas
  // and read back its RGBA, then emit an rgba() with reduced alpha.
  function fillFromColor(color, alpha) {
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      var cx = c.getContext('2d');
      cx.fillStyle = '#000';
      cx.fillStyle = color; // invalid colors are ignored, leaving the prior value
      cx.fillRect(0, 0, 1, 1);
      var d = cx.getImageData(0, 0, 1, 1).data;
      return 'rgba(' + d[0] + ',' + d[1] + ',' + d[2] + ',' + alpha + ')';
    } catch (e) {
      return 'rgba(96,205,255,' + alpha + ')';
    }
  }

  function Sparkline(canvasEl, opts) {
    if (!canvasEl || !canvasEl.getContext) {
      throw new Error('Sparkline: a canvas element is required');
    }
    opts = opts || {};

    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.color = opts.color || readVar('--accent', '#60cdff');
    this.fill = opts.fill !== false; // default true
    this.max = (typeof opts.max === 'number' && opts.max > 0) ? opts.max : 100;
    this.fillStyleStr = (opts.fillColor) || fillFromColor(this.color, 0.18);

    // CSS pixel dimensions of the drawing surface (updated by _resize).
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;

    // Internal ring buffer used by push().
    this.buffer = [];

    this._resize();
  }

  // Match the canvas backing store to its CSS box * devicePixelRatio so lines
  // stay crisp on Retina displays. Returns true when usable dimensions exist.
  Sparkline.prototype._resize = function () {
    try {
      var dpr = window.devicePixelRatio || 1;
      var rect = this.canvas.getBoundingClientRect();
      var w = Math.max(0, Math.round(rect.width));
      var h = Math.max(0, Math.round(rect.height));

      // Fall back to attribute/style sizing if the element isn't laid out yet.
      if (!w) w = this.canvas.clientWidth || this.canvas.width || 0;
      if (!h) h = this.canvas.clientHeight || this.canvas.height || 0;

      this.cssW = w;
      this.cssH = h;
      this.dpr = dpr;

      var bw = Math.max(1, Math.round(w * dpr));
      var bh = Math.max(1, Math.round(h * dpr));
      if (this.canvas.width !== bw) this.canvas.width = bw;
      if (this.canvas.height !== bh) this.canvas.height = bh;

      return w > 0 && h > 0;
    } catch (e) {
      return false;
    }
  };

  // Append a value to the internal buffer (kept <= MAX_SAMPLES) and redraw.
  Sparkline.prototype.push = function (v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    this.buffer.push(n);
    if (this.buffer.length > MAX_SAMPLES) {
      this.buffer.splice(0, this.buffer.length - MAX_SAMPLES);
    }
    this.render(this.buffer);
  };

  // Draw the given series. Latest sample sits at the right edge; older samples
  // scroll off to the left. Values are clamped to [0, max].
  Sparkline.prototype.render = function (values) {
    var ctx = this.ctx;
    if (!ctx) return;

    // Re-measure: the element may have been resized or first laid out since
    // construction. Always sync the backing store before painting.
    var ok = this._resize();

    var w = this.cssW;
    var h = this.cssH;
    var dpr = this.dpr;

    // Reset transform, scale to CSS pixels, clear.
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch (e) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);

    if (!ok || w <= 0 || h <= 0) return;

    var data = Array.isArray(values) ? values : [];
    if (data.length === 0) return;

    var max = this.max > 0 ? this.max : 100;

    // Horizontal step. With a single point we still want a flat line.
    var n = data.length;
    var stepX = n > 1 ? (w / (MAX_SAMPLES - 1)) : 0;

    // Right-align the series: the most recent sample lands on the right edge.
    // x for the i-th (from the end) point.
    function xAt(idxFromRight) {
      return w - idxFromRight * stepX;
    }
    function yAt(val) {
      var v = Number(val);
      if (!isFinite(v)) v = 0;
      if (v < 0) v = 0;
      if (v > max) v = max;
      // Inset by 1px top/bottom so the stroke isn't clipped.
      var top = 1;
      var usable = h - 2;
      return top + (1 - v / max) * usable;
    }

    // Build the point list left->right (oldest drawn point .. newest at right).
    var points = [];
    for (var i = 0; i < n; i++) {
      var idxFromRight = (n - 1) - i; // 0 for the last element
      points.push({ x: xAt(idxFromRight), y: yAt(data[i]) });
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Area fill under the line.
    if (this.fill) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, h);
      for (var p = 0; p < points.length; p++) {
        ctx.lineTo(points[p].x, points[p].y);
      }
      ctx.lineTo(points[points.length - 1].x, h);
      ctx.closePath();
      ctx.fillStyle = this.fillStyleStr;
      ctx.fill();
    }

    // The line itself.
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var q = 1; q < points.length; q++) {
      ctx.lineTo(points[q].x, points[q].y);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.color;
    ctx.globalAlpha = 0.9; // faint, per spec
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  // Allow callers to recolor an existing sparkline (e.g. theme/metric change).
  Sparkline.prototype.setColor = function (color, fillColor) {
    if (color) {
      this.color = color;
      this.fillStyleStr = fillColor || fillFromColor(color, 0.18);
    } else if (fillColor) {
      this.fillStyleStr = fillColor;
    }
    this.render(this.buffer.length ? this.buffer : []);
  };

  // Clear the internal buffer and the canvas.
  Sparkline.prototype.clear = function () {
    this.buffer = [];
    if (this.ctx && this.cssW && this.cssH) {
      try {
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      } catch (e) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      this.ctx.clearRect(0, 0, this.cssW, this.cssH);
    }
  };

  TM.charts.Sparkline = Sparkline;
})();
