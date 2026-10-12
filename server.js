'use strict';
/**
 * Ludo Hub: zero-install LAN server. Only Node.js built-ins are used (no npm install).
 * Serves index.html and runs rooms over a small WebSocket implementation.
 * The server owns the dice and all rules (engine/); clients only send roll/move requests.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const E = require('./engine');

const PORT = Number(process.env.PORT) || 3000;
const TURN_MS = Number(process.env.TURN_MS) || 40000;
const LOBBY_GRACE_MS = Number(process.env.LOBBY_GRACE_MS) || 30000;
const GAME_GRACE_MS = Number(process.env.GAME_GRACE_MS) || 60000;
const RATE = Number(process.env.RATE_PER_SEC) || 10; // messages per second per connection
const MAX_ROOMS = 500, MAX_CONN_PER_IP = 30, MAX_PAYLOAD = 8192;
const COLOR_ORDER = [3, 1, 0, 2]; // blue, green, red, yellow: 2 players are always diagonal
const EXTRA_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean)); // e.g. https://localhost,capacitor://localhost for the mobile app
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const DATA_DIR = process.env.LUDO_DATA || path.join(__dirname, 'data');
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const REACTS = new Set(['😂', '😡', '👍', '🎉', '😭', '🔥', '👏', '😎']);
const envInt = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const FEES = (process.env.COIN_ENTRY_FEES || '0,50,100,500,1000').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 100000);
const START_COINS = envInt('START_COINS', 1000);
const AD_COINS = 300, AD_DAILY_MAX = 8;
const AD_COOLDOWN = envInt('AD_COOLDOWN_MS', 3 * 60e3), AD_MIN_WATCH = envInt('AD_MIN_WATCH_MS', 15000);
const DAILY_COOLDOWN = envInt('DAILY_COOLDOWN_MS', 20 * 3600e3), REFILL_COOLDOWN = envInt('REFILL_COOLDOWN_MS', 4 * 3600e3);
const rooms = new Map();
// friends: users[key] = { code, name, friends:[key], incoming:[key], outgoing:[key] }; key = sha256(secret uid)
let users = {};
let aliases = {}; // hash of a device secret -> account key (after "login" on a new device)
try { const d = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8')); users = d.users || {}; aliases = d.aliases || {}; } catch { users = {}; aliases = {}; }
const byCode = new Map(Object.entries(users).map(([k, u]) => [u.code, k]));
const byUsername = new Map();
function initUser(u) {
  u.avatar = u.avatar ?? 0; u.coins = u.coins ?? START_COINS; u.trophies = u.trophies ?? 0; u.wins = u.wins ?? 0; u.games = u.games ?? 0;
  u.streak = u.streak ?? 0; u.dailyAt = u.dailyAt || 0; u.refillAt = u.refillAt || 0; u.adAt = u.adAt || 0; u.adDay = u.adDay || ''; u.adCount = u.adCount || 0;
  u.ledger = u.ledger || []; u.username = u.username || null; u.pw = u.pw || null; u.recov = u.recov || null;
  return u;
}
for (const [k, u] of Object.entries(users)) { initUser(u); if (u.username) byUsername.set(u.username, k); }
const online = new Map(); // key -> Set<Conn>
const inviteAt = new Map();
const ipCount = new Map();

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}

/* ---------------- HTTP ---------------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const base = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200, {
        ...base, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  } else if (url === '/lan') {
    res.writeHead(200, { ...base, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ urls: lanUrls() }));
  } else if (url === '/healthz') {
    res.writeHead(200, { ...base, 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404, base); res.end('Not found');
  }
});

/* ---------------- WebSocket (RFC 6455, text frames) ---------------- */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  if (b0 & 0x70) return false; // reserved bits
  const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
  let len = b1 & 0x7f, off = 2;
  if (!masked) return false; // clients must mask
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_PAYLOAD)) return false; len = Number(big); off = 10; }
  if (len > MAX_PAYLOAD) return false;
  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, op, payload, size: off + 4 + len };
}

