// src/main/metrics/system.js
// Gathers cpu/mem/disk/net/gpu/os stats and maps them to the SystemStats wire
// shape. Every metric is fetched in parallel and is
// individually fault-tolerant: a failing probe yields null/sensible defaults.
//
// macOS notes: systeminformation doesn't report per-second disk/net rates here
// (rx_sec/wx_sec/tx_sec come back null), so we derive them from the cumulative
// byte counters across polls. Memory comes from vm_stat (see getMacMemory) and
// GPU utilization from ioreg (see getGpuUtil) since si misses both on Apple Silicon.

'use strict';

const si = require('systeminformation');
const os = require('os');
const { execFile } = require('child_process');

const MB = 1024 * 1024;

// Run a command and resolve its stdout, or null if it fails.
function execText(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000 }, (err, stdout) => {
        resolve(err ? null : String(stdout || ''));
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// Accurate macOS memory via vm_stat + sysctl, mirroring Activity Monitor's model
// (Memory Used = App + Wired + Compressed). systeminformation gets this wrong on
// macOS because it ignores compressed memory and swap. Returns null off-darwin
// or on parse failure so the caller can fall back to si.mem().
async function getMacMemory() {
  if (process.platform !== 'darwin') return null;
  try {
    const [vmText, swapText] = await Promise.all([
      execText('/usr/bin/vm_stat', []),
      execText('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
    ]);
    if (!vmText) return null;

    let pageSize = 4096;
    const ps = vmText.match(/page size of (\d+) bytes/);
    if (ps) pageSize = parseInt(ps[1], 10);

    const pages = (label) => {
      const m = vmText.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s+(\\d+)\\.'));
      return m ? parseInt(m[1], 10) : 0;
    };

    const free = pages('Pages free');
    const speculative = pages('Pages speculative');
    const wired = pages('Pages wired down');
    const purgeable = pages('Pages purgeable');
    const fileBacked = pages('File-backed pages');
    const anonymous = pages('Anonymous pages');
    const compressor = pages('Pages occupied by compressor');

    const totalBytes = os.totalmem();
    const appBytes = Math.max(0, anonymous - purgeable) * pageSize;
    const wiredBytes = wired * pageSize;
    const compressedBytes = compressor * pageSize;
    const cachedBytes = (fileBacked + purgeable) * pageSize;
    const usedBytes = appBytes + wiredBytes + compressedBytes;
    const availableBytes = Math.max(0, totalBytes - usedBytes);
    const freeBytes = (free + speculative) * pageSize;
    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

    let swapUsedBytes = 0;
    let swapTotalBytes = 0;
    if (swapText) {
      const tm = swapText.match(/total\s*=\s*([\d.]+)M/);
      const um = swapText.match(/used\s*=\s*([\d.]+)M/);
      if (tm) swapTotalBytes = parseFloat(tm[1]) * MB;
      if (um) swapUsedBytes = parseFloat(um[1]) * MB;
    }

    return {
      totalBytes,
      usedBytes,
      availableBytes,
      freeBytes,
      cachedBytes,
      appBytes,
      wiredBytes,
      compressedBytes,
      swapUsedBytes,
      swapTotalBytes,
      percent,
    };
  } catch (_) {
    return null;
  }
}

function num(v, fallback = null) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function settled(result) {
  return result && result.status === 'fulfilled' ? result.value : null;
}

// Per-second rate from two cumulative samples; clamps negatives (counter resets).
function rate(cur, prev, dtSec) {
  if (prev == null || cur == null || !(dtSec > 0)) return 0;
  const r = (cur - prev) / dtSec;
  return r > 0 ? r : 0;
}

// Apple Silicon GPU utilization + in-use memory via ioreg (no sudo needed).
// IOAccelerator's PerformanceStatistics exposes "Device Utilization %".
async function getGpuUtil() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = await execText('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']);
    if (!out) return null;
    let util = null;
    const re = /"Device Utilization %"\s*=\s*(\d+)/g;
    let m, max = -1;
    while ((m = re.exec(out))) max = Math.max(max, parseInt(m[1], 10));
    if (max >= 0) util = max;
    let memUsed = null;
    const mm = out.match(/"In use system memory"\s*=\s*(\d+)/);
    if (mm) memUsed = parseInt(mm[1], 10);
    return { utilization: util, memUsedBytes: memUsed };
  } catch (_) {
    return null;
  }
}

// State carried between polls so we can compute throughput deltas ourselves.
let _prev = null; // { t, diskRead, diskWrite, netRx, netTx }

