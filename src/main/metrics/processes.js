// processes.js — process enumeration + classification (main process).
// Exports async list() -> Process[], and classify() helper.
// Uses systeminformation si.processes() + si.cpu() (logical cores), and os.userInfo().
const si = require('systeminformation');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function execText(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout || ''));
      });
    } catch (_) { resolve(null); }
  });
}

// Per-process network throughput (bytes/sec) via `nettop`, computed from the
// delta of cumulative byte counters between polls. nettop is fast (~50ms) and
// needs no sudo. macOS exposes no per-process DISK io without elevated tools,
// so the Disk column stays 0.
let _netPrev = null; // { t, map: Map<pid, totalBytes> }
async function getNetRates() {
  const rates = new Map(); // pid -> bytes/sec
  try {
    const out = await execText('/usr/bin/nettop', ['-P', '-x', '-L', '1', '-J', 'bytes_in,bytes_out']);
    if (!out) return rates;
    const cur = new Map();
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 3) continue;
      const tag = parts[0];
      const dot = tag.lastIndexOf('.');
      if (dot < 0) continue;
      const pid = parseInt(tag.slice(dot + 1), 10);
      if (!Number.isFinite(pid)) continue;
      const total = (parseInt(parts[1], 10) || 0) + (parseInt(parts[2], 10) || 0);
      cur.set(pid, (cur.get(pid) || 0) + total);
    }
    const now = Date.now();
    if (_netPrev) {
      const dt = (now - _netPrev.t) / 1000;
      if (dt > 0) {
        cur.forEach((total, pid) => {
          const prev = _netPrev.map.get(pid);
          if (prev != null) {
            const r = (total - prev) / dt;
            if (r > 0) rates.set(pid, r);
          }
        });
      }
    }
    _netPrev = { t: now, map: cur };
  } catch (_) { /* ignore */ }
  return rates;
}

// ---- cached logical core count (si.cpu() is relatively expensive; fetch once) ----
let _logicalCores = 0;
async function getLogicalCores() {
  if (_logicalCores > 0) return _logicalCores;
  try {
    const cpu = await si.cpu();
    // si.cpu().cores === logical cores; fall back to os.cpus() or 1.
    _logicalCores = Number(cpu && cpu.cores) || (os.cpus() ? os.cpus().length : 0) || 1;
  } catch (_) {
    _logicalCores = (os.cpus() ? os.cpus().length : 0) || 1;
  }
  return _logicalCores;
}

// ---- cached current username ----
let _currentUser = null;
function getCurrentUser() {
  if (_currentUser !== null) return _currentUser;
  try {
    _currentUser = (os.userInfo().username || '').trim();
  } catch (_) {
    _currentUser = '';
  }
  return _currentUser;
}

// On macOS, si's `item.path` is the executable's *containing directory*
// (e.g. "/Applications/Telegram.app/Contents/MacOS"), so a naive basename yields
// generic segments like "MacOS"/"Resources". Derive a friendly display name by
// preferring the .app bundle name, then the command, then sensible fallbacks.
const GENERIC_DIRS = new Set([
  'MacOS', 'Resources', 'Contents', 'PlugIns', 'Frameworks',
  'bin', 'sbin', 'libexec', 'Helpers',
]);

function deriveName(item) {
  const p = (item && item.path) || '';
  const cmd = (item && item.command) || '';
  const rawName = (item && item.name) || '';

  // 1) Friendly GUI app name: the innermost ".app" bundle in the path.
  const haystack = p || cmd || rawName;
  if (haystack) {
    const matches = haystack.match(/([^/]+)\.app(?=\/|$)/g);
    if (matches && matches.length) {
      return matches[matches.length - 1].replace(/\.app$/, '');
    }
  }

  // 2) The command's first token (drop args), basename — for CLI/background procs.
  if (cmd) {
    const tok = cmd.split(/\s+/)[0] || cmd;
    const base = path.basename(tok);
    if (base && !GENERIC_DIRS.has(base)) return base;
    if (!cmd.includes('/')) return cmd.split(/\s+/)[0]; // e.g. "com.docker.backend"
  }

  // 3) Path basename, unless it's a generic bundle directory.
  if (p) {
    const base = path.basename(p);
    if (base && !GENERIC_DIRS.has(base)) return base;
  }

  // 4) Fall back to si's name.
  if (rawName) {
    const base = path.basename(rawName.split(/\s+/)[0] || rawName);
    if (base) return base;
  }
  return rawName || '';
}

