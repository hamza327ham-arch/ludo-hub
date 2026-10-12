'use strict';
// Self-test for server.js: node test-online.js   (needs Node 22+, starts its own server on a spare port)
const { spawn } = require('child_process');
const net = require('net');
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ludo-test-'));

const PORT = 40000 + Math.floor(Math.random() * 10000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) { this.name = name; this.pid = 'pid' + name + '0123456789abcdef'; this.q = []; this.waiters = []; this.state = null; this.room = null; this.errors = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.onopen = () => res(this);
      this.ws.onerror = () => rej(new Error('ws error'));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === 'state') this.state = m;
        if (m.t === 'room') this.room = m;
        if (m.t === 'error') this.errors.push(m.code);
        this.q.push(m);
        this.waiters = this.waiters.filter((w) => !w(m));
      };
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, ms = 4000) {
    const hit = this.q.find(pred); if (hit) { this.q.splice(this.q.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting on ' + this.name)), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(t); this.q.splice(this.q.indexOf(m), 1); res(m); return true; } return false; });
    });
  }
}

function rawUpgrade(origin) {
  return new Promise((res) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
    });
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('close', () => res(data));
    setTimeout(() => { s.destroy(); }, 800);
  });
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), TURN_MS: '3000', GAME_GRACE_MS: '1500', RATE_PER_SEC: '200', LUDO_DATA: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('running') && res()));
  const results = [];
  const check = (name) => { results.push(name); console.log('ok -', name); };
  try {
    // http
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    assert.ok(html.includes('<canvas')); check('serves index.html');
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/../server.js`)).status === 200 && (await (await fetch(`http://127.0.0.1:${PORT}/server.js`)).text()).includes('createServer'), false); check('does not serve server source');
    assert.ok(!(await rawUpgrade('http://evil.example')).includes('101')); check('cross-origin websocket is refused');

    const A = await new Client('Alice').open(), B = await new Client('Bob').open();
    A.send({ t: 'create', pid: A.pid, name: 'Alice' });
    const ra = await A.waitFor((m) => m.t === 'room');
    assert.equal(ra.players.length, 1); assert.equal(ra.players[0].color, 3); assert.equal(ra.players[0].host, true); check('create room (host gets blue)');
    B.send({ t: 'join', code: ra.code.toLowerCase(), pid: B.pid, name: 'Bob<script>' });
    const rb = await B.waitFor((m) => m.t === 'room');
    assert.equal(rb.players.length, 2); assert.equal(rb.players[1].color, 1); assert.ok(!rb.players[1].name.includes('<')); check('join by code (case-insensitive), name sanitised');
    const C = await new Client('Cy').open(); C.send({ t: 'join', code: 'ZZZZZ', pid: C.pid, name: 'x' });
    assert.equal((await C.waitFor((m) => m.t === 'error')).code, 'NO_ROOM'); check('unknown room rejected');
    B.send({ t: 'start' }); assert.equal((await B.waitFor((m) => m.t === 'error')).code, 'NOT_HOST'); check('only the host can start');
    A.send({ t: 'roll', actionId: 'x', v: 0 }); assert.equal((await A.waitFor((m) => m.t === 'error')).code, 'NO_GAME'); check('no actions before the game starts');

    A.send({ t: 'start' });
    const sa = await A.waitFor((m) => m.t === 'state'); await B.waitFor((m) => m.t === 'state');
    assert.deepEqual(sa.state.seats.map((s) => s.color), [1, 3]);
    assert.equal(sa.state.seats[sa.state.turn].color, 3); assert.equal('processed' in sa.state, false); check('game starts, host (blue) moves first, snapshot hides action log');

    B.send({ t: 'roll', actionId: 'b1', v: 0 }); assert.equal((await B.waitFor((m) => m.t === 'error')).code, 'NOT_YOUR_TURN'); check('player out of turn cannot roll');
    A.send({ t: 'roll', actionId: 'a-stale', v: 99 }); assert.equal((await A.waitFor((m) => m.t === 'error')).code, 'STALE_VERSION'); check('stale version rejected');
    A.send({ t: 'roll', actionId: '', v: 0 }); assert.equal((await A.waitFor((m) => m.t === 'error')).code, 'INVALID_ACTION_ID'); check('empty actionId rejected');
    A.send({ t: 'move', actionId: 'm0', v: 0, token: 0 }); assert.equal((await A.waitFor((m) => m.t === 'error')).code, 'WRONG_PHASE'); check('move before roll rejected');

    // spoofed dice / winner / tokens are ignored; the same action sent twice applies once
    const rollMsg = { t: 'roll', actionId: 'r-dup', v: 0, dice: 6, winner: 'p1', tokens: [[56, 56, 56, 56]] };
    await sleep(200); A.q.length = 0; B.q.length = 0;
    A.send(rollMsg); A.send(rollMsg);
    const first = await A.waitFor((m) => m.t === 'state' && m.events.length > 0);
    const dup = await A.waitFor((m) => m.t === 'state' && m.events.length === 0);
    assert.equal(dup.state.version, first.state.version);
    assert.equal(first.events.filter((e) => e.type === 'DICE_ROLLED').length, 1);
    assert.equal(first.state.winner, null); check('duplicate actionId applies once; spoofed fields ignored');
    await B.waitFor((m) => m.t === 'state' && m.events.length > 0);

    // reconnect mid-game
    const v = A.state.state.version; A.ws.close(); await sleep(150);
    const A2 = await new Client('Alice').open(); A2.send({ t: 'join', code: ra.code, pid: A.pid, name: 'Alice' });
    const snap = await A2.waitFor((m) => m.t === 'state');
    assert.equal(snap.state.version, B.state.state.version); assert.ok(snap.state.version >= v); check('reconnect restores the latest snapshot');
    const A3 = await new Client('Mallory').open(); A3.send({ t: 'join', code: ra.code, pid: 'pidMallory0123456789abcdef', name: 'M' });
    assert.equal((await A3.waitFor((m) => m.t === 'error')).code, 'ROOM_STARTED'); check('strangers cannot join a running game');
    A3.send({ t: 'roll', actionId: 'zz', v: 0 }); assert.equal((await A3.waitFor((m) => m.t === 'error')).code, 'NO_GAME'); check('non-members cannot act');

    // play to the end through the server
    const clients = { 3: A2, 1: B }; const seen = new Set(); let moves = 0;
    const done = new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('game did not finish')), 60000);
      let n = 0;
      const act = (cl, st, legal) => {
        const s = st; if (s.status === 'FINISHED') return;
        const mine = clients[s.seats[s.turn].color] === cl; if (!mine) return;
        if (s.phase === 'ROLL') cl.send({ t: 'roll', actionId: 'g' + (++n), v: s.version });
        else cl.send({ t: 'move', actionId: 'g' + (++n), v: s.version, token: legal[legal.length - 1] });
      };
      for (const cl of Object.values(clients)) {
        cl.ws.onmessage = ((orig) => (e) => {
          orig(e); const m = JSON.parse(e.data);
          if (m.t === 'state') {
            for (const ev of m.events) if (ev.type === 'DICE_ROLLED') { seen.add(ev.value); moves++; }
            if (m.state.status === 'FINISHED') { clearTimeout(to); res(m.state); } else act(cl, m.state, m.legal);
          }
        })(cl.ws.onmessage);
      }
      act(A2, A2.state.state, A2.state.legal); act(B, B.state.state, B.state.legal);
    });
    const fin = await done;
    assert.ok(fin.winner); assert.ok(fin.tokens[fin.winner.color].every((p) => p === 56));
    assert.ok(seen.size > 1, 'dice must vary even though the client always asked for 6'); check(`full game finished server-side (${moves} rolls, winner ${fin.winner.playerId})`);
    A2.q.length = 0; A2.send({ t: 'roll', actionId: 'late', v: fin.version }); assert.equal((await A2.waitFor((m) => m.t === 'error')).code, 'NO_GAME'); check('no moves after the game is over');

    // message flood is throttled
    A2.q.length = 0; for (let i = 0; i < 700; i++) A2.send({ t: 'resync' });
    await A2.waitFor((m) => m.t === 'error' && m.code === 'RATE', 3000); check('message flood is rate-limited');

    // timeout + leaving in a fresh room
    const P = await new Client('Pat').open(), Q = await new Client('Quinn').open();
    P.send({ t: 'create', pid: P.pid + 'x', name: 'Pat' }); const rp = await P.waitFor((m) => m.t === 'room');
    Q.send({ t: 'join', code: rp.code, pid: Q.pid + 'x', name: 'Quinn' }); await Q.waitFor((m) => m.t === 'room');
    P.send({ t: 'start' }); await P.waitFor((m) => m.t === 'state'); await Q.waitFor((m) => m.t === 'state');
    const to = await P.waitFor((m) => m.t === 'state' && m.events.some((e) => e.type === 'TURN_SKIPPED' && e.reason === 'TIMEOUT'), 6000);
    assert.ok(to); check('idle turn times out and passes on');
    Q.send({ t: 'leave' });
    const end = await P.waitFor((m) => m.t === 'state' && m.state.status === 'FINISHED', 3000);
    assert.equal(end.state.winner.reason, 'LAST_PLAYER_STANDING'); check('leaving a 2-player game makes the other player win');

    // ================= social: friends, invites, chat, reactions, voice signalling =================
    const mkU = async (n) => { const c = await new Client(n).open(); c.uid = 'uid-' + n + '-0123456789abcdef'; return c; };
    const hello = async (c, name) => { c.q.length = 0; c.send({ t: 'hello', uid: c.uid, name }); return c.waitFor((m) => m.t === 'me'); };
    const U1 = await mkU('u1'), U2 = await mkU('u2'), U3 = await mkU('u3');
    const m1 = await hello(U1, 'Uma'), m2 = await hello(U2, 'Umar'), m3 = await hello(U3, 'Zoya');
    assert.match(m1.code, /^[A-Z0-9]{6}$/); assert.deepEqual(m1.friends, []); check('hello registers a user and returns a friend code');
    U1.send({ t: 'friend_add', code: m1.code }); assert.equal((await U1.waitFor((m) => m.t === 'error')).code, 'SELF');
    U1.send({ t: 'friend_add', code: 'QQQQQQ' }); assert.equal((await U1.waitFor((m) => m.t === 'error')).code, 'NO_SUCH_USER'); check('cannot friend yourself or an unknown code');
    U2.q.length = 0; U1.q.length = 0;
    U1.send({ t: 'friend_add', code: m2.code });
    const toast = await U2.waitFor((m) => m.t === 'toast' && m.kind === 'friend_req'); assert.equal(toast.from.code, m1.code);
    const me2 = await U2.waitFor((m) => m.t === 'me' && m.incoming.length === 1); assert.equal(me2.incoming[0].name, 'Uma');
    const me1o = await U1.waitFor((m) => m.t === 'me' && m.outgoing.length === 1); assert.ok(me1o);
    U1.send({ t: 'friend_add', code: m2.code }); assert.equal((await U1.waitFor((m) => m.t === 'error')).code, 'ALREADY_SENT'); check('friend request is delivered live to the other player');
    U1.q.length = 0; U2.send({ t: 'friend_accept', code: m1.code });
    const f1 = await U1.waitFor((m) => m.t === 'me' && m.friends.length === 1); assert.equal(f1.friends[0].online, true);
    await U1.waitFor((m) => m.t === 'toast' && m.kind === 'friend_ok'); check('accepting makes both players friends (online status shown)');
    U1.send({ t: 'invite', code: m2.code }); assert.equal((await U1.waitFor((m) => m.t === 'error')).code, 'NOT_IN_LOBBY'); check('invite needs a lobby');

    U1.send({ t: 'create', pid: U1.uid, name: 'Uma' }); const rU = await U1.waitFor((m) => m.t === 'room');
    U1.send({ t: 'invite', code: m3.code }); assert.equal((await U1.waitFor((m) => m.t === 'error')).code, 'NOT_FRIENDS'); check('cannot invite someone who is not your friend');
    U2.q.length = 0; U1.send({ t: 'invite', code: m2.code });
    const inv = await U2.waitFor((m) => m.t === 'invite'); assert.equal(inv.room, rU.code); assert.equal(inv.from.name, 'Uma'); check('friend invite carries the room code');
    U2.send({ t: 'join', code: inv.room, pid: U2.uid, name: 'Umar' }); const rj = await U2.waitFor((m) => m.t === 'room'); assert.equal(rj.players.length, 2);

    // chat
    U1.q.length = 0; U2.q.length = 0;
    U1.send({ t: 'chat', text: 'hello <b>there</b>' });
    const c1 = await U2.waitFor((m) => m.t === 'chat'); assert.equal(c1.name, 'Uma'); assert.equal(c1.text, 'hello <b>there</b>'); await U1.waitFor((m) => m.t === 'chat');
    U1.send({ t: 'chat', text: 'again' }); assert.equal((await U1.waitFor((m) => m.t === 'error')).code, 'RATE'); check('chat reaches the room; chat is rate-limited');
    await sleep(600); U2.q.length = 0;
    U2.send({ t: 'chat', text: 'x'.repeat(500) + '\u0007\u0000' });
    const c2 = await U1.waitFor((m) => m.t === 'chat' && m.id === rj.youId); assert.equal(c2.text.length, 160); assert.ok(!/[\u0000-\u001f]/.test(c2.text)); check('chat text is trimmed to 160 chars and control characters are removed');
    U3.send({ t: 'chat', text: 'let me in' }); assert.equal((await U3.waitFor((m) => m.t === 'error')).code, 'NO_ROOM'); check('non-members cannot chat');
    // reconnect gets the chat history
    const U2b = await mkU('u2'); U2b.send({ t: 'join', code: rU.code, pid: U2.uid, name: 'Umar' });
    const log = await U2b.waitFor((m) => m.t === 'chat_log'); assert.ok(log.msgs.length >= 2); check('rejoining shows earlier chat'); U2.ws.close(); U2.ws = U2b.ws; Object.assign(U2, { q: U2b.q, waiters: U2b.waiters }); U2b.ws.onmessage = ((o) => (e) => o(e))(U2b.ws.onmessage);

    // reactions
    await sleep(700); U1.q.length = 0; U2b.q.length = 0;
    U1.send({ t: 'react', e: 'x' }); assert.equal((await U1.waitFor((m) => m.t === 'error')).code, 'BAD_REACT');
    U1.send({ t: 'react', e: '🎉' }); const rc = await U2b.waitFor((m) => m.t === 'react'); assert.equal(rc.e, '🎉'); assert.equal(rc.id, rU.youId); check('only whitelisted emoji reactions are relayed');

    // voice signalling
    U1.q.length = 0; U2b.q.length = 0;
    U1.send({ t: 'voice', on: true }); assert.deepEqual((await U1.waitFor((m) => m.t === 'voice_peers')).ids, []);
    U2b.send({ t: 'voice', on: true }); assert.deepEqual((await U2b.waitFor((m) => m.t === 'voice_peers')).ids, [rU.youId]);
    assert.equal((await U1.waitFor((m) => m.t === 'voice' && m.on)).id, rj.youId); check('voice: the newcomer is told who to call');
    U2b.send({ t: 'rtc', to: rU.youId, d: { s: { type: 'offer', sdp: 'v=0' } } });
    const rtc = await U1.waitFor((m) => m.t === 'rtc'); assert.equal(rtc.from, rj.youId); assert.equal(rtc.d.s.type, 'offer');
    U2b.send({ t: 'rtc', to: 'p99', d: { c: 1 } }); U2b.send({ t: 'rtc', to: rU.youId, d: { big: 'x'.repeat(7500) } });
    assert.equal((await U2b.waitFor((m) => m.t === 'error')).code, 'TOO_BIG'); check('voice signalling is relayed only to room members and size-limited');
    U1.q.length = 0; U2b.send({ t: 'leave' });
    const off = await U1.waitFor((m) => m.t === 'voice' && !m.on); assert.equal(off.id, rj.youId); check('leaving the room ends that player\'s voice');

    // presence + persistence
    U1.q.length = 0; U3.send({ t: 'friend_add', code: m1.code }); await U3.waitFor((m) => m.t === 'me');
    U1.ws.close(); await sleep(300);
    await sleep(700); // let the debounced save hit the disk
    srv.kill(); await sleep(300);
    const srv2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), LUDO_DATA: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => srv2.stdout.on('data', (d) => String(d).includes('running') && res()));
    const R = await mkU('u1'); const back = await hello(R, 'Uma');
    assert.equal(back.code, m1.code); assert.equal(back.friends.length, 1); assert.equal(back.friends[0].name, 'Umar'); assert.equal(back.incoming.length, 1);
    check('friends and pending requests survive a server restart'); srv2.kill();
    console.log(`\nALL ${results.length} CHECKS PASSED`);
  } catch (e) {
    console.error('\nFAILED:', e.message); process.exitCode = 1;
  } finally { srv.kill(); process.exit(process.exitCode || 0); }
})();
