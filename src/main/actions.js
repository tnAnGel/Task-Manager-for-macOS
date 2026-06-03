// actions.js — process actions + startup/users/services providers.
// macOS (darwin) target. Uses Node child_process + fs only, plus systeminformation, os, electron.shell.
// Every exported function is wrapped in try/catch so they don't throw.

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

let si = null;
try {
  si = require('systeminformation');
} catch (_) {
  si = null;
}

// --- helpers --------------------------------------------------------------

// Run a command and collect its output. Resolves with
// { ok, code, stdout, stderr, error } and never rejects.
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, Object.assign({ windowsHide: true }, opts || {}));
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: String(e && e.message ? e.message : e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => { stdout += d; });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => { stderr += d; });
      }
    } catch (_) { /* ignore stream wiring errors */ }

    child.on('error', (e) => {
      finish({ ok: false, code: null, stdout, stderr, error: String(e && e.message ? e.message : e) });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, error: code === 0 ? undefined : (stderr.trim() || ('exit code ' + code)) });
    });
  });
}

// --- process actions ------------------------------------------------------

// kill(pid, force) — SIGKILL when force, else SIGTERM. Returns {ok,error}.
function kill(pid, force) {
  try {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'Invalid pid' };
    }
    process.kill(n, force ? 'SIGKILL' : 'SIGTERM');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// setPriority(pid, nice) — renice the process (works without sudo for your own).
async function setPriority(pid, nice) {
  try {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'Invalid pid' };
    }
    let niceVal = Number(nice);
    if (!Number.isFinite(niceVal)) niceVal = 0;
    niceVal = Math.round(niceVal);
    // clamp to valid renice range
    if (niceVal < -20) niceVal = -20;
    if (niceVal > 20) niceVal = 20;

    const res = await run('renice', [String(niceVal), '-p', String(n)]);
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error || 'renice failed' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// reveal(path) — show item in Finder via electron shell. Returns {ok,error}.
function reveal(targetPath) {
  try {
    if (!targetPath || typeof targetPath !== 'string') {
      return { ok: false, error: 'No path provided' };
    }
    const { shell } = require('electron');
    if (!shell || typeof shell.showItemInFolder !== 'function') {
      return { ok: false, error: 'shell unavailable' };
    }
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// --- startup items provider -----------------------------------------------

// Single-quote a string for safe embedding in a /bin/sh command.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Run a shell command with an admin (password) prompt via osascript. Used for
// system LaunchDaemons, which the user can't toggle without elevated rights.
function runAdmin(shellCmd) {
  const script =
    'do shell script "' +
    shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') +
    '" with administrator privileges';
  return run('osascript', ['-e', script]);
}

function friendlyErr(e) {
  const s = String(e == null ? '' : e);
  if (/-128|user canceled|cancell?ed/i.test(s)) return 'Cancelled';
  if (/not permitted|operation not permitted|denied/i.test(s)) {
    return 'Requires administrator privileges';
  }
  return s.trim() || 'Failed to update startup item';
}

// Current uid, defaulting to 501 (first user) if unavailable.
function currentUid() {
  try { if (process.getuid) return process.getuid(); } catch (_) {}
  return 501;
}

// Set of launchd labels currently DISABLED (across the user gui + system domains),
// parsed from `launchctl print-disabled`. Both are readable without sudo.
async function getDisabledLabels() {
  const set = new Set();
  const domains = ['gui/' + currentUid(), 'system'];
  for (const domain of domains) {
    const res = await run('launchctl', ['print-disabled', domain]);
    if (!res || !res.ok) continue;
    const re = /"([^"]+)"\s*=>\s*disabled/g;
    let m;
    while ((m = re.exec(res.stdout))) set.add(m[1]);
  }
  return set;
}

// Enable/disable a startup item's autostart. LaunchAgents toggle in the user's
// gui domain (no sudo); LaunchDaemons need the system domain (admin prompt).
async function setStartupEnabled(label, type, enabled) {
  try {
    if (!label) return { ok: false, error: 'Missing service label' };
    const domain = type === 'LaunchDaemon' ? 'system' : 'gui/' + currentUid();
    const verb = enabled ? 'enable' : 'disable';
    const target = domain + '/' + label;

    // Try directly first (works for user agents without elevation).
    const res = await run('launchctl', [verb, target]);
    if (res.ok) return { ok: true };

    // Fall back to an admin prompt for system daemons / permission errors.
    const admin = await runAdmin('launchctl ' + verb + ' ' + shellQuote(target));
    if (admin.ok) return { ok: true };

    return { ok: false, error: friendlyErr(admin.error || res.error) };
  } catch (e) {
    return { ok: false, error: friendlyErr(e && e.message ? e.message : e) };
  }
}

