'use strict';

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');

// Multicast group used for zero-config LAN discovery. Any client on the same
// network segment that joins this group will find the others automatically.
const MCAST_ADDR = '239.255.42.98';
const MCAST_PORT = 41848;
const ANNOUNCE_INTERVAL_MS = 3000;

// Strip the IPv4-mapped IPv6 prefix that Node sometimes reports for sockets.
function normalizeHost(host) {
  if (!host) return host;
  return host.startsWith('::ffff:') ? host.slice(7) : host;
}

// Deterministic color from an id, so every client renders a peer identically.
function colorFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// The discovery key for a group. Only this hash travels over multicast — never
// the plaintext name or passphrase — so a network sniffer sees opaque hashes,
// and you can only find a group if you know its name (and passphrase, if set).
// Note: this is light obfuscation for a LAN, not strong security. Messages
// themselves are not encrypted.
function groupKeyOf(name, passphrase) {
  const normalized = String(name || '').trim().toLowerCase();
  return crypto
    .createHash('sha256')
    .update('ephemera:v1\x1f' + normalized + '\x1f' + String(passphrase || ''))
    .digest('hex');
}

class P2PNode extends EventEmitter {
  constructor({ username } = {}) {
    super();
    this.id = crypto.randomUUID();
    this.username = username || `User-${this.id.slice(0, 4)}`;
    this.color = colorFromId(this.id);
    this.tcpPort = null;

    // Current group (null until joinGroup). groupName is for local display only.
    this.groupKey = null;
    this.groupName = null;

    // connections: { socket, outgoing, buffer, peerId, peer, remoteHost, listenPort, alive }
    this.connections = [];
    // peers currently reachable over a live TCP connection: id -> { id, username, color }
    this.peers = new Map();

    // Message-id dedup so gossip relays don't loop or double-deliver.
    this.seen = new Set();
    this.seenQueue = [];

    // Addresses we are currently dialing, to avoid duplicate concurrent dials.
    this.dialing = new Set();

    this._server = null;
    this._mcast = null;
    this._announceTimer = null;
  }

  self() {
    return { id: this.id, username: this.username, color: this.color };
  }

  peerList() {
    return Array.from(this.peers.values());
  }

