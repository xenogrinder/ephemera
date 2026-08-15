'use strict';

// ---- State ----------------------------------------------------------------

let self = null;
const channels = ['general'];
let currentChannel = 'general';
const messages = new Map();        // channel -> [ {kind, id, username, color, text, ts} ]
const members = new Map();         // id -> { id, username, color }
const typing = new Map();          // id -> { username, timer }

messages.set('general', []);

const GROUP_WINDOW_MS = 5 * 60 * 1000;

// ---- Element refs ---------------------------------------------------------

const el = {
  channelList: document.getElementById('channel-list'),
  currentChannel: document.getElementById('current-channel'),
  messages: document.getElementById('messages'),
  typing: document.getElementById('typing'),
  input: document.getElementById('composer-input'),
  memberList: document.getElementById('member-list'),
  memberCount: document.getElementById('member-count'),
  selfName: document.getElementById('self-name'),
  selfAvatar: document.getElementById('self-avatar'),
  addChannel: document.getElementById('add-channel'),
  addPeer: document.getElementById('add-peer'),
  editName: document.getElementById('edit-name'),
};

// ---- Helpers --------------------------------------------------------------

function initials(name) {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function fmtTime(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

function makeAvatar(color, name, cls) {
  const a = document.createElement('div');
  a.className = 'avatar' + (cls ? ' ' + cls : '');
  a.style.background = color;
  a.textContent = initials(name);
  return a;
}

function atBottom() {
  const m = el.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

// ---- Channels -------------------------------------------------------------

function addChannel(name, { switchTo = false } = {}) {
  name = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!name) return;
  if (!channels.includes(name)) {
    channels.push(name);
    channels.sort();
    messages.set(name, []);
    renderChannels();
  }
  if (switchTo) selectChannel(name);
}

function renderChannels() {
  el.channelList.innerHTML = '';
  for (const name of channels) {
    const li = document.createElement('li');
    li.className = 'channel' + (name === currentChannel ? ' active' : '');
    const hash = document.createElement('span');
    hash.className = 'hash';
    hash.textContent = '#';
    const label = document.createElement('span');
    label.textContent = name;
    li.append(hash, label);
    li.addEventListener('click', () => selectChannel(name));
    el.channelList.appendChild(li);
  }
}

function selectChannel(name) {
  currentChannel = name;
  el.currentChannel.textContent = name;
  el.input.placeholder = `Message #${name}`;
  renderChannels();
  renderMessages();
  renderTyping();
}

// ---- Messages -------------------------------------------------------------

function pushMessage(channel, entry) {
  if (!messages.has(channel)) {
    // A message arrived for a channel we don't know yet — create it.
    addChannel(channel);
  }
  messages.get(channel).push(entry);
  if (channel === currentChannel) {
    const stick = atBottom();
    renderMessages();
    if (stick) scrollToBottom();
  }
}

function addSystem(text) {
  const entry = { kind: 'system', text, ts: Date.now() };
  for (const ch of channels) {
    messages.get(ch).push(entry);
  }
  if (messages.get(currentChannel)) {
    const stick = atBottom();
    renderMessages();
    if (stick) scrollToBottom();
  }
}

function renderMessages() {
  const list = messages.get(currentChannel) || [];
  el.messages.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const h = document.createElement('h2');
    h.textContent = `Welcome to #${currentChannel}`;
    const p = document.createElement('div');
    p.textContent = 'This is the start of the channel. Say hi to anyone on your network.';
    empty.append(h, p);
    el.messages.appendChild(empty);
    return;
  }

  let prev = null;
  for (const entry of list) {
    if (entry.kind === 'system') {
      const row = document.createElement('div');
      row.className = 'msg system';
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = entry.text;
      row.appendChild(body);
      el.messages.appendChild(row);
      prev = null;
      continue;
    }

    const grouped = prev && prev.kind === 'chat' && prev.id === entry.id &&
      (entry.ts - prev.ts) < GROUP_WINDOW_MS;

    const row = document.createElement('div');
    row.className = 'msg' + (grouped ? ' grouped' : '');
    row.appendChild(makeAvatar(entry.color, entry.username));

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'msg-body';

    if (!grouped) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const author = document.createElement('span');
      author.className = 'msg-author';
      author.style.color = entry.color;
      author.textContent = entry.username;
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = fmtTime(entry.ts);
      head.append(author, time);
      bodyWrap.appendChild(head);
    }

    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = entry.text;
    bodyWrap.appendChild(text);

    row.appendChild(bodyWrap);
    el.messages.appendChild(row);
    prev = entry;
  }
}

