// contextMenu.js — TM.components.contextMenu
// Windows 11-style flyout rendered into #overlay-root.
//   TM.components.contextMenu.show(x, y, [
//     { label, danger?, disabled?, onClick },
//     { separator: true }
//   ]);
//   TM.components.contextMenu.hide();
//
// Behavior: rounded flyout on --bg-menu with --shadow-flyout, clamped to the
// viewport, dismissed on outside click / Escape / scroll / resize / blur.
// Each enabled item fires onClick then closes.

window.TM = window.TM || {};
TM.components = TM.components || {};

(function () {
  'use strict';

  var MARGIN = 6;       // gap from viewport edges when clamping
  var EST_ITEM_H = 30;  // estimated item height for pre-measure fallback

  // Module-level state for the single live menu instance.
  var menuEl = null;
  var listeners = null;

  function getRoot() {
    var root = document.getElementById('overlay-root');
    if (!root) {
      // Create the overlay root if it isn't there yet.
      root = document.createElement('div');
      root.id = 'overlay-root';
      document.body.appendChild(root);
    }
    return root;
  }

  // Tear down the current menu and all its global listeners.
  function hide() {
    if (listeners) {
      try {
        document.removeEventListener('mousedown', listeners.onDocMouseDown, true);
        document.removeEventListener('keydown', listeners.onKeyDown, true);
        document.removeEventListener('contextmenu', listeners.onDocContextMenu, true);
      } catch (e) { /* listeners may already be gone */ }
      listeners = null;
    }
    if (menuEl) {
      try {
        if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
      } catch (e) { /* node may already be detached */ }
      menuEl = null;
    }
  }

  // Position the menu, clamping so it stays fully inside the viewport.
  function clamp(el, x, y) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // Measure actual rendered size (element is already in the DOM, hidden).
    var w = el.offsetWidth || 180;
    var h = el.offsetHeight || (EST_ITEM_H * 3);

    var left = x;
    var top = y;

    // Prefer flipping to the left/up edge when there is not enough room.
    if (left + w > vw - MARGIN) {
      left = Math.max(MARGIN, x - w);
    }
    if (left + w > vw - MARGIN) {
      left = Math.max(MARGIN, vw - w - MARGIN);
    }
    if (left < MARGIN) left = MARGIN;

    if (top + h > vh - MARGIN) {
      top = Math.max(MARGIN, y - h);
    }
    if (top + h > vh - MARGIN) {
      top = Math.max(MARGIN, vh - h - MARGIN);
    }
    if (top < MARGIN) top = MARGIN;

    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function buildItem(item, index) {
    if (item && item.separator) {
      var sep = document.createElement('div');
      sep.className = 'ctx-separator';
      sep.setAttribute('role', 'separator');
      return sep;
    }

    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'ctx-item';
    el.setAttribute('role', 'menuitem');
    el.dataset.index = String(index);

    if (item.danger) el.classList.add('ctx-danger');
    var disabled = !!item.disabled;
    if (disabled) {
      el.classList.add('ctx-disabled');
      el.setAttribute('aria-disabled', 'true');
      el.disabled = true;
      el.tabIndex = -1;
    } else {
      el.tabIndex = 0;
    }

    var label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = (item.label != null) ? String(item.label) : '';
    el.appendChild(label);

    if (!disabled) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var fn = item.onClick;
        // Close first so onClick handlers can open another menu/dialog.
        hide();
        if (typeof fn === 'function') {
          try {
            fn();
          } catch (err) {
            // Never let an item handler bubble an exception out of the menu.
            if (window.console && console.error) console.error('[contextMenu] item onClick failed:', err);
          }
        }
      });

      // Hover focus mirrors Win11 keyboard/mouse focus tracking.
      el.addEventListener('mouseenter', function () {
        if (!el.disabled) el.focus();
      });
    }

    return el;
  }

  // Keyboard navigation across enabled items.
  function focusableItems() {
    if (!menuEl) return [];
    return Array.prototype.slice.call(
      menuEl.querySelectorAll('.ctx-item:not(.ctx-disabled)')
    );
  }

  function moveFocus(dir) {
    var items = focusableItems();
    if (!items.length) return;
    var active = document.activeElement;
    var idx = items.indexOf(active);
    var next;
    if (idx === -1) {
      next = dir > 0 ? 0 : items.length - 1;
    } else {
      next = (idx + dir + items.length) % items.length;
    }
    items[next].focus();
  }

  function show(x, y, items) {
    // Replace any existing menu.
    hide();

    if (!Array.isArray(items) || items.length === 0) return;

    var root = getRoot();

    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.tabIndex = -1;

    // Render off-screen first so we can measure before clamping.
    menuEl.style.position = 'fixed';
    menuEl.style.left = '-9999px';
    menuEl.style.top = '-9999px';
    menuEl.style.visibility = 'hidden';

    for (var i = 0; i < items.length; i++) {
      var node = buildItem(items[i], i);
      if (node) menuEl.appendChild(node);
    }

    root.appendChild(menuEl);

    // Now measured: position and reveal.
    clamp(menuEl, Number(x) || 0, Number(y) || 0);
    menuEl.style.visibility = 'visible';

    // Focus the first enabled item for keyboard users.
    var firstEnabled = menuEl.querySelector('.ctx-item:not(.ctx-disabled)');
    if (firstEnabled) {
      try { firstEnabled.focus(); } catch (e) { /* ignore */ }
    } else {
      try { menuEl.focus(); } catch (e) { /* ignore */ }
    }

    // Brief "arm" delay: ignore dismissal until the opening gesture's trailing
    // events (mouseup, etc.) have passed, so the menu can't close before use.
    var armed = false;
    setTimeout(function () { armed = true; }, 250);

    // --- Dismissal + navigation listeners ---
    listeners = {
      onDocMouseDown: function (ev) {
        // A click inside the menu is handled by the item's own click handler.
        if (menuEl && menuEl.contains(ev.target)) return;
        if (!armed) return;
        hide();
      },
      onDocContextMenu: function (ev) {
        // A right-click elsewhere dismisses this menu (the new one opens after).
        if (menuEl && menuEl.contains(ev.target)) {
          ev.preventDefault();
          return;
        }
        if (!armed) return;
        hide();
      },
      onKeyDown: function (ev) {
        switch (ev.key) {
          case 'Escape':
            ev.preventDefault();
            ev.stopPropagation();
            hide();
            break;
          case 'ArrowDown':
            ev.preventDefault();
            moveFocus(1);
            break;
          case 'ArrowUp':
            ev.preventDefault();
            moveFocus(-1);
            break;
          case 'Home':
            ev.preventDefault();
            (function () { var it = focusableItems(); if (it.length) it[0].focus(); })();
            break;
          case 'End':
            ev.preventDefault();
            (function () { var it = focusableItems(); if (it.length) it[it.length - 1].focus(); })();
            break;
          case 'Enter':
          case ' ': {
            var active = document.activeElement;
            if (active && menuEl && menuEl.contains(active) && active.classList.contains('ctx-item')) {
              ev.preventDefault();
              active.click();
            }
            break;
          }
          default:
            break;
        }
      }
    };

    // Capture phase so we see the events before view-level handlers. The menu
    // closes only on a click/right-click OUTSIDE it or Escape (or selecting an
    // item) — not on scroll, hover, resize, focus changes, or background polls.
    document.addEventListener('mousedown', listeners.onDocMouseDown, true);
    document.addEventListener('keydown', listeners.onKeyDown, true);
    document.addEventListener('contextmenu', listeners.onDocContextMenu, true);
  }

  TM.components.contextMenu = {
    show: show,
    hide: hide,
  };
})();
