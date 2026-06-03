// ipc.js — registers all ipcMain handlers.
//
// Channel names are FIXED and must match preload.js exactly:
//   processes:list, system:stats, process:kill, process:priority, shell:reveal,
//   startup:list, users:list, services:list, services:toggle,
//   win:minimize, win:maximize, win:close
//
// Data/action channels delegate to sibling modules. Expected function signatures
// (these are the names this file relies on — keep them in sync across modules):
//
//   ./metrics/processes :  processes.list()                  -> Promise<Process[]>
//   ./metrics/system    :  system.stats()                    -> Promise<SystemStats>
//   ./actions           :  actions.kill(pid, force)          -> Promise<{ok, error?}> | void
//                          actions.setPriority(pid, nice)     -> Promise<{ok, error?}> | void
//                          actions.reveal(path)               -> Promise<{ok, error?}> | void
//                          actions.startupItems()             -> Promise<StartupItem[]>
//                          actions.users()                    -> Promise<UserSession[]>
//                          actions.services()                 -> Promise<ServiceItem[]>
//                          actions.toggleService(label, on)   -> Promise<{ok, error?}> | void
//
// Action channels (kill/priority/reveal/toggleService) always resolve to
// { ok:boolean, error?:string } and never reject. Data channels return their
// payload, falling back to a safe empty value on failure so the renderer never
// crashes on a missing metric.

const { ipcMain } = require('electron');

const processes = require('./metrics/processes');
const system = require('./metrics/system');
const actions = require('./actions');

// path -> icon data URL cache (icons never change while the app runs).
const _iconCache = new Map();

// Normalize any return value (or thrown error) into { ok, error? }.
async function asResult(fn) {
  try {
    const r = await fn();
    // Module may already return a result object; honor it.
    if (r && typeof r === 'object' && typeof r.ok === 'boolean') return r;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

// Safely run a data fetcher, falling back to `fallback` on any error.
async function safeData(fn, fallback) {
  try {
    const r = await fn();
    return r === undefined || r === null ? fallback : r;
  } catch (err) {
    console.error('[ipc] data handler failed:', errMessage(err));
    return fallback;
  }
}

function errMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

/**
 * Register every ipcMain handler. Call once at startup with the main BrowserWindow.
 * @param {import('electron').BrowserWindow} mainWindow
 */
function register(mainWindow) {
  // Guard against double-registration (e.g. window recreate on macOS).
  removeAll();

  // ---- Data channels -------------------------------------------------------
  ipcMain.handle('processes:list', () => safeData(() => processes.list(), []));

  ipcMain.handle('system:stats', () => safeData(() => system.stats(), null));

  ipcMain.handle('startup:list', () => safeData(() => actions.startupItems(), []));

  ipcMain.handle('users:list', () => safeData(() => actions.users(), []));

  ipcMain.handle('services:list', () => safeData(() => actions.services(), []));

  // ---- Action channels (always -> { ok, error? }) --------------------------
  ipcMain.handle('process:kill', (_e, pid, force = false) =>
    asResult(() => actions.kill(pid, force))
  );

  ipcMain.handle('process:priority', (_e, pid, nice) =>
    asResult(() => actions.setPriority(pid, nice))
  );

  ipcMain.handle('shell:reveal', (_e, path) =>
    asResult(() => actions.reveal(path))
  );

  ipcMain.handle('services:toggle', (_e, label, on) =>
    asResult(() => actions.toggleService(label, on))
  );

  ipcMain.handle('startup:setEnabled', (_e, label, type, enabled) =>
    asResult(() => actions.setStartupEnabled(label, type, enabled))
  );

  ipcMain.handle('task:run', (_e, command) =>
    asResult(() => actions.runTask(command))
  );

  // App icon (real .icns via sips) as a data URL, cached by bundle path.
  ipcMain.handle('app:icon', async (_e, p) => {
    if (!p || typeof p !== 'string') return '';
    if (_iconCache.has(p)) return _iconCache.get(p);
    let url = '';
    try { url = (await actions.appIconDataUrl(p)) || ''; } catch (_) { url = ''; }
    _iconCache.set(p, url);
    return url;
  });

  // ---- Window controls (frameless window) ----------------------------------
  ipcMain.handle('win:minimize', () =>
    asResult(() => {
      const w = resolveWindow(mainWindow);
      if (w && !w.isDestroyed()) w.minimize();
    })
  );

  ipcMain.handle('win:maximize', () =>
    asResult(() => {
      const w = resolveWindow(mainWindow);
      if (w && !w.isDestroyed()) {
        if (w.isMaximized()) w.unmaximize();
        else w.maximize();
      }
    })
  );

  ipcMain.handle('win:close', () =>
    asResult(() => {
      const w = resolveWindow(mainWindow);
      if (w && !w.isDestroyed()) w.close();
    })
  );
}

// Allow either a BrowserWindow or a getter function to be passed in.
function resolveWindow(win) {
  try {
    return typeof win === 'function' ? win() : win;
  } catch (_) {
    return null;
  }
}

// Remove all handlers this module registers (idempotent).
function removeAll() {
  const channels = [
    'processes:list', 'system:stats', 'process:kill', 'process:priority',
    'shell:reveal', 'startup:list', 'startup:setEnabled', 'users:list',
    'services:list', 'services:toggle', 'task:run', 'app:icon',
    'win:minimize', 'win:maximize', 'win:close',
  ];
  for (const c of channels) {
    try {
      ipcMain.removeHandler(c);
    } catch (_) {
      /* no handler registered yet — ignore */
    }
  }
}

module.exports = { register };