class Conn {
  constructor(sock, ip) {
    this.sock = sock; this.ip = ip; this.buf = Buffer.alloc(0); this.parts = null;
    this.alive = true; this.closed = false; this.player = null; this.room = null;
    this.ukey = null; this.credHash = null;
    this.bucket = RATE * 2; this.last = Date.now(); this.strikes = 0;
    this.pingT = setInterval(() => { if (!this.alive) return this.destroy(); this.alive = false; this.frame(0x9, Buffer.alloc(0)); }, 25000);
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => this.onClose());
    sock.on('error', () => {});
  }
  frame(op, payload) {
    if (this.sock.destroyed || !this.sock.writable) return;
    const n = payload.length;
    let hdr;
    if (n < 126) hdr = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    this.sock.write(Buffer.concat([hdr, payload]));
  }
  send(obj) { this.frame(0x1, Buffer.from(JSON.stringify(obj))); }
  error(code) { this.send({ t: 'error', code }); }
  close() { this.frame(0x8, Buffer.from([0x03, 0xe8])); this.sock.end(); setTimeout(() => this.destroy(), 500).unref(); }
  destroy() { this.sock.destroy(); }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const f = parseFrame(this.buf);
      if (f === null) break;
      if (f === false) return this.destroy();
      this.buf = this.buf.subarray(f.size);
      this.alive = true;
      if (!this.onFrame(f)) return;
    }
    if (this.buf.length > MAX_PAYLOAD + 14) this.destroy(); // an incomplete frame can never be this large
  }
  onFrame(f) {
    if (f.op >= 8 && (!f.fin || f.payload.length > 125)) { this.destroy(); return false; }
    if (f.op === 8) { this.frame(0x8, f.payload.subarray(0, 2)); this.sock.end(); return false; }
    if (f.op === 9) { this.frame(0xa, f.payload); return true; }
    if (f.op === 10) return true;
    if (f.op === 1) { if (this.parts) { this.destroy(); return false; } this.parts = []; }
    else if (f.op === 0) { if (!this.parts) { this.destroy(); return false; } }
    else { this.destroy(); return false; } // binary/unknown
    this.parts.push(f.payload);
    if (this.parts.reduce((a, b) => a + b.length, 0) > MAX_PAYLOAD) { this.destroy(); return false; }
    if (f.fin) { const text = Buffer.concat(this.parts).toString('utf8'); this.parts = null; this.onMessage(text); }
    return true;
  }
  onMessage(text) {
    if (this.dead) return;
    const now = Date.now();
    this.bucket = Math.min(RATE * 2, this.bucket + ((now - this.last) / 1000) * RATE); this.last = now;
    if (this.bucket < 1) { if (++this.strikes > 50) { this.dead = true; this.error('RATE'); this.close(); } else this.error('RATE'); return; }
    this.bucket -= 1;
    let m;
    try { m = JSON.parse(text); } catch { return this.error('BAD_MESSAGE'); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return this.error('BAD_MESSAGE');
    try { handle(this, m); } catch (e) { console.error('handler error:', e && e.message); this.error('SERVER_ERROR'); }
  }
  onClose() {
    clearInterval(this.pingT);
    if (this.closed) return;
    this.closed = true;
    if (this.ukey) {
      const set = online.get(this.ukey);
      if (set) { set.delete(this); if (!set.size) { online.delete(this.ukey); pushFriendsOf(this.ukey); } }
    }
    ipCount.set(this.ip, Math.max(0, (ipCount.get(this.ip) || 1) - 1));
    const p = this.player, room = this.room;
    this.player = null; this.room = null;
    if (!p || !room || p.conn !== this) return;
    p.conn = null;
    dropVoice(room, p);
    if (room.status === 'LOBBY') p.grace = setTimeout(() => removeFromLobby(room, p), LOBBY_GRACE_MS);
    else if (room.status === 'PLAYING') p.grace = setTimeout(() => {
      if (!p.conn && room.state && room.state.status === 'IN_PROGRESS') { const out = E.leaveGame(room.state, p.id); if (out.ok) commit(room, out); }
    }, GAME_GRACE_MS);
    broadcastRoom(room);
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const ip = req.socket.remoteAddress || '?';
  const origin = req.headers.origin;
  let ok = String(req.headers.upgrade || '').toLowerCase() === 'websocket' && typeof key === 'string' && key.length >= 16;
  if (ok && origin && !EXTRA_ORIGINS.has(origin)) { try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; } } // same-origin only, plus the origins you list
  if (ok && (ipCount.get(ip) || 0) >= MAX_CONN_PER_IP) ok = false;
  if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  new Conn(socket, ip);
});

/* ---------------- rooms ---------------- */
function newCode() {
  for (;;) {
    const b = crypto.randomBytes(5); let c = '';
    for (let i = 0; i < 5; i++) c += ALPHABET[b[i] % ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) : '') || 'Player';
const validPid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);

