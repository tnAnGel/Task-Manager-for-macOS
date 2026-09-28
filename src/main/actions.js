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

function pathExists(p) {
  try { return !!(p && fs.existsSync(p)); } catch (_) { return false; }
}

// Reverse-DNS first labels (com/org/net/…) skipped when inferring the vendor.
const DNS_SKIP = new Set([
  'com', 'org', 'net', 'io', 'co', 'edu', 'gov', 'mil', 'info', 'biz', 'dev',
  'app', 'me', 'us', 'uk', 'de', 'fr', 'ru', 'jp', 'cn', 'au', 'ca', 'nl',
  'it', 'es', 'br', 'in', 'kr', 'eu', 'tv',
]);

// Known vendors → display name. Keys are the reverse-DNS company token.
const VENDOR_NAMES = {
  adobe: 'Adobe',
  google: 'Google',
  docker: 'Docker',
  apple: 'Apple',
  microsoft: 'Microsoft',
  oracle: 'Oracle',
  valvesoftware: 'Steam',
  valve: 'Steam',
  happ: 'Happ',
  dropbox: 'Dropbox',
  spotify: 'Spotify',
  logitech: 'Logitech',
  zoom: 'Zoom',
  slack: 'Slack',
  discord: 'Discord',
  jetbrains: 'JetBrains',
  github: 'GitHub',
  gitlab: 'GitLab',
  mozilla: 'Mozilla',
  brave: 'Brave',
  opera: 'Opera',
  yandex: 'Yandex',
  autodesk: 'Autodesk',
  parallels: 'Parallels',
  vmware: 'VMware',
  teamviewer: 'TeamViewer',
  nordvpn: 'NordVPN',
  cloudflare: 'Cloudflare',
  amazon: 'Amazon',
  meta: 'Meta',
  facebook: 'Meta',
  telegram: 'Telegram',
  skype: 'Skype',
  cisco: 'Cisco',
  intel: 'Intel',
  nvidia: 'NVIDIA',
  wacom: 'Wacom',
  elgato: 'Elgato',
  synology: 'Synology',
  backblaze: 'Backblaze',
  malwarebytes: 'Malwarebytes',
  bitdefender: 'Bitdefender',
  kaspersky: 'Kaspersky',
  '1password': '1Password',
  lastpass: 'LastPass',
  bitwarden: 'Bitwarden',
  notion: 'Notion',
  figma: 'Figma',
  cursor: 'Cursor',
  steam: 'Steam',
  tailscale: 'Tailscale',
  duckbridge: 'DuckVPN',
  fabriceleyne: 'Fabrice Leyne',
  opengater: 'OpenGater',
  morkovka: 'Morkovka',
  jcode: 'jcode',
};

// Vendors whose agents/daemons should nest under one parent when 2+ items exist.
const GROUPABLE_VENDORS = new Set([
  'adobe', 'google', 'docker', 'apple', 'microsoft', 'oracle', 'valvesoftware',
]);

// Exact launchd labels → friendly item name (vendor still comes from the DNS token).
const LABEL_DISPLAY = {
  'com.adobe.AdobeCreativeCloud': 'Adobe Creative Cloud',
  'com.adobe.ccxprocess': 'Adobe Creative Cloud Experience',
  'com.adobe.CCXProcess': 'Adobe Creative Cloud Experience',
  'com.adobe.acc.installer.v2': 'Adobe Creative Cloud Installer',
  'com.adobe.acc.installer': 'Adobe Creative Cloud Installer',
  'com.adobe.GC.Invoker-1.0': 'Adobe Genuine Software',
  'com.adobe.agsservice': 'Adobe Genuine Software',
  'com.google.GoogleUpdater.wake': 'Google Updater',
  'com.google.GoogleUpdater.wake.system': 'Google Updater',
  'com.google.keystone.agent': 'Google Keystone Agent',
  'com.google.keystone.daemon': 'Google Keystone Daemon',
  'com.google.keystone.xpcservice': 'Google Keystone XPC',
  'com.google.keystone.system.agent': 'Google Keystone Agent',
  'com.docker.socket': 'Docker Socket',
  'com.docker.vmnetd': 'Docker Networking',
  'com.docker.helper': 'Docker Helper',
  'com.microsoft.SyncReporter': 'OneDrive Sync Reporter',
  'com.microsoft.update.agent': 'Microsoft AutoUpdate',
  'com.microsoft.autoupdate.helper': 'Microsoft AutoUpdate Helper',
  'com.microsoft.office.licensingV2.helper': 'Microsoft Office Licensing',
  'com.microsoft.OneDriveStandaloneUpdater': 'OneDrive',
  'com.microsoft.OneDriveUpdaterDaemon': 'OneDrive',
  'com.oracle.java.Java-Updater': 'Java Updater',
  'com.valvesoftware.steamclean': 'Steam',
  'com.happ.happd': 'Happ',
  'com.morkovka.CmdShiftLayoutSwitcher': 'CmdShift Layout Switcher',
  'com.morkovka.wayro-stability-24h': 'Wayro Stability Monitor',
  'com.jcode.hotkey': 'jcode Hotkey',
  'net.duckbridge.duckvpn.billing-reminder': 'DuckVPN Billing Reminder',
  'com.fabriceleyne.powermetrics': 'Power Metrics',
  'com.opengater.tailscale-route-fix': 'Tailscale Route Fix',
  RoverService: 'Rover Service',
};