// Total thread count (system-wide). `top` is the cheap source but ~0.5s, so we
// refresh it at most every 5s in the background and serve the cached value.
let _threadCount = null;
let _threadStamp = 0;
let _threadBusy = false;
function maybeRefreshThreads() {
  const now = Date.now();
  if (_threadBusy || (now - _threadStamp) < 5000) return;
  _threadBusy = true;
  _threadStamp = now;
  execText('/usr/bin/top', ['-l', '1', '-n', '0'])
    .then((out) => {
      _threadBusy = false;
      if (!out) return;
      const m = out.match(/(\d+)\s+threads/i);
      if (m) _threadCount = parseInt(m[1], 10);
    })
    .catch(() => { _threadBusy = false; });
}

async function stats() {
  const results = await Promise.allSettled([
    si.currentLoad(),
    si.cpu(),
    si.cpuCurrentSpeed(),
    si.mem(),
    si.fsStats(),
    si.networkStats('*'),
    si.graphics(),
    si.osInfo(),
    si.time(),
    si.processes(),
    si.fsSize(),
    si.networkInterfaces(),
    si.networkInterfaceDefault(),
    getMacMemory(),
    getGpuUtil(),
  ]);

  const currentLoad = settled(results[0]) || {};
  const cpuInfo = settled(results[1]) || {};
  const cpuSpeed = settled(results[2]) || {};
  const mem = settled(results[3]) || {};
  const fsStats = settled(results[4]) || {};
  const networkStats = settled(results[5]) || [];
  const graphics = settled(results[6]) || {};
  const time = settled(results[8]) || {};
  const processes = settled(results[9]) || {};
  const fsSize = settled(results[10]) || [];
  const netIfaces = settled(results[11]) || [];
  const defaultIface = settled(results[12]) || '';
  const macMem = settled(results[13]);
  const gpuUtil = settled(results[14]);

  maybeRefreshThreads();

  // ---- Derive disk/net per-second rates from cumulative counters ----
  const now = Date.now();
  const dt = _prev ? (now - _prev.t) / 1000 : 0;

  const diskReadCum = num(fsStats.rx);   // cumulative bytes read
  const diskWriteCum = num(fsStats.wx);  // cumulative bytes written

  let netRxCum = 0;
  let netTxCum = 0;
  const ifaceArr = Array.isArray(networkStats) ? networkStats : [networkStats];
  for (const n of ifaceArr) {
    if (!n || n.iface === 'lo0' || /^lo/.test(n.iface || '')) continue;
    netRxCum += num(n.rx_bytes, 0);
    netTxCum += num(n.tx_bytes, 0);
  }

  const diskRead = rate(diskReadCum, _prev && _prev.diskRead, dt);
  const diskWrite = rate(diskWriteCum, _prev && _prev.diskWrite, dt);
  const netRx = rate(netRxCum, _prev && _prev.netRx, dt);
  const netTx = rate(netTxCum, _prev && _prev.netTx, dt);

  _prev = { t: now, diskRead: diskReadCum, diskWrite: diskWriteCum, netRx: netRxCum, netTx: netTxCum };

  return {
    cpu: buildCpu(currentLoad, cpuInfo, cpuSpeed, time),
    // Prefer the accurate vm_stat-based memory on macOS; fall back to si.mem().
    mem: macMem || buildMem(mem),
    disks: buildDisks(diskRead, diskWrite, fsSize),
    net: buildNet(netRx, netTx, netIfaces, defaultIface),
    gpu: buildGpu(graphics, gpuUtil),
    process: buildProcess(processes),
  };
}

function buildCpu(currentLoad, cpuInfo, cpuSpeed, time) {
  try {
    const base = num(cpuInfo.speed);
    const cpus = Array.isArray(currentLoad.cpus) ? currentLoad.cpus : [];
    const perCore = cpus.map((c) => num(c && c.load, 0));
    let loadAvg = null;
    try { loadAvg = os.loadavg(); } catch (_) { loadAvg = null; }

    return {
      brand: typeof cpuInfo.brand === 'string' ? cpuInfo.brand : '',
      physicalCores: num(cpuInfo.physicalCores),
      logicalCores: num(cpuInfo.cores, perCore.length || null),
      perfCores: num(cpuInfo.performanceCores),
      effCores: num(cpuInfo.efficiencyCores),
      speedGHz: base,
      currentGHz: num(cpuSpeed.avg, base),
      load: num(currentLoad.currentLoad, 0),
      loadUser: num(currentLoad.currentLoadUser),
      loadSystem: num(currentLoad.currentLoadSystem),
      loadAvg: Array.isArray(loadAvg) ? loadAvg.map((x) => num(x, 0)) : null,
      perCore,
      uptimeSec: num(time.uptime, 0),
    };
  } catch (_e) {
    return {
      brand: '', physicalCores: null, logicalCores: null, perfCores: null,
      effCores: null, speedGHz: null, currentGHz: null, load: 0,
      loadUser: null, loadSystem: null, loadAvg: null, perCore: [], uptimeSec: 0,
    };
  }
}