function addPlayer(room, pid, name) {
  const used = new Set(room.players.map((p) => p.color));
  const color = COLOR_ORDER.find((c) => !used.has(c));
  const p = { id: 'p' + (++room.nextId), pid, name: cleanName(name), color, conn: null, grace: null };
  room.players.push(p);
  return p;
}
function attach(c, room, p) { if (c.ukey) p.ukey = c.ukey; p.conn = c; c.room = room; c.player = p; if (p.grace) { clearTimeout(p.grace); p.grace = null; } }
const pubPlayers = (room) => room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, connected: !!p.conn, host: p.id === room.hostId }));
function sendRoom(room, p) { if (p.conn) p.conn.send({ t: 'room', code: room.code, youId: p.id, status: room.status, stake: room.stake, players: pubPlayers(room) }); }
function broadcastRoom(room) { for (const p of room.players) sendRoom(room, p); }
function legalFor(st) {
  if (st.status !== 'IN_PROGRESS' || st.phase !== 'MOVE' || st.dice === null) return [];
  return E.legalMoves(st, st.seats[st.turn].color, st.dice);
}
function stateMsg(room, events) { return { t: 'state', state: E.publicState(room.state), legal: legalFor(room.state), events }; }
function broadcastState(room, events) { const m = stateMsg(room, events); for (const p of room.players) if (p.conn) p.conn.send(m); }

function armTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    if (room.state && room.state.status === 'IN_PROGRESS') { const out = E.timeoutTurn(room.state, room.state.version); if (out.ok) commit(room, out); }
  }, TURN_MS);
  room.turnTimer.unref();
}
function commit(room, out) {
  room.state = out.state;
  room.events.push(...out.events);
  if (room.events.length > 3000) room.events.splice(0, room.events.length - 3000);
  broadcastState(room, out.events);
  if (room.state.status === 'FINISHED') {
    room.status = 'FINISHED'; clearTimeout(room.turnTimer);
    broadcastRoom(room);
    room.finishedAt = Date.now();
    settleRoom(room);
  } else armTimer(room);
}
function deleteRoom(room) { clearTimeout(room.turnTimer); for (const p of room.players) clearTimeout(p.grace); rooms.delete(room.code); }
function removeFromLobby(room, p) {
  room.players = room.players.filter((x) => x !== p);
  if (!room.players.length) return deleteRoom(room);
  if (room.hostId === p.id) room.hostId = room.players[0].id;
  broadcastRoom(room);
}