const TOKEN_DISPLAY = {
  acc: 'Creative Cloud',
  ccxprocess: 'Creative Cloud Experience',
  keystone: 'Updater',
  xpcservice: 'XPC Service',
  vmnetd: 'Networking',
  steamclean: 'Steam',
  autoupdate: 'AutoUpdate',
  syncreporter: 'Sync Reporter',
  happd: 'Happ',
  powermetrics: 'Power Metrics',
  licensingv2: 'Licensing',
  googleupdater: 'Updater',
  installer: 'Installer',
  helper: 'Helper',
  agent: 'Agent',
  daemon: 'Daemon',
  wake: '',
  socket: 'Socket',
};

// Well-known .app locations used when a helper binary lives in PrivilegedHelperTools.
const VENDOR_APP_HINTS = {
  adobe: [
    '/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app',
    '/Applications/Adobe Creative Cloud/Adobe Creative Cloud.app',
  ],
  docker: ['/Applications/Docker.app'],
  google: [
    '/Applications/Google Chrome.app',
    '/Applications/Google Drive.app',
  ],
  microsoft: [
    '/Library/Application Support/Microsoft/MAU2.0/Microsoft AutoUpdate.app',
    '/Applications/Microsoft Excel.app',
    '/Applications/Microsoft Word.app',
    '/Applications/OneDrive.app',
  ],
  oracle: [
    '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Resources/Java Updater.app',
  ],
  valvesoftware: ['/Applications/Steam.app'],
  happ: ['/Applications/Happ 2.app', '/Applications/Happ.app'],
  apple: ['/System/Applications/App Store.app'],
  dropbox: ['/Applications/Dropbox.app'],
  spotify: ['/Applications/Spotify.app'],
  zoom: ['/Applications/zoom.us.app'],
  tailscale: ['/Applications/Tailscale.app'],
  steam: ['/Applications/Steam.app'],
};

const _bundleMetaCache = new Map();

async function readPlistJson(plistPath) {
  const res = await run('plutil', ['-convert', 'json', '-o', '-', plistPath]);
  if (!res || !res.ok || !res.stdout) return null;
  try { return JSON.parse(res.stdout); } catch (_) { return null; }
}

function plistString(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object') {
    if (typeof v.CFBundleDisplayName === 'string') return v.CFBundleDisplayName;
    if (typeof v[''] === 'string') return v[''];
    if (typeof v.en === 'string') return v.en;
  }
  return '';
}