function buildMem(mem) {
  try {
    const totalBytes = num(mem.total, 0);
    const available = num(mem.available);
    const freeBytes = num(mem.free, 0);
    // macOS: real file cache is `buffcache`; `cached` is usually 0.
    const cachedBytes = num(mem.buffcache, num(mem.cached, 0));

    let usedBytes;
    if (available != null && totalBytes) {
      usedBytes = totalBytes - available; // matches Activity Monitor "Memory Used"
    } else {
      usedBytes = num(mem.used, 0);
    }
    if (usedBytes < 0) usedBytes = 0;

    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

    return {
      totalBytes,
      usedBytes,
      freeBytes,
      cachedBytes,
      swapUsedBytes: num(mem.swapused, 0),
      swapTotalBytes: num(mem.swaptotal, 0),
      percent,
    };
  } catch (_e) {
    return {
      totalBytes: 0, usedBytes: 0, freeBytes: 0, cachedBytes: 0,
      swapUsedBytes: 0, swapTotalBytes: 0, percent: 0,
    };
  }
}

function buildDisks(readBytesSec, writeBytesSec, fsSize) {
  try {
    // Capacity from the boot/root volume (mount '/').
    const arr = Array.isArray(fsSize) ? fsSize : [];
    let root = arr.find((f) => f && f.mount === '/') || arr[0] || {};
    const sizeBytes = num(root.size);
    const usedBytes = num(root.used);
    const usePercent = num(root.use);

    return [
      {
        name: 'Disk 0',
        readBytesSec: num(readBytesSec, 0),
        writeBytesSec: num(writeBytesSec, 0),
        // "active time" isn't available on macOS; approximate activity for the
        // graph by whether there is any IO (kept null for the stat label).
        percent: null,
        sizeBytes,
        diskUsedBytes: usedBytes,
        usePercent,
        mount: typeof root.mount === 'string' ? root.mount : '/',
        fsType: typeof root.type === 'string' ? root.type : '',
      },
    ];
  } catch (_e) {
    return [{ name: 'Disk 0', readBytesSec: 0, writeBytesSec: 0, percent: null }];
  }
}

function buildNet(rxBytesSec, txBytesSec, netIfaces, defaultIface) {
  try {
    const ifaces = Array.isArray(netIfaces) ? netIfaces : [netIfaces];
    let primary = ifaces.find((i) => i && i.iface === defaultIface);
    if (!primary) {
      primary = ifaces.find((i) => i && i.ip4 && !i.internal && i.operstate === 'up');
    }
    if (!primary) primary = ifaces.find((i) => i && i.ip4 && !i.internal);
    const iface = (primary && primary.iface) || defaultIface || 'Network';
    const ip4 = (primary && primary.ip4) || '';

    return [
      {
        iface,
        ip4,
        rxBytesSec: num(rxBytesSec, 0),
        txBytesSec: num(txBytesSec, 0),
      },
    ];
  } catch (_e) {
    return [{ iface: 'Network', ip4: '', rxBytesSec: num(rxBytesSec, 0), txBytesSec: num(txBytesSec, 0) }];
  }
}

function buildGpu(graphics, gpuUtil) {
  try {
    const controllers = Array.isArray(graphics.controllers) ? graphics.controllers : [];
    const c = controllers[0] || {};
    const memUsed = num(c.memoryUsed);
    const memTotal = num(c.memoryTotal);
    const vram = num(c.vram);
    // si reports GPU core count as a string for Apple Silicon ("40").
    let cores = num(c.cores);
    if (cores == null && c.cores != null) cores = num(parseInt(c.cores, 10));

    // Prefer the real ioreg utilization (Apple Silicon) over si's (usually null).
    const util = (gpuUtil && gpuUtil.utilization != null)
      ? gpuUtil.utilization
      : num(c.utilizationGpu);
    const usedBytes = memUsed != null ? memUsed * MB
      : (gpuUtil && gpuUtil.memUsedBytes != null ? gpuUtil.memUsedBytes : null);

    return {
      model: typeof c.model === 'string' ? c.model : '',
      cores,
      utilization: util,
      memUsedBytes: usedBytes,
      memTotalBytes: memTotal != null ? memTotal * MB : vram != null ? vram * MB : null,
      tempC: num(c.temperatureGpu),
    };
  } catch (_e) {
    return { model: '', cores: null, utilization: null, memUsedBytes: null, memTotalBytes: null, tempC: null };
  }
}

function buildProcess(processes) {
  try {
    return { total: num(processes.all), threads: _threadCount, handles: null };
  } catch (_e) {
    return { total: null, threads: _threadCount, handles: null };
  }
}

module.exports = { stats };