function handle(c, m) {
  switch (m.t) {
    case 'create': return onCreate(c, m);
    case 'join': return onJoin(c, m);
    case 'start': return onStart(c);
    case 'roll': case 'move': return onAction(c, m);
    case 'resync': if (c.room && c.room.state) c.send(stateMsg(c.room, [])); return;
    case 'leave': return onLeave(c);
    case 'hello': return onHello(c, m);
    case 'register': return async_(c, onRegister(c, m));
    case 'login': return async_(c, onLogin(c, m));
    case 'reset': return async_(c, onReset(c, m));
    case 'logout': return onLogout(c);
    case 'profile': return onProfile(c, m);
    case 'daily': return onDaily(c);
    case 'refill': return onRefill(c);
    case 'ad_request': return onAdRequest(c);
    case 'ad_reward': return onAdReward(c, m);
    case 'board': return onBoard(c);
    case 'stake': return onStake(c, m);
    case 'friend_add': return onFriendAdd(c, m);
    case 'friend_accept': return onFriendAccept(c, m);
    case 'friend_decline': return onFriendDecline(c, m);
    case 'friend_remove': return onFriendRemove(c, m);
    case 'invite': return onInvite(c, m);
    case 'chat': return onChat(c, m);
    case 'react': return onReact(c, m);
    case 'voice': return onVoice(c, m);
    case 'rtc': return onRtc(c, m);
    default: return c.error('BAD_MESSAGE');
  }
}
function onCreate(c, m) {
  if (c.room) return c.error('ALREADY_IN_ROOM');
  if (!validPid(m.pid)) return c.error('BAD_PID');
  if (rooms.size >= MAX_ROOMS) return c.error('SERVER_BUSY');
  const room = { code: newCode(), status: 'LOBBY', hostId: null, players: [], nextId: 0, state: null, events: [], chat: [], voice: new Set(), stake: 0, pot: 0, settled: false, turnTimer: null, createdAt: Date.now(), finishedAt: 0 };
  const p = addPlayer(room, m.pid, m.name);
  room.hostId = p.id; rooms.set(room.code, room);
  attach(c, room, p);
  broadcastRoom(room);
}
function onJoin(c, m) {
  if (c.room) return c.error('ALREADY_IN_ROOM');
  if (!validPid(m.pid)) return c.error('BAD_PID');
  const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
  const room = /^[A-Z0-9]{4,6}$/.test(code) ? rooms.get(code) : undefined;
  if (!room) return c.error('NO_ROOM');
  const existing = room.players.find((p) => p.pid === m.pid);
  if (existing) { // reconnect
    if (existing.conn && existing.conn !== c) { const old = existing.conn; old.player = null; old.room = null; old.error('REPLACED'); old.close(); }
    attach(c, room, existing);
    broadcastRoom(room);
    if (room.state) c.send(stateMsg(room, []));
    if (room.chat.length) c.send({ t: 'chat_log', msgs: room.chat });
    return;
  }
  if (room.status !== 'LOBBY') return c.error('ROOM_STARTED');
  if (room.players.length >= 4) return c.error('ROOM_FULL');
  if (c.ukey && room.players.some((x) => x.ukey === c.ukey)) return c.error('DUPLICATE_ACCOUNT');
  const p = addPlayer(room, m.pid, m.name);
  attach(c, room, p);
  broadcastRoom(room);
  if (room.chat.length) c.send({ t: 'chat_log', msgs: room.chat });
}
function onStart(c) {
  const room = c.room, p = c.player;
  if (!room || !p) return c.error('NO_ROOM');
  if (room.hostId !== p.id) return c.error('NOT_HOST');
  if (room.status !== 'LOBBY') return c.error('ROOM_STARTED');
  if (room.players.length < 2) return c.error('NEED_PLAYERS');
  if (room.stake > 0) {
    const poor = room.players.filter((x) => !x.ukey || !users[x.ukey] || users[x.ukey].coins < room.stake);
    if (poor.length) { c.send({ t: 'error', code: 'LOW_COINS', names: poor.map((x) => x.name) }); return; }
  }
  const host = room.players.find((x) => x.id === room.hostId);
  room.state = E.createGame(room.players.map((x) => ({ playerId: x.id, color: x.color })), {}, host.color);
  room.status = 'PLAYING';
  room.pot = 0; room.settled = false;
  if (room.stake > 0) for (const x of room.players) { credit(users[x.ukey], -room.stake, 'entry fee'); room.pot += room.stake; pushMe(x.ukey); }
  broadcastRoom(room);
  broadcastState(room, []);
  armTimer(room);
}
function onAction(c, m) {
  const room = c.room, p = c.player;
  if (!room || !p || room.status !== 'PLAYING' || !room.state) return c.error('NO_GAME');
  const cmd = { type: m.t === 'roll' ? 'ROLL' : 'MOVE', playerId: p.id, actionId: m.actionId, expectedVersion: m.v };
  if (m.t === 'move') cmd.tokenIndex = m.token;
  // The dice come from the server only. Anything a client sends besides actionId, v and token is ignored.
  const out = E.applyCommand(room.state, cmd, m.t === 'roll' ? E.secureDice() : undefined);
  if (!out.ok) { c.error(out.error); c.send(stateMsg(room, [])); return; }
  if (out.duplicate) { c.send(stateMsg(room, [])); return; }
  commit(room, out);
}
function onLeave(c) {
  const room = c.room, p = c.player;
  if (!room || !p) return;
  c.room = null; c.player = null; p.conn = null; dropVoice(room, p);
  if (p.grace) clearTimeout(p.grace);
  if (room.status === 'LOBBY') removeFromLobby(room, p);
  else if (room.status === 'PLAYING' && room.state && room.state.status === 'IN_PROGRESS') {
    const out = E.leaveGame(room.state, p.id);
    if (out.ok) commit(room, out);
  }
  c.send({ t: 'left' });
}

/* ---------------- friends, presence, invites ---------------- */
let saveT = null;
function saveSoon() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FRIENDS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ users, aliases }));
      fs.renameSync(tmp, FRIENDS_FILE);
    } catch (e) { console.error('could not save friends:', e.message); }
  }, 400);
  saveT.unref();
}
function flushSave() { clearTimeout(saveT); try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FRIENDS_FILE, JSON.stringify({ users, aliases })); } catch {} }
const hashUid = (uid) => crypto.createHash('sha256').update('ludo:' + uid).digest('hex').slice(0, 32);
function randCode(n) { const b = crypto.randomBytes(n); let c = ''; for (let i = 0; i < n; i++) c += ALPHABET[b[i] % ALPHABET.length]; return c; }
const isOnline = (k) => !!(online.get(k) && online.get(k).size);
function ensureUser(key, name) {
  let u = users[key];
  if (!u) {
    let code; do { code = randCode(6); } while (byCode.has(code));
    u = users[key] = initUser({ code, name: cleanName(name), friends: [], incoming: [], outgoing: [] });
    byCode.set(code, key); saveSoon();
  } else if (name && !u.pw && cleanName(name) !== u.name) { u.name = cleanName(name); saveSoon(); }
  return u;
}
const TIERS = [[1000, 'Diamond'], [600, 'Platinum'], [300, 'Gold'], [100, 'Silver'], [0, 'Bronze']];
const tierOf = (t) => TIERS.find((x) => t >= x[0])[1];
const today = () => new Date().toISOString().slice(0, 10);
function meMsg(key) {
  const u = users[key];
  const pub = (k) => ({ code: users[k].code, name: users[k].name, online: isOnline(k), avatar: users[k].avatar, tier: tierOf(users[k].trophies) });
  const ok = (k) => !!users[k];
  const adsToday = u.adDay === today() ? u.adCount : 0;
  return {
    t: 'me', code: u.code, name: u.name, avatar: u.avatar, coins: u.coins, trophies: u.trophies, tier: tierOf(u.trophies),
    wins: u.wins, games: u.games, streak: u.streak, username: u.username, registered: !!u.pw,
    dailyReadyAt: u.dailyAt + DAILY_COOLDOWN, refillReadyAt: u.refillAt + REFILL_COOLDOWN, adReadyAt: u.adAt + AD_COOLDOWN,
    adsLeft: Math.max(0, AD_DAILY_MAX - adsToday), adCoins: AD_COINS, fees: FEES, serverNow: Date.now(),
    ledger: u.ledger.slice(-8).reverse(),
    friends: u.friends.filter(ok).map(pub), incoming: u.incoming.filter(ok).map(pub), outgoing: u.outgoing.filter(ok).map(pub),
  };
}
function notify(key, msg) { const set = online.get(key); if (set) for (const c of set) c.send(msg); }
function pushMe(key) { if (users[key] && isOnline(key)) notify(key, meMsg(key)); }
function pushFriendsOf(key) { if (users[key]) for (const fk of users[key].friends) pushMe(fk); }
const without = (arr, k) => arr.filter((x) => x !== k);
function needHello(c) { if (!c.ukey) { c.error('NO_HELLO'); return null; } return users[c.ukey]; }
const codeOf = (m) => (typeof m.code === 'string' ? m.code.trim().toUpperCase() : '');

