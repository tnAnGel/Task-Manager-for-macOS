// Preload — exposes a minimal, safe IPC surface on window.api.
// contextIsolation is ON; nodeIntegration is OFF. Do not expose ipcRenderer directly.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  listProcesses: () => invoke('processes:list'),
  getSystemStats: () => invoke('system:stats'),
  killProcess: (pid, force = false) => invoke('process:kill', pid, force),
  setPriority: (pid, nice) => invoke('process:priority', pid, nice),
  revealInFinder: (path) => invoke('shell:reveal', path),
  getStartupItems: () => invoke('startup:list'),
  setStartupEnabled: (label, type, enabled) => invoke('startup:setEnabled', label, type, enabled),
  getAppIcon: (path) => invoke('app:icon', path),
  runNewTask: (command) => invoke('task:run', command),
  getUsers: () => invoke('users:list'),
  getServices: () => invoke('services:list'),
  toggleService: (label, on) => invoke('services:toggle', label, on),
  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
  },
});
