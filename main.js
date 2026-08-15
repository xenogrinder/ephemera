'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { P2PNode } = require('./network');
const { autoUpdater } = require('electron-updater');

let win = null;
let node = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#313338',
    title: 'Ephemera',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startNode() {
  node = new P2PNode();
  node.on('ready', (self) => send('net:ready', self));
  node.on('peer', (peer) => send('net:peer', peer));
  node.on('peer-left', (peer) => send('net:peer-left', peer));
  node.on('chat', (msg) => send('net:chat', msg));
  node.on('typing', (t) => send('net:typing', t));
  node.on('channel', (c) => send('net:channel', c));
  node.on('error', (err) => send('net:error', String(err && err.message || err)));
  node.start();
}

// ---- Auto-update --------------------------------------------------------

function setupAutoUpdate() {
  // Only meaningful in a packaged build with a real install + update feed.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;          // fetch the update in the background
  autoUpdater.autoInstallOnAppQuit = true;  // apply it silently on next quit

  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version }));
  autoUpdater.on('download-progress', (p) => send('update:progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update:downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => send('update:error', String(err && err.message || err)));

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline / no release yet */ });
  check();
  // Re-check periodically for long-running sessions.
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---- IPC: renderer -> main ----------------------------------------------

ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
ipcMain.handle('net:get-self', () => (node ? node.self() : null));
ipcMain.handle('net:get-peers', () => (node ? node.peerList() : []));
ipcMain.handle('net:send-chat', (_e, { channel, text }) => node && node.sendChat(channel, text));
ipcMain.handle('net:set-username', (_e, name) => node && node.setUsername(name));
ipcMain.handle('net:connect-peer', (_e, { host, port }) => node && node.connectTo(host, port));
ipcMain.handle('net:create-channel', (_e, name) => node && node.createChannel(name));
ipcMain.on('net:typing', (_e, channel) => node && node.sendTyping(channel));

app.whenReady().then(() => {
  startNode();
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (node) node.stop();
  app.quit();
});