function attachPresence(c, key) {
  c.ukey = key;
  if (!online.has(key)) online.set(key, new Set());
  const wasOffline = online.get(key).size === 0;
  online.get(key).add(c);
  if (wasOffline) pushFriendsOf(key);
}
function detachPresence(c) {
  const key = c.ukey; if (!key) return;
  const set = online.get(key);
  if (set) { set.delete(c); if (!set.size) { online.delete(key); pushFriendsOf(key); } }
  c.ukey = null;
}
function onHello(c, m) {
  if (!validPid(m.uid)) return c.error('BAD_UID');
  const raw = hashUid(m.uid);
  if (c.credHash && c.credHash !== raw) return c.error('BAD_UID');
  const key = aliases[raw] || raw;
  if (c.ukey && c.ukey !== key) return c.error('BAD_UID');
  const before = users[key] && users[key].name;
  ensureUser(key, m.name);
  if (before && users[key].name !== before) pushFriendsOf(key); // friends see the new name
  c.credHash = raw;
  if (!c.ukey) attachPresence(c, key);
  c.send(meMsg(key));
}
function acceptFriend(a, b) { // a accepts b's request
  const ua = users[a], ub = users[b];
  ua.incoming = without(ua.incoming, b); ua.outgoing = without(ua.outgoing, b);
  ub.incoming = without(ub.incoming, a); ub.outgoing = without(ub.outgoing, a);
  if (!ua.friends.includes(b)) ua.friends.push(b);
  if (!ub.friends.includes(a)) ub.friends.push(a);
  saveSoon(); pushMe(a); pushMe(b);
  notify(b, { t: 'toast', kind: 'friend_ok', from: { code: ua.code, name: ua.name } });
}
function onFriendAdd(c, m) {
  const me = needHello(c); if (!me) return;
  const tk = byCode.get(codeOf(m));
  if (!tk) return c.error('NO_SUCH_USER');
  if (tk === c.ukey) return c.error('SELF');
  const them = users[tk];
  if (me.friends.includes(tk)) return c.error('ALREADY_FRIENDS');
  if (me.incoming.includes(tk)) return acceptFriend(c.ukey, tk);
  if (me.outgoing.includes(tk)) return c.error('ALREADY_SENT');
  if (them.incoming.length >= 50 || me.outgoing.length >= 50 || me.friends.length >= 200) return c.error('LIMIT');
  me.outgoing.push(tk); them.incoming.push(c.ukey);
  saveSoon(); pushMe(c.ukey); pushMe(tk);
  notify(tk, { t: 'toast', kind: 'friend_req', from: { code: me.code, name: me.name } });
}
function onFriendAccept(c, m) {
  const me = needHello(c); if (!me) return;
  const tk = byCode.get(codeOf(m));
  if (!tk || !me.incoming.includes(tk)) return c.error('NO_REQUEST');
  acceptFriend(c.ukey, tk);
}
function onFriendDecline(c, m) {
  const me = needHello(c); if (!me) return;
  const tk = byCode.get(codeOf(m)); if (!tk) return;
  me.incoming = without(me.incoming, tk); me.outgoing = without(me.outgoing, tk);
  users[tk].incoming = without(users[tk].incoming, c.ukey); users[tk].outgoing = without(users[tk].outgoing, c.ukey);
  saveSoon(); pushMe(c.ukey); pushMe(tk);
}
function onFriendRemove(c, m) {
  const me = needHello(c); if (!me) return;
  const tk = byCode.get(codeOf(m)); if (!tk) return;
  me.friends = without(me.friends, tk); users[tk].friends = without(users[tk].friends, c.ukey);
  saveSoon(); pushMe(c.ukey); pushMe(tk);
}
function onInvite(c, m) {
  const me = needHello(c); if (!me) return;
  if (!c.room || c.room.status !== 'LOBBY') return c.error('NOT_IN_LOBBY');
  const tk = byCode.get(codeOf(m));
  if (!tk || !me.friends.includes(tk)) return c.error('NOT_FRIENDS');
  if (!isOnline(tk)) return c.error('FRIEND_OFFLINE');
  const now = Date.now(), k = c.ukey + ':' + tk;
  if (now - (inviteAt.get(k) || 0) < 3000) return c.error('RATE');
  if (inviteAt.size > 5000) inviteAt.clear();
  inviteAt.set(k, now);
  notify(tk, { t: 'invite', from: { code: me.code, name: me.name }, room: c.room.code });
  c.send({ t: 'invite_sent', code: users[tk].code });
}