// Resolve a .app bundle's real icon as a PNG data URL. app.getFileIcon returns
// generic icons for most third-party apps, so we read the bundle's .icns and
// convert it with `sips`. Returns '' if no icon can be produced.
async function appIconDataUrl(bundlePath) {
  try {
    if (!bundlePath || typeof bundlePath !== 'string' || !bundlePath.endsWith('.app')) return '';
    const resDir = path.join(bundlePath, 'Contents', 'Resources');

    // Preferred icon name from Info.plist (CFBundleIconFile).
    let icns = '';
    const r = await run('defaults', ['read', path.join(bundlePath, 'Contents', 'Info'), 'CFBundleIconFile']);
    if (r.ok) {
      let name = (r.stdout || '').trim();
      if (name) {
        if (!/\.icns$/i.test(name)) name += '.icns';
        const cand = path.join(resDir, name);
        if (fs.existsSync(cand)) icns = cand;
      }
    }
    // Fallback: the largest .icns in Resources.
    if (!icns) {
      const icnsFiles = readDirSafe(resDir)
        .filter((f) => typeof f === 'string' && /\.icns$/i.test(f))
        .map((f) => path.join(resDir, f));
      if (icnsFiles.length) {
        icnsFiles.sort((a, b) => {
          let sa = 0, sb = 0;
          try { sa = fs.statSync(a).size; } catch (_) {}
          try { sb = fs.statSync(b).size; } catch (_) {}
          return sb - sa;
        });
        icns = icnsFiles[0];
      }
    }
    if (!icns) return '';

    // Convert to a 64px PNG (crisp at 16px @2x) in a temp file, then read it.
    // The filename must be unique per bundle — a short hash of the full path is
    // not enough (all /Applications/* apps share a prefix), so use the full hash.
    const hash = crypto.createHash('md5').update(bundlePath).digest('hex');
    const tmp = path.join(os.tmpdir(), 'tm-icon-' + hash + '.png');
    const conv = await run('sips', ['-s', 'format', 'png', icns, '--out', tmp, '-Z', '64']);
    if (!conv.ok) return '';

    let dataUrl = '';
    try {
      const buf = fs.readFileSync(tmp);
      if (buf && buf.length) dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    } catch (_) { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return dataUrl;
  } catch (_) {
    return '';
  }
}

// Run a user-supplied command/app (Windows "Run new task" analog). Launches via
// a login shell so PATH is populated (handles `open -a Safari`, `top`, paths…).
function runTask(command) {
  return new Promise((resolve) => {
    try {
      if (!command || typeof command !== 'string' || !command.trim()) {
        resolve({ ok: false, error: 'Enter a command to run' });
        return;
      }
      const child = spawn('/bin/sh', ['-lc', command.trim()], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (e) => {
        resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      });
      // Detached: we can't wait for success, so report ok once it spawns.
      child.unref();
      resolve({ ok: true });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

// Map a plist filename + source directory to a StartupItem.
function plistToName(fileName) {
  let base = fileName;
  if (base.toLowerCase().endsWith('.plist')) {
    base = base.slice(0, -('.plist'.length));
  }
  return base;
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

// startupItems() — read LaunchAgents / LaunchDaemons plist filenames.
async function startupItems() {
  try {
    const home = (() => {
      try { return os.homedir(); } catch (_) { return process.env.HOME || ''; }
    })();

    const sources = [
      { dir: home ? path.join(home, 'Library', 'LaunchAgents') : null, type: 'LaunchAgent' },
      { dir: '/Library/LaunchAgents', type: 'LaunchAgent' },
      { dir: '/Library/LaunchDaemons', type: 'LaunchDaemon' },
    ];

    const disabled = await getDisabledLabels();

    const items = [];
    const seen = new Set();

    for (const src of sources) {
      if (!src.dir) continue;
      const entries = readDirSafe(src.dir);
      for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        if (!entry.toLowerCase().endsWith('.plist')) continue;
        const full = path.join(src.dir, entry);
        // de-dup by full path
        if (seen.has(full)) continue;
        seen.add(full);
        const label = plistToName(entry);
        items.push({
          name: label,
          label, // launchd service label (== plist basename)
          path: full,
          type: src.type,
          scope: src.type === 'LaunchDaemon' ? 'system' : 'user',
          enabled: !disabled.has(label), // real state from launchctl print-disabled
          impact: '—',
        });
      }
    }

    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  } catch (e) {
    return [];
  }
}

// --- users provider --------------------------------------------------------

// users() — aggregate running processes per user into UserSession[].
async function users() {
  try {
    const currentUser = (() => {
      try { return os.userInfo().username; } catch (_) { return process.env.USER || ''; }
    })();

    let list = [];
    if (si && typeof si.processes === 'function') {
      try {
        const procs = await si.processes();
        list = (procs && Array.isArray(procs.list)) ? procs.list : [];
      } catch (_) {
        list = [];
      }
    }

    // Logical core count, to normalize summed per-core cpu% to a 0-100 scale
    // (matches metrics/processes.js so the Users CPU column reads like Windows).
    let cores = 1;
    try {
      const cpu = await si.cpu();
      cores = Number(cpu && cpu.cores) || (os.cpus() ? os.cpus().length : 1) || 1;
    } catch (_) {
      cores = (os.cpus() ? os.cpus().length : 1) || 1;
    }

    const byUser = new Map();
    for (const p of list) {
      if (!p) continue;
      const user = (p.user && String(p.user).trim()) || 'unknown';
      let agg = byUser.get(user);
      if (!agg) {
        agg = { user, pid: null, cpu: 0, memBytes: 0, processes: 0, status: 'Disconnected' };
        byUser.set(user, agg);
      }
      const cpu = Number(p.cpu);
      if (Number.isFinite(cpu)) agg.cpu += cpu;
      // memRss is in KB per the systeminformation cheat-sheet
      const rssKb = Number(p.memRss);
      if (Number.isFinite(rssKb)) agg.memBytes += rssKb * 1024;
      agg.processes += 1;
    }

    const out = [];
    for (const agg of byUser.values()) {
      agg.cpu = Math.round((agg.cpu / cores) * 10) / 10;
      agg.status = (currentUser && agg.user === currentUser) ? 'Active' : 'Disconnected';
      out.push(agg);
    }

    // Active user first, then by process count desc
    out.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'Active' ? -1 : 1;
      return b.processes - a.processes;
    });

    return out;
  } catch (e) {
    return [];
  }
}

// --- services provider -----------------------------------------------------

// Parse `launchctl list` output. Columns: PID  Status  Label (whitespace-separated,
// header line present). A '-' PID means not running.
function parseLaunchctlList(stdout) {
  const services = [];
  if (!stdout) return services;

  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    // Split on runs of whitespace/tabs into at most 3 columns.
    const trimmed = line.replace(/\s+$/, '');
    const parts = trimmed.split(/\t|\s{1,}/).filter((s) => s.length > 0);
    if (parts.length < 3) continue;

    const pidRaw = parts[0];
    // Skip the header row.
    if (pidRaw === 'PID' || pidRaw.toLowerCase() === 'pid') continue;

    // Label is everything after the first two columns (labels may contain spaces,
    // though rare). Rejoin remaining parts to preserve any internal spacing.
    const label = parts.slice(2).join(' ');
    if (!label) continue;

    let pid = null;
    let status = 'stopped';
    if (pidRaw !== '-') {
      const n = parseInt(pidRaw, 10);
      if (Number.isInteger(n) && n > 0) {
        pid = n;
        status = 'running';
      }
    }

    services.push({ label, pid, status, type: 'user' });
  }
  return services;
}

// services() — list launchd services via `launchctl list`.
async function services() {
  try {
    const res = await run('launchctl', ['list']);
    if (!res.stdout) return [];
    const parsed = parseLaunchctlList(res.stdout);
    parsed.sort((a, b) => a.label.localeCompare(b.label));
    return parsed;
  } catch (e) {
    return [];
  }
}

// toggleService(label, on) — enable/disable a service. Returns {ok,error}.
async function toggleService(label, on) {
  try {
    if (!label || typeof label !== 'string') {
      return { ok: false, error: 'No service label provided' };
    }
    // launchctl enable/disable expects a service target like "gui/<uid>/<label>"
    // or "user/<uid>/<label>". Use the gui domain for the current user.
    let uid;
    try { uid = process.getuid ? process.getuid() : (os.userInfo().uid); } catch (_) { uid = null; }
    if (uid === null || uid === undefined) {
      return { ok: false, error: 'Could not determine current uid' };
    }

    const verb = on ? 'enable' : 'disable';
    const target = 'gui/' + uid + '/' + label;
    const res = await run('launchctl', [verb, target]);
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error || 'launchctl ' + verb + ' failed' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

module.exports = {
  kill,
  setPriority,
  reveal,
  startupItems,
  setStartupEnabled,
  appIconDataUrl,
  runTask,
  users,
  services,
  toggleService,
};