function humanizeIdentifier(s) {
  return String(s || '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCaseWord(s) {
  if (!s) return '';
  if (/^[A-Z0-9]+$/.test(s) && s.length <= 4) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function humanizeToken(raw) {
  const t = String(raw || '');
  if (!t || /^v?\d+(\.\d+)*$/i.test(t)) return '';
  const key = t.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (Object.prototype.hasOwnProperty.call(TOKEN_DISPLAY, key)) return TOKEN_DISPLAY[key];
  return humanizeIdentifier(t).split(/\s+/).map(titleCaseWord).join(' ');
}

function dedupeWords(s) {
  const parts = String(s || '').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (out.length && out[out.length - 1].toLowerCase() === parts[i].toLowerCase()) continue;
    out.push(parts[i]);
  }
  return out.join(' ');
}

function decodeLabel(label) {
  const raw = String(label || '');
  const mapped = LABEL_DISPLAY[raw];
  const parts = raw.split('.').filter(Boolean);
  let idx = 0;
  if (parts.length >= 2 && DNS_SKIP.has(parts[0].toLowerCase())) idx = 1;
  const vendorRaw = (parts[idx] || '').toLowerCase();
  const vendor = VENDOR_NAMES[vendorRaw] || (parts[idx] ? humanizeIdentifier(parts[idx]) : '');
  const rest = parts.slice(idx + 1).map(humanizeToken).filter(Boolean);
  let product = dedupeWords(rest.join(' '));
  // Don't repeat the vendor in the product ("Google Google Updater").
  if (vendor && product.toLowerCase().indexOf(vendor.toLowerCase()) === 0) {
    product = product.slice(vendor.length).trim();
  }
  let displayName = mapped || dedupeWords([vendor, product].filter(Boolean).join(' '));
  if (!displayName) displayName = humanizeIdentifier(raw) || raw || '(unknown)';
  return {
    vendorKey: vendorRaw,
    vendor: vendor,
    displayName: displayName,
  };
}

function programCandidates(pl) {
  const out = [];
  if (!pl || typeof pl !== 'object') return out;
  if (typeof pl.Program === 'string' && pl.Program) out.push(pl.Program);
  const args = pl.ProgramArguments;
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === 'string' && args[i]) out.push(args[i]);
    }
  }
  return out;
}

function bundlesInPath(p) {
  const s = String(p || '');
  const out = [];
  let from = 0;
  const lower = s.toLowerCase();
  while (from < s.length) {
    const idx = lower.indexOf('.app', from);
    if (idx < 0) break;
    const end = idx + 4;
    const next = s.charAt(end);
    if (next && next !== '/' && next !== '\\') { from = idx + 1; continue; }
    out.push(s.slice(0, end));
    from = end;
  }
  return out;
}

function similarApp(missingBundle) {
  if (!missingBundle) return '';
  const dir = path.dirname(missingBundle);
  const base = path.basename(missingBundle, '.app');
  if (!base) return '';
  const lower = base.toLowerCase();
  const entries = readDirSafe(dir);
  let fuzzy = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (typeof e !== 'string' || !e.toLowerCase().endsWith('.app')) continue;
    const stem = e.slice(0, -4).toLowerCase();
    if (stem === lower) return path.join(dir, e);
    if (!fuzzy && (stem.indexOf(lower) === 0)) fuzzy = path.join(dir, e);
  }
  return fuzzy;
}

function firstHint(list) {
  if (!Array.isArray(list)) return '';
  for (let i = 0; i < list.length; i++) {
    if (pathExists(list[i]) && bundleHasIcon(list[i])) return list[i];
  }
  return '';
}

function bundleHasIcon(bundlePath) {
  const resDir = path.join(bundlePath, 'Contents', 'Resources');
  if (!pathExists(resDir)) return false;
  const files = readDirSafe(resDir);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (typeof f !== 'string') continue;
    if (/\.icns$/i.test(f) || /^Assets\.car$/i.test(f)) return true;
  }
  return false;
}

function resolveIconFromProgram(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const bundles = bundlesInPath(candidates[i]);
    for (let b = 0; b < bundles.length; b++) {
      if (pathExists(bundles[b]) && bundleHasIcon(bundles[b])) return bundles[b];
    }
    if (bundles.length) {
      const sim = similarApp(bundles[0]);
      if (sim && bundleHasIcon(sim)) return sim;
    }
  }
  return '';
}

function hintIconPath(vendorKey, label, candidates) {
  const hinted = firstHint(VENDOR_APP_HINTS[vendorKey]);
  if (hinted) return hinted;
  const low = String(label || '').toLowerCase() + ' ' + (candidates || []).join(' ').toLowerCase();
  if (/\btailscale\b/.test(low)) {
    const p = firstHint(VENDOR_APP_HINTS.tailscale);
    if (p) return p;
  }
  if (/\bsteam\b/.test(low)) {
    const p = firstHint(VENDOR_APP_HINTS.steam);
    if (p) return p;
  }
  if (vendorKey) {
    const titled = (VENDOR_NAMES[vendorKey] || vendorKey);
    const guess = path.join('/Applications', titled + '.app');
    if (pathExists(guess)) return guess;
  }
  return '';
}