/* ---------------- chat, reactions, voice signalling ---------------- */
function inRoom(c) { return c.room && c.player ? { room: c.room, p: c.player } : null; }
function toRoom(room, msg) { for (const p of room.players) if (p.conn) p.conn.send(msg); }
function onChat(c, m) {
  const r = inRoom(c); if (!r) return c.error('NO_ROOM');
  const text = typeof m.text === 'string' ? m.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) : '';
  if (!text) return;
  const now = Date.now();
  if (now - (r.p.lastChat || 0) < 500) return c.error('RATE');
  r.p.lastChat = now;
  const msg = { t: 'chat', id: r.p.id, name: r.p.name, color: r.p.color, text, ts: now };
  r.room.chat.push(msg); if (r.room.chat.length > 40) r.room.chat.shift();
  toRoom(r.room, msg);
}
function onReact(c, m) {
  const r = inRoom(c); if (!r) return c.error('NO_ROOM');
  if (!REACTS.has(m.e)) return c.error('BAD_REACT');
  const now = Date.now();
  if (now - (r.p.lastReact || 0) < 600) return c.error('RATE');
  r.p.lastReact = now;
  toRoom(r.room, { t: 'react', id: r.p.id, e: m.e });
}
function dropVoice(room, p) {
  if (room.voice && room.voice.delete(p.id)) for (const q of room.players) if (q !== p && q.conn) q.conn.send({ t: 'voice', id: p.id, on: false });
}
function onVoice(c, m) {
  const r = inRoom(c); if (!r) return c.error('NO_ROOM');
  if (m.on) {
    const peers = [...r.room.voice].filter((id) => id !== r.p.id);
    r.room.voice.add(r.p.id);
    c.send({ t: 'voice_peers', ids: peers }); // the newcomer calls everyone already in voice
    for (const q of r.room.players) if (q !== r.p && q.conn) q.conn.send({ t: 'voice', id: r.p.id, on: true });
  } else dropVoice(r.room, r.p);
}
function onRtc(c, m) {
  const r = inRoom(c); if (!r) return;
  const to = r.room.players.find((p) => p.id === m.to);
  if (!to || !to.conn || to === r.p) return;
  let s; try { s = JSON.stringify(m.d); } catch { return; }
  if (!s || s.length > 7000) return c.error('TOO_BIG');
  to.conn.send({ t: 'rtc', from: r.p.id, d: m.d });
}
/* ---------------- accounts, coins, ranks, rewarded ads ---------------- */
const scrypt = util.promisify(crypto.scrypt);
async function hashPw(pw) { const salt = crypto.randomBytes(16); const h = await scrypt(pw, salt, 32); return salt.toString('hex') + ':' + h.toString('hex'); }
async function verifyPw(pw, stored) {
  try {
    const [sh, hh] = String(stored).split(':');
    const d = await scrypt(pw, Buffer.from(sh, 'hex'), 32), e = Buffer.from(hh, 'hex');
    return e.length === d.length && crypto.timingSafeEqual(d, e);
  } catch { return false; }
}
let DUMMY = null; hashPw('dummy-password').then((h) => { DUMMY = h; });
const normUser = (s) => (typeof s === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(s.trim()) ? s.trim().toLowerCase() : null);
const normRec = (s) => (typeof s === 'string' ? s.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '');
const newRecovery = () => { const c = randCode(12); return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8); };
const fails = new Map();
function async_(c, p) { p.catch((e) => { console.error('async handler error:', e && e.message); c.error('SERVER_ERROR'); }); }

