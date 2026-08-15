'use strict';

// Headless end-to-end check of the P2P engine: two nodes on real sockets must
// discover each other via multicast and deliver a chat message. Exits non-zero
// on failure. Run: node test-network.js
const { P2PNode } = require('./network');

const a = new P2PNode({ username: 'Alice' });
const b = new P2PNode({ username: 'Bob' });

let discovered = false;
let delivered = false;

const timeout = setTimeout(() => {
  finish(new Error(`timeout — discovered=${discovered} delivered=${delivered}`));
}, 8000);

function finish(err) {
  clearTimeout(timeout);
  a.stop();
  b.stop();
  if (err) { console.error('FAIL:', err.message); process.exit(1); }
  console.log('PASS: discovery + message delivery over real sockets');
  process.exit(0);
}

b.on('chat', (msg) => {
  console.log(`  Bob received on #${msg.channel}: <${msg.username}> ${msg.text}`);
  if (msg.text === 'hello from Alice') {
    delivered = true;
    finish(null);
  }
});

a.on('peer', (peer) => {
  console.log(`  Alice discovered peer: ${peer.username}`);
  if (peer.username === 'Bob') {
    discovered = true;
    // Give the TCP mesh a moment to settle, then send.
    setTimeout(() => a.sendChat('general', 'hello from Alice'), 300);
  }
});

a.start();
b.start();
console.log('Started two nodes; waiting for discovery…');