async function bundleMeta(bundlePath) {
  if (!bundlePath) return { name: '', id: '' };
  if (_bundleMetaCache.has(bundlePath)) return _bundleMetaCache.get(bundlePath);
  const infoPath = path.join(bundlePath, 'Contents', 'Info.plist');
  const pl = pathExists(infoPath) ? await readPlistJson(infoPath) : null;
  const name = pl
    ? (plistString(pl.CFBundleDisplayName) || plistString(pl.CFBundleName) || '')
    : '';
  const id = pl ? plistString(pl.CFBundleIdentifier) : '';
  const meta = { name: name || path.basename(bundlePath, '.app'), id: id };
  _bundleMetaCache.set(bundlePath, meta);
  return meta;
}

function shareGroupIcons(items) {
  const byVendor = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.vendorKey || !GROUPABLE_VENDORS.has(it.vendorKey)) continue;
    if (!byVendor.has(it.vendorKey)) byVendor.set(it.vendorKey, []);
    byVendor.get(it.vendorKey).push(it);
  }
  byVendor.forEach((list) => {
    let icon = '';
    for (let i = 0; i < list.length; i++) {
      if (list[i].iconPath) { icon = list[i].iconPath; break; }
    }
    if (!icon) return;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].iconPath) list[i].iconPath = icon;
    }
  });
}

function applyIconHints(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || it.iconPath) continue;
    it.iconPath = hintIconPath(it.vendorKey, it.label, it.program ? [it.program] : []) || '';
  }
}

async function enrichStartupItem(src, entry, disabled) {
  const full = path.join(src.dir, entry);
  const fileLabel = plistToName(entry);
  let pl = null;
  try { pl = await readPlistJson(full); } catch (_) { pl = null; }

  const serviceLabel = (pl && typeof pl.Label === 'string' && pl.Label.trim())
    ? pl.Label.trim()
    : fileLabel;
  const candidates = programCandidates(pl);
  const program = candidates.find((c) => c.charAt(0) === '/') || candidates[0] || '';
  const decoded = decodeLabel(serviceLabel);
  const iconPath = resolveIconFromProgram(candidates);

  let displayName = decoded.displayName;
  let bundleName = '';
  if (iconPath) {
    const meta = await bundleMeta(iconPath);
    bundleName = meta.name || '';
    const livesInBundle = candidates.some((c) =>
      c === iconPath || c.indexOf(iconPath + '/') === 0);
    if (!LABEL_DISPLAY[serviceLabel] && livesInBundle && bundleName) {
      displayName = bundleName;
    }
  }

  const groupable = GROUPABLE_VENDORS.has(decoded.vendorKey);
  return {
    name: displayName || fileLabel,
    label: serviceLabel,
    path: full,
    type: src.type,
    scope: src.type === 'LaunchDaemon' ? 'system' : 'user',
    enabled: !disabled.has(serviceLabel) && !disabled.has(fileLabel),
    impact: '—',
    displayName: displayName || fileLabel,
    vendor: decoded.vendor || '',
    vendorKey: decoded.vendorKey || '',
    iconPath: iconPath || '',
    program: program || '',
    bundleName: bundleName || '',
    groupKey: groupable ? decoded.vendorKey : '',
    groupName: groupable ? (decoded.vendor || '') : '',
  };
}

// startupItems() — LaunchAgents / LaunchDaemons with friendly names + icons.
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
    const jobs = [];
    const seen = new Set();

    for (const src of sources) {
      if (!src.dir) continue;
      const entries = readDirSafe(src.dir);
      for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        if (!entry.toLowerCase().endsWith('.plist')) continue;
        const full = path.join(src.dir, entry);
        if (seen.has(full)) continue;
        seen.add(full);
        jobs.push(enrichStartupItem(src, entry, disabled));
      }
    }

    const items = [];
    const settled = await Promise.all(jobs);
    for (let i = 0; i < settled.length; i++) {
      if (settled[i]) items.push(settled[i]);
    }
    shareGroupIcons(items);
    applyIconHints(items);
    items.sort((a, b) => String(a.displayName || a.name || '')
      .localeCompare(String(b.displayName || b.name || '')));
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