function credit(u, amount, reason) {
  u.coins = Math.max(0, u.coins + amount);
  u.ledger.push({ t: Date.now(), d: amount, r: reason });
  if (u.ledger.length > 30) u.ledger.shift();
  saveSoon();
}
function lockedOut(c, id) {
  const f = fails.get(id);
  if (f && f.n >= 5) { if (Date.now() < f.until) return true; fails.delete(id); }
  return false;
}
function noteFail(id) {
  const f = fails.get(id) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) f.until = Date.now() + 60000;
  fails.set(id, f); if (fails.size > 5000) fails.clear();
}
function rebind(c, key) {
  detachPresence(c);
  if (c.credHash && c.credHash !== key) aliases[c.credHash] = key;
  attachPresence(c, key); saveSoon();
  c.send(meMsg(key)); pushFriendsOf(key);
}
async function onRegister(c, m) {
  const u = needHello(c); if (!u) return;
  if (u.pw) return c.error('ALREADY_REGISTERED');
  const un = normUser(m.username); if (!un) return c.error('BAD_USERNAME');
  const pw = typeof m.password === 'string' ? m.password : '';
  if (pw.length < 6 || pw.length > 64) return c.error('BAD_PASSWORD');
  if (byUsername.has(un)) return c.error('USERNAME_TAKEN');
  byUsername.set(un, c.ukey); // reserve before awaiting
  try {
    const rec = newRecovery();
    u.pw = await hashPw(pw); u.recov = await hashPw(normRec(rec)); u.username = un;
    saveSoon();
    c.send({ t: 'auth_ok', username: un, recovery: rec, created: true });
    pushMe(c.ukey);
  } catch (e) { byUsername.delete(un); u.pw = null; u.recov = null; u.username = null; throw e; }
}
async function onLogin(c, m) {
  if (!c.credHash) return c.error('NO_HELLO');
  const un = normUser(m.username), pw = typeof m.password === 'string' ? m.password.slice(0, 200) : '';
  const id = 'l|' + c.ip + '|' + (un || '?');
  if (lockedOut(c, id)) return c.error('LOCKED');
  const key = un && byUsername.get(un), u = key && users[key];
  const ok = await verifyPw(pw, u && u.pw ? u.pw : DUMMY) && !!(u && u.pw);
  if (!ok) { noteFail(id); return c.error('BAD_LOGIN'); }
  fails.delete(id);
  rebind(c, key);
  c.send({ t: 'auth_ok', username: u.username, login: true });
}
async function onReset(c, m) {
  if (!c.credHash) return c.error('NO_HELLO');
  const un = normUser(m.username), rec = normRec(m.recovery), pw = typeof m.password === 'string' ? m.password : '';
  if (pw.length < 6 || pw.length > 64) return c.error('BAD_PASSWORD');
  const id = 'r|' + c.ip + '|' + (un || '?');
  if (lockedOut(c, id)) return c.error('LOCKED');
  const key = un && byUsername.get(un), u = key && users[key];
  const ok = await verifyPw(rec, u && u.recov ? u.recov : DUMMY) && !!(u && u.recov);
  if (!ok) { noteFail(id); return c.error('BAD_RECOVERY'); }
  fails.delete(id);
  const fresh = newRecovery();
  u.pw = await hashPw(pw); u.recov = await hashPw(normRec(fresh)); saveSoon();
  rebind(c, key);
  c.send({ t: 'auth_ok', username: u.username, login: true, recovery: fresh });
}
function onLogout(c) {
  if (!c.ukey) return;
  if (c.credHash && aliases[c.credHash]) delete aliases[c.credHash];
  detachPresence(c); c.credHash = null; saveSoon();
  c.send({ t: 'logged_out' });
}
function onProfile(c, m) {
  const u = needHello(c); if (!u) return;
  if (typeof m.name === 'string' && m.name.trim()) u.name = cleanName(m.name);
  if (Number.isInteger(m.avatar) && m.avatar >= 0 && m.avatar < 12) u.avatar = m.avatar;
  saveSoon(); pushMe(c.ukey); pushFriendsOf(c.ukey);
}
function onDaily(c) {
  const u = needHello(c); if (!u) return;
  const now = Date.now();
  if (now < u.dailyAt + DAILY_COOLDOWN) return c.error('NOT_READY');
  u.streak = u.dailyAt && now - u.dailyAt < DAILY_COOLDOWN * 2.4 ? u.streak + 1 : 1;
  const amount = Math.min(100 + (u.streak - 1) * 50, 500);
  u.dailyAt = now; credit(u, amount, 'daily bonus');
  c.send({ t: 'reward', kind: 'daily', amount, streak: u.streak }); pushMe(c.ukey);
}
function onRefill(c) {
  const u = needHello(c); if (!u) return;
  const now = Date.now();
  if (u.coins >= 100) return c.error('NOT_NEEDED');
  if (now < u.refillAt + REFILL_COOLDOWN) return c.error('NOT_READY');
  u.refillAt = now; credit(u, 200, 'free refill');
  c.send({ t: 'reward', kind: 'refill', amount: 200 }); pushMe(c.ukey);
}
const adNonces = new Map();
function adAllowed(u) {
  const now = Date.now();
  if (now < u.adAt + AD_COOLDOWN) return 'NOT_READY';
  if (u.adDay === today() && u.adCount >= AD_DAILY_MAX) return 'AD_LIMIT';
  return null;
}
function onAdRequest(c) {
  const u = needHello(c); if (!u) return;
  const why = adAllowed(u); if (why) return c.error(why);
  if (adNonces.size > 5000) adNonces.clear();
  const nonce = crypto.randomBytes(8).toString('hex');
  adNonces.set(nonce, { key: c.ukey, t: Date.now() });
  c.send({ t: 'ad_ok', nonce, min: AD_MIN_WATCH });
}
function onAdReward(c, m) {
  const u = needHello(c); if (!u) return;
  const n = typeof m.nonce === 'string' ? adNonces.get(m.nonce) : null;
  if (!n || n.key !== c.ukey) return c.error('BAD_NONCE');
  const age = Date.now() - n.t;
  if (age < AD_MIN_WATCH) return c.error('TOO_EARLY'); // the nonce stays valid: the client may retry later
  adNonces.delete(m.nonce);
  if (age > 10 * 60e3) return c.error('BAD_NONCE');
  const why = adAllowed(u); if (why) return c.error(why);
  const d = today(); if (u.adDay !== d) { u.adDay = d; u.adCount = 0; }
  u.adCount++; u.adAt = Date.now(); credit(u, AD_COINS, 'rewarded ad');
  c.send({ t: 'reward', kind: 'ad', amount: AD_COINS }); pushMe(c.ukey);
}
function onBoard(c) {
  const all = Object.entries(users).filter(([, u]) => u.games > 0 || u.trophies > 0)
    .sort((a, b) => b[1].trophies - a[1].trophies || b[1].wins - a[1].wins);
  const rows = all.slice(0, 20).map(([k, u]) => ({ name: u.name, avatar: u.avatar, trophies: u.trophies, tier: tierOf(u.trophies), wins: u.wins, you: k === c.ukey }));
  const mine = all.findIndex(([k]) => k === c.ukey);
  c.send({ t: 'board', rows, myRank: mine >= 0 ? mine + 1 : null });
}
function onStake(c, m) {
  const room = c.room, p = c.player;
  if (!room || !p) return c.error('NO_ROOM');
  if (room.hostId !== p.id) return c.error('NOT_HOST');
  if (room.status !== 'LOBBY') return c.error('ROOM_STARTED');
  if (!FEES.includes(m.amount)) return c.error('BAD_STAKE');
  room.stake = m.amount; broadcastRoom(room);
}
function settleRoom(room) {
  if (room.settled || !room.state) return;
  room.settled = true;
  const st = room.state, win = st.winner;
  for (const p of room.players) {
    const u = p.ukey && users[p.ukey]; if (!u) continue;
    const seat = st.seats.find((x) => x.playerId === p.id);
    const won = !!win && win.playerId === p.id, left = !!(seat && seat.left);
    let gain = 0, tro = 0;
    u.games++;
    if (won) { u.wins++; tro = 25; gain = room.stake > 0 ? room.pot : 30; }
    else { tro = left ? -15 : -10; if (room.stake === 0 && !left) gain = 5; }
    if (gain > 0) credit(u, gain, won ? (room.stake > 0 ? 'won the pot' : 'win bonus') : 'played');
    const before = u.trophies;
    u.trophies = Math.max(0, u.trophies + tro);
    const net = gain - (room.stake > 0 ? room.stake : 0);
    if (p.conn) p.conn.send({ t: 'result', won, coins: net, trophies: u.trophies - before, total: u.coins, tier: tierOf(u.trophies) });
    pushMe(p.ukey);
  }
  saveSoon();
}
process.on('exit', flushSave);

setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (now - r.createdAt > 6 * 3600e3 || (r.finishedAt && now - r.finishedAt > 10 * 60e3)) deleteRoom(r);
  }
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Ludo Hub server is running.\n');
    console.log(`  On this computer:   http://localhost:${PORT}`);
    for (const u of lanUrls()) console.log(`  Friends on Wi-Fi:   ${u}`);
    console.log('\n  Keep this window open while playing. Close it to stop the server.\n');
  });
}
module.exports = { server, rooms };
