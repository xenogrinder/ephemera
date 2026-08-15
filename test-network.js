'use strict';

// Headless end-to-end check of the group model over real sockets:
//  - two nodes that join the same open group discover each other and exchange a message
//  - a node that joins the same group NAME but with a passphrase is NOT connected
//    (its group key differs), proving discovery is scoped by name + passphrase.
// Exits non-zero on failure. Run: node test-network.js
const assert = require('assert');
const { P2PNode } = require('./network');

const alice = new P2PNode({ username: 'Alice' });
const bob = new P2PNode({ username: 'Bob' });
const carol = new P2PNode({ username: 'Carol' });

let bobGotMessage = false;
let aliceSawCarol = false;

bob.on('chat', (msg) => {
  if (msg.text === 'hello group') bobGotMessage = true;
});

alice.on('peer', (peer) => {
  if (peer.username === 'Carol') aliceSawCarol = true;
});

function done(err) {
  alice.stop(); bob.stop(); carol.stop();
  if (err) { console.error('FAIL:', err.message); process.exit(1); }
  console.log('PASS: same-group peers connect + message delivered; wrong passphrase excluded');
  process.exit(0);
}

alice.start(); bob.start(); carol.start();

setTimeout(() => {
  // Alice & Bob join the same OPEN group; Carol joins the same name but locked.
  alice.joinGroup('testroom', '');
  bob.joinGroup('testroom', '');
  carol.joinGroup('testroom', 'secret');
}, 300);

setTimeout(() => {
  alice.sendChat('general', 'hello group');
}, 1800);

setTimeout(() => {
  try {
    const alicefriends = alice.peerList().map((p) => p.username).sort();
    console.log('  Alice sees:', alicefriends);
    console.log('  Carol sees:', carol.peerList().map((p) => p.username));
    assert(alicefriends.includes('Bob'), 'Alice should be connected to Bob');
    assert(bobGotMessage, "Bob should have received Alice's message");
    assert(!aliceSawCarol, 'Alice must NOT see Carol (different passphrase)');
    assert(carol.peerList().length === 0, 'Carol must be isolated (locked group, alone)');
    done(null);
  } catch (e) {
    done(e);
  }
}, 3200);