  start() {
    this._server = net.createServer((socket) => this._onIncoming(socket));
    this._server.on('error', (err) => this.emit('error', err));
    this._server.listen(0, () => {
      this.tcpPort = this._server.address().port;
      this._setupMulticast();
      this._announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL_MS);
      this.emit('ready', this.self());
    });
  }

  stop() {
    if (this._announceTimer) clearInterval(this._announceTimer);
    if (this._mcast) { try { this._mcast.close(); } catch (_) {} }
    if (this._server) { try { this._server.close(); } catch (_) {} }
    for (const c of this.connections) { try { c.socket.destroy(); } catch (_) {} }
  }

  // ---- Groups --------------------------------------------------------------

  joinGroup(name, passphrase) {
    this._teardownConnections();
    this.groupName = String(name || '').trim();
    this.groupKey = groupKeyOf(this.groupName, passphrase);
    this._announce(); // start broadcasting our presence in this group
    this.emit('group-joined', { name: this.groupName });
  }

  leaveGroup() {
    this._teardownConnections();
    this.groupKey = null;
    this.groupName = null;
    this.emit('group-left', {});
  }

  // Drop every connection and all group-scoped state, so switching groups never
  // leaks members, messages, or relay state from the previous one.
  _teardownConnections() {
    for (const c of this.connections) { try { c.socket.destroy(); } catch (_) {} }
    this.connections = [];
    this.peers.clear();
    this.dialing.clear();
    this.seen.clear();
    this.seenQueue = [];
  }

  // ---- Discovery (UDP multicast) ------------------------------------------

  _setupMulticast() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this._mcast = sock;
    sock.on('error', (err) => this.emit('error', err));
    sock.on('message', (buf, rinfo) => this._onAnnounce(buf, rinfo));
    sock.bind(MCAST_PORT, () => {
      try {
        sock.addMembership(MCAST_ADDR);
        sock.setMulticastTTL(1); // stay on the local segment
        sock.setMulticastLoopback(true);
      } catch (err) {
        this.emit('error', err);
      }
    });
  }

  _announce() {
    if (!this._mcast || this.tcpPort == null || !this.groupKey) return;
    const msg = Buffer.from(JSON.stringify({
      t: 'announce',
      id: this.id,
      key: this.groupKey,
      port: this.tcpPort,
    }));
    try {
      this._mcast.send(msg, 0, msg.length, MCAST_PORT, MCAST_ADDR);
    } catch (_) { /* transient network error, next tick retries */ }
  }

  _onAnnounce(buf, rinfo) {
    if (!this.groupKey) return;
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
    if (msg.t !== 'announce' || msg.id === this.id) return;
    if (msg.key !== this.groupKey) return; // different group — ignore
    if (this.peers.has(msg.id)) return;    // already connected
    this._dial(normalizeHost(rinfo.address), msg.port);
  }

  // ---- Manual connect (cross-network) --------------------------------------

  connectTo(host, port) {
    if (!this.groupKey) return; // only meaningful while in a group
    this._dial(normalizeHost(host), Number(port));
  }

  _isSelfAddress(host, port) {
    if (port !== this.tcpPort) return false;
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name]) {
        if (ni.address === host) return true;
      }
    }
    return host === '127.0.0.1' || host === 'localhost';
  }

  _dial(host, port) {
    if (!host || !port) return;
    if (this._isSelfAddress(host, port)) return;
    const key = `${host}:${port}`;
    if (this.dialing.has(key)) return;
    // Skip if we already hold a live connection to this listen address.
    for (const c of this.connections) {
      if (c.alive && c.remoteHost === host && c.listenPort === port) return;
    }
    this.dialing.add(key);
    const socket = net.connect(port, host, () => {
      this.dialing.delete(key);
      const conn = this._register(socket, true);
      conn.remoteHost = host;
      conn.listenPort = port;
      this._sendHello(conn);
    });
    socket.on('error', () => { this.dialing.delete(key); });
  }

  // ---- TCP connections -----------------------------------------------------

  _onIncoming(socket) {
    const conn = this._register(socket, false);
    conn.remoteHost = normalizeHost(socket.remoteAddress);
    this._sendHello(conn);
  }

  _register(socket, outgoing) {
    const conn = { socket, outgoing, buffer: '', peerId: null, peer: null, remoteHost: null, listenPort: null, alive: true };
    this.connections.push(conn);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(conn, chunk));
    socket.on('close', () => this._onClose(conn));
    socket.on('error', () => { /* handled by close */ });
    return conn;
  }

  _onData(conn, chunk) {
    conn.buffer += chunk;
    let idx;
    while ((idx = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, idx);
      conn.buffer = conn.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      this._handle(conn, msg);
    }
  }

  _onClose(conn) {
    conn.alive = false;
    this.connections = this.connections.filter((c) => c !== conn);
    if (conn.peerId && !this.connections.some((c) => c.alive && c.peerId === conn.peerId)) {
      const peer = this.peers.get(conn.peerId);
      this.peers.delete(conn.peerId);
      if (peer) this.emit('peer-left', peer);
    }
  }

  _send(conn, obj) {
    if (!conn.alive) return;
    try { conn.socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  _broadcast(obj, exceptConn) {
    for (const c of this.connections) {
      if (c.alive && c !== exceptConn) this._send(c, obj);
    }
  }

  _sendHello(conn) {
    this._send(conn, {
      t: 'hello',
      id: this.id,
      key: this.groupKey,
      username: this.username,
      color: this.color,
      port: this.tcpPort,
    });
  }

  _handle(conn, msg) {
    switch (msg.t) {
      case 'hello': return this._onHello(conn, msg);
      case 'chat': return this._onChat(conn, msg);
      case 'typing': return this._onTyping(conn, msg);
      case 'channel': return this._onChannel(conn, msg);
      case 'gossip': return this._onGossip(conn, msg);
    }
  }

  _onHello(conn, msg) {
    // Only peers in the same group may join our mesh.
    if (!this.groupKey || msg.key !== this.groupKey) {
      try { conn.socket.destroy(); } catch (_) {}
      return;
    }
    conn.peerId = msg.id;
    conn.listenPort = msg.port || conn.listenPort;
    conn.peer = { id: msg.id, username: msg.username, color: msg.color };

    const isNew = !this.peers.has(msg.id);
    this.peers.set(msg.id, conn.peer);
    this._resolveDuplicates(msg.id);
    // Emit as an upsert so username/color changes propagate to the roster.
    this.emit('peer', conn.peer);
    if (isNew) {
      // Share who we know so partial meshes (manual connects) fill in.
      this._sendGossip(conn);
    }
  }

  // Keep exactly one connection per peer. Both sides agree on which to keep:
  // the connection dialed by whichever id sorts smaller.
  _resolveDuplicates(peerId) {
    const conns = this.connections.filter((c) => c.alive && c.peerId === peerId);
    if (conns.length < 2) return;
    const keepOutgoing = this.id < peerId;
    for (const c of conns) {
      const isKeeper = keepOutgoing ? c.outgoing : !c.outgoing;
      if (!isKeeper) { try { c.socket.destroy(); } catch (_) {} }
    }
  }

  _sendGossip(conn) {
    const peers = [];
    for (const c of this.connections) {
      if (c.alive && c.peerId && c.remoteHost && c.listenPort && c !== conn) {
        peers.push({ host: c.remoteHost, port: c.listenPort });
      }
    }
    if (peers.length) this._send(conn, { t: 'gossip', peers });
  }

  _onGossip(conn, msg) {
    if (!Array.isArray(msg.peers)) return;
    for (const p of msg.peers) {
      if (p && p.host && p.port) this._dial(normalizeHost(p.host), Number(p.port));
    }
  }

  _markSeen(msgId) {
    if (this.seen.has(msgId)) return false;
    this.seen.add(msgId);
    this.seenQueue.push(msgId);
    if (this.seenQueue.length > 1000) {
      this.seen.delete(this.seenQueue.shift());
    }
    return true;
  }

  _onChat(conn, msg) {
    if (!msg.msgId || !this._markSeen(msg.msgId)) return;
    this.emit('chat', {
      id: msg.id,
      username: msg.username,
      color: msg.color,
      channel: msg.channel,
      text: msg.text,
      ts: msg.ts,
    });
    this._broadcast(msg, conn); // relay for partial meshes
  }

  _onTyping(conn, msg) {
    this.emit('typing', { id: msg.id, username: msg.username, channel: msg.channel });
  }

  _onChannel(conn, msg) {
    if (!msg.name || !msg.msgId || !this._markSeen(msg.msgId)) return;
    this.emit('channel', { name: msg.name });
    this._broadcast(msg, conn);
  }

  // ---- Outbound API --------------------------------------------------------

  sendChat(channel, text) {
    const msg = {
      t: 'chat',
      msgId: crypto.randomUUID(),
      id: this.id,
      username: this.username,
      color: this.color,
      channel,
      text,
      ts: Date.now(),
    };
    this._markSeen(msg.msgId); // ignore our own echo if it loops back
    this._broadcast(msg);
    return { channel, text, ts: msg.ts };
  }

  sendTyping(channel) {
    this._broadcast({ t: 'typing', id: this.id, username: this.username, channel });
  }

  createChannel(name) {
    this._broadcast({ t: 'channel', name, msgId: crypto.randomUUID() });
  }

  setUsername(name) {
    this.username = name;
    for (const c of this.connections) this._sendHello(c);
  }
}

module.exports = { P2PNode };
