'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = {
  'net:ready': [],
  'net:peer': [],
  'net:peer-left': [],
  'net:chat': [],
  'net:typing': [],
  'net:channel': [],
  'net:group-joined': [],
  'net:group-left': [],
  'net:error': [],
  'update:available': [],
  'update:progress': [],
  'update:downloaded': [],
  'update:error': [],
};

for (const channel of Object.keys(listeners)) {
  ipcRenderer.on(channel, (_e, payload) => {
    for (const cb of listeners[channel]) cb(payload);
  });
}

contextBridge.exposeInMainWorld('net', {
  on(event, cb) {
    const channel = `net:${event}`;
    if (listeners[channel]) listeners[channel].push(cb);
  },
  getSelf: () => ipcRenderer.invoke('net:get-self'),
  getPeers: () => ipcRenderer.invoke('net:get-peers'),
  joinGroup: (name, passphrase) => ipcRenderer.invoke('net:join-group', { name, passphrase }),
  leaveGroup: () => ipcRenderer.invoke('net:leave-group'),
  sendChat: (channel, text) => ipcRenderer.invoke('net:send-chat', { channel, text }),
  setUsername: (name) => ipcRenderer.invoke('net:set-username', name),
  connectPeer: (host, port) => ipcRenderer.invoke('net:connect-peer', { host, port }),
  createChannel: (name) => ipcRenderer.invoke('net:create-channel', name),
  sendTyping: (channel) => ipcRenderer.send('net:typing', channel),
});

contextBridge.exposeInMainWorld('updates', {
  on(event, cb) {
    const channel = `update:${event}`;
    if (listeners[channel]) listeners[channel].push(cb);
  },
  install: () => ipcRenderer.invoke('update:install'),
});