// ---- Members --------------------------------------------------------------

function renderMembers() {
  el.memberList.innerHTML = '';
  const all = [];
  if (self) all.push({ ...self, isSelf: true });
  for (const m of members.values()) all.push(m);
  all.sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.username.localeCompare(b.username)));

  el.memberCount.textContent = String(all.length);
  for (const m of all) {
    const li = document.createElement('li');
    li.className = 'member' + (m.isSelf ? ' self' : '');
    const avatar = makeAvatar(m.color, m.username);
    const dot = document.createElement('span');
    dot.className = 'presence-dot';
    avatar.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.username + (m.isSelf ? ' (you)' : '');
    li.append(avatar, name);
    el.memberList.appendChild(li);
  }
}

// ---- Typing indicator -----------------------------------------------------

function renderTyping() {
  const names = [];
  for (const t of typing.values()) {
    if (t.channel === currentChannel) names.push(t.username);
  }
  if (names.length === 0) { el.typing.textContent = ''; return; }
  const strong = names.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(', ');
  const verb = names.length === 1 ? 'is typing…' : 'are typing…';
  el.typing.innerHTML = `${strong} ${verb}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---- Modal ----------------------------------------------------------------

function openModal({ title, desc, fields, okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    const descEl = document.getElementById('modal-desc');
    descEl.textContent = desc || '';
    descEl.style.display = desc ? 'block' : 'none';

    const fieldsEl = document.getElementById('modal-fields');
    fieldsEl.innerHTML = '';
    const inputs = {};
    for (const f of fields) {
      const label = document.createElement('label');
      label.textContent = f.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = f.value || '';
      input.placeholder = f.placeholder || '';
      fieldsEl.append(label, input);
      inputs[f.name] = input;
    }
    document.getElementById('modal-ok').textContent = okLabel;
    overlay.classList.remove('hidden');
    const first = Object.values(inputs)[0];
    if (first) { first.focus(); first.select(); }

    function cleanup(result) {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onOk() {
      const result = {};
      for (const k of Object.keys(inputs)) result[k] = inputs[k].value.trim();
      cleanup(result);
    }
    function onCancel() { cleanup(null); }
    function onKey(e) {
      if (e.key === 'Enter') onOk();
      else if (e.key === 'Escape') onCancel();
    }
    const okBtn = document.getElementById('modal-ok');
    const cancelBtn = document.getElementById('modal-cancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKey, true);
  });
}

// ---- Composer + input events ----------------------------------------------

let lastTypingSent = 0;

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    window.net.sendChat(currentChannel, text);
    pushMessage(currentChannel, {
      kind: 'chat', id: self.id, username: self.username, color: self.color,
      text, ts: Date.now(),
    });
    scrollToBottom();
  }
});

el.input.addEventListener('input', () => {
  const now = Date.now();
  if (el.input.value && now - lastTypingSent > 1500) {
    lastTypingSent = now;
    window.net.sendTyping(currentChannel);
  }
});

el.addChannel.addEventListener('click', async () => {
  const res = await openModal({
    title: 'Create Channel',
    desc: 'New text channels are shared with everyone currently connected.',
    fields: [{ name: 'name', label: 'Channel name', placeholder: 'new-channel' }],
    okLabel: 'Create',
  });
  if (res && res.name) {
    addChannel(res.name, { switchTo: true });
    window.net.createChannel(res.name.toLowerCase());
  }
});

el.addPeer.addEventListener('click', async () => {
  const res = await openModal({
    title: 'Connect to a Peer',
    desc: 'Peers on the same LAN are found automatically. Use this to reach someone on another network by IP address and port.',
    fields: [
      { name: 'host', label: 'IP address / host', placeholder: '192.168.1.50' },
      { name: 'port', label: 'Port', placeholder: 'e.g. 51234' },
    ],
    okLabel: 'Connect',
  });
  if (res && res.host && res.port) {
    window.net.connectPeer(res.host, res.port);
    addSystem(`Attempting to connect to ${res.host}:${res.port}…`);
  }
});

el.editName.addEventListener('click', async () => {
  const res = await openModal({
    title: 'Change Display Name',
    desc: 'This name is how others on the network see you. It resets when you close the app.',
    fields: [{ name: 'name', label: 'Display name', value: self.username }],
    okLabel: 'Save',
  });
  if (res && res.name && res.name !== self.username) {
    self.username = res.name;
    window.net.setUsername(res.name);
    renderSelf();
    renderMembers();
  }
});

// ---- Self -----------------------------------------------------------------

function renderSelf() {
  el.selfName.textContent = self.username;
  el.selfAvatar.style.background = self.color;
  el.selfAvatar.textContent = initials(self.username);
}

// ---- Network events -------------------------------------------------------

window.net.on('ready', (s) => {
  self = s;
  renderSelf();
  renderMembers();
});

window.net.on('peer', (peer) => {
  const known = members.has(peer.id);
  members.set(peer.id, peer);
  if (!known) addSystem(`${peer.username} joined the network.`);
  renderMembers();
});

window.net.on('peer-left', (peer) => {
  if (members.delete(peer.id)) {
    addSystem(`${peer.username} left the network.`);
    renderMembers();
  }
  const t = typing.get(peer.id);
  if (t) { clearTimeout(t.timer); typing.delete(peer.id); renderTyping(); }
});

window.net.on('chat', (msg) => {
  pushMessage(msg.channel, {
    kind: 'chat', id: msg.id, username: msg.username, color: msg.color,
    text: msg.text, ts: msg.ts,
  });
  const t = typing.get(msg.id);
  if (t) { clearTimeout(t.timer); typing.delete(msg.id); renderTyping(); }
});

window.net.on('typing', (t) => {
  const existing = typing.get(t.id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => { typing.delete(t.id); renderTyping(); }, 4000);
  typing.set(t.id, { username: t.username, channel: t.channel, timer });
  renderTyping();
});

window.net.on('channel', (c) => addChannel(c.name));

window.net.on('error', (message) => {
  // Non-fatal network errors surface quietly in the console.
  console.warn('[net]', message);
});

// ---- Auto-update banner ---------------------------------------------------

const updateBanner = document.getElementById('update-banner');
const updateText = document.getElementById('update-text');
const updateInstall = document.getElementById('update-install');
const updateDismiss = document.getElementById('update-dismiss');

function showUpdate(text, ready) {
  updateText.textContent = text;
  updateInstall.classList.toggle('hidden', !ready);
  updateBanner.classList.remove('hidden');
}

updateInstall.addEventListener('click', () => window.updates.install());
updateDismiss.addEventListener('click', () => updateBanner.classList.add('hidden'));

window.updates.on('available', (info) => {
  const v = info && info.version ? ` v${info.version}` : '';
  showUpdate(`Downloading update${v}…`, false);
});
window.updates.on('progress', (p) => {
  showUpdate(`Downloading update… ${p.percent}%`, false);
});
window.updates.on('downloaded', (info) => {
  const v = info && info.version ? ` v${info.version}` : '';
  showUpdate(`Update${v} ready.`, true);
});
window.updates.on('error', (message) => console.warn('[update]', message));

// ---- Boot -----------------------------------------------------------------

async function boot() {
  renderChannels();
  selectChannel('general');
  const s = await window.net.getSelf();
  if (s) { self = s; renderSelf(); }
  const peers = await window.net.getPeers();
  for (const p of peers) members.set(p.id, p);
  renderMembers();
}

boot();