// The outermost ".app" bundle path in a process path, used to fetch the app's
// real Finder icon (getFileIcon on the Contents/MacOS dir would give a folder
// icon). e.g. "/Applications/Telegram.app/Contents/MacOS" -> "/Applications/Telegram.app".
function appBundlePath(item) {
  const hay = (item && item.path) || (item && item.command) || '';
  const m = hay.match(/^(.*?\.app)(\/|$)/);
  return m ? m[1] : '';
}

const SYSTEM_PATH_PREFIXES = ['/System', '/usr/libexec', '/usr/sbin', '/sbin', '/usr/bin/'];

// Classify a process into "app" | "background" | "system".
//   app        -> has a .app bundle in path AND owned by current user AND not a helper.
//   system     -> user is root OR path under a system prefix.
//   background -> everything else.
function classify(item, currentUser) {
  const user = (item && item.user) || '';
  const execPath = (item && item.path) || '';
  const cmd = (item && item.command) || '';
  const name = (item && item.name) || '';
  const haystack = execPath || cmd || name;

  // System: root-owned, or executable lives under a system directory.
  if (user === 'root') return 'system';
  for (let i = 0; i < SYSTEM_PATH_PREFIXES.length; i++) {
    if (execPath && execPath.startsWith(SYSTEM_PATH_PREFIXES[i])) return 'system';
  }

  // App: a .app bundle in the path, owned by the current user, top-level (not a helper,
  // not buried only under a Frameworks dir).
  const hasAppBundle = /\.app\//.test(haystack) || /\.app$/.test(haystack);
  const ownedByUser = !!currentUser && user === currentUser;
  if (hasAppBundle && ownedByUser) {
    const lower = haystack.toLowerCase();
    const isHelper = /helper/.test(lower) || / --type=/.test(' ' + (cmd || '')) ;
    // A genuine top-level GUI app has its executable in Contents/MacOS, not nested
    // exclusively under a Frameworks directory.
    const inFrameworks = /\/(frameworks)\//i.test(execPath || haystack) &&
                         !/\/contents\/macos\//i.test((execPath || haystack).toLowerCase());
    if (!isHelper && !inFrameworks) return 'app';
  }

  return 'background';
}

// Convert one si process list item into the Process shape.
function toProcess(item, logicalCores, currentUser) {
  const rawCpu = Number(item.cpu);
  const cpu = Number.isFinite(rawCpu) && logicalCores > 0 ? rawCpu / logicalCores : 0;

  const rss = Number(item.memRss); // KB
  const memBytes = Number.isFinite(rss) ? rss * 1024 : 0;

  const memPercent = Number(item.mem);

  return {
    pid: Number(item.pid),
    ppid: Number(item.parentPid) || 0,
    name: deriveName(item) || String(item.name || `pid ${item.pid}`),
    cpu: Number.isFinite(cpu) ? cpu : 0,
    memBytes,
    memPercent: Number.isFinite(memPercent) ? memPercent : 0,
    user: (item.user || '').trim(),
    state: item.state || 'unknown',
    nice: Number.isFinite(Number(item.nice)) ? Number(item.nice) : 0,
    started: item.started || null,
    path: item.path || '',
    iconPath: appBundlePath(item), // .app bundle for the Finder icon ('' if none)
    command: item.command || '',
    netBytesSec: 0, // filled in from nettop deltas in list()
    type: classify(item, currentUser),
  };
}

// Public: enumerate processes. Returns [] on failure.
async function list() {
  try {
    const logicalCores = await getLogicalCores();
    const currentUser = getCurrentUser();
    const [data, netRates] = await Promise.all([si.processes(), getNetRates()]);
    const items = (data && Array.isArray(data.list)) ? data.list : [];

    const out = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.pid == null) continue;
      try {
        const p = toProcess(item, logicalCores, currentUser);
        const r = netRates.get(p.pid);
        if (r) p.netBytesSec = r;
        out.push(p);
      } catch (_) {
        // Skip an individual malformed entry rather than failing the whole list.
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = { list, classify };
