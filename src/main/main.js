// App lifecycle: create the window, load the UI, register IPC handlers.

'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, nativeImage } = require('electron');

app.setName('Task Manager');

const IS_DEV = process.argv.includes('--dev');

// Application menu — gives the app its name in the menu bar and standard
// shortcuts (Quit, Close, and clipboard/select-all so the search box works).
function buildMenu() {
  const template = [
    {
      label: 'Task Manager',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(IS_DEV ? [{ role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** @type {BrowserWindow|null} */
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#202020', // matches --bg-app to avoid white flash
    show: false,
    // Native macOS chrome: keep the traffic-light buttons (close/min/zoom) but
    // hide the rest of the title bar so our search/title can sit in that strip.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 13, y: 13 },
    title: 'Task Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Show only once the renderer is painted (prevents flash of unstyled/blank content).
  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    if (win === mainWindow) mainWindow = null;
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((err) => {
    console.error('[main] Failed to load renderer:', err);
  });

  if (IS_DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

// Register IPC handlers. Wrapped in try/catch so a broken ipc module doesn't
// take the whole window down with it.
function registerIpc(win) {
  try {
    const ipc = require('./ipc');
    if (ipc && typeof ipc.register === 'function') {
      ipc.register(win);
    } else {
      console.error('[main] ./ipc does not export a register() function.');
    }
  } catch (err) {
    console.error('[main] Failed to register IPC handlers:', err);
  }
}

app.whenReady().then(() => {
  // Dock icon for dev runs (packaged builds get it from electron-builder).
  if (process.platform === 'darwin' && app.dock) {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch (_) { /* non-fatal */ }
  }

  buildMenu();
  mainWindow = createWindow();
  registerIpc(mainWindow);

  app.on('activate', () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      registerIpc(mainWindow);
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}).catch((err) => {
  console.error('[main] App failed to initialize:', err);
});

// Utility app: quit when all windows are closed, even on macOS.
app.on('window-all-closed', () => {
  app.quit();
});
