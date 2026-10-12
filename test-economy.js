'use strict';
// Self-test for accounts, coins, ranks, rewarded ads and entry-fee tables:  node test-economy.js
const { spawn } = require('child_process');
const assert = require('assert/strict');
const path = require('path'), fs = require('fs'), os = require('os');
const PORT = 44000 + Math.floor(Math.random() * 5000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ludo-eco-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENV = { ...process.env, PORT: String(PORT), LUDO_DATA: DATA, RATE_PER_SEC: '400', AD_COOLDOWN_MS: '1200', AD_MIN_WATCH_MS: '300', TURN_MS: '60000' };
const startServer = () => new Promise((res) => { const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: ENV, stdio: ['ignore', 'pipe', 'inherit'] }); p.stdout.on('data', (d) => String(d).includes('running') && res(p)); });

class C {
  constructor(n) { this.n = n; this.uid = 'uid-' + n + '-0123456789abcdef'; this.q = []; this.w = []; this.me = null; this.st = null; }
  open() { return new Promise((res, rej) => { this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`); this.ws.onopen = () => res(this); this.ws.onerror = () => rej(new Error('ws')); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'me') this.me = m; if (m.t === 'state') this.st = m; this.q.push(m); this.w = this.w.filter((f) => !f(m)); }; }); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms = 4000) { const h = this.q.find(pred); if (h) { this.q.splice(this.q.indexOf(h), 1); return Promise.resolve(h); } return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + this.n)), ms); this.w.push((m) => { if (pred(m)) { clearTimeout(t); this.q.splice(this.q.indexOf(m), 1); res(m); return true; } return false; }); }); }
  async hello(name) { this.q.length = 0; this.send({ t: 'hello', uid: this.uid, name }); return this.wait((m) => m.t === 'me'); }
  async err(code) { const e = await this.wait((m) => m.t === 'error'); assert.equal(e.code, code); return e; }
  async meNow() { this.q.length = 0; this.send({ t: 'hello', uid: this.uid }); return this.wait((m) => m.t === 'me'); }
}
(async () => {
  let srv = await startServer(); const done = []; const ok = (n) => { done.push(n); console.log('ok -', n); };
  try {
    const A = await new C('alice').open(); let m = await A.hello('Alice');
    assert.equal(m.coins, 1000); assert.equal(m.trophies, 0); assert.equal(m.tier, 'Bronze'); assert.equal(m.registered, false); assert.deepEqual(m.fees, [0, 50, 100, 500, 1000]); ok('new players start as guests with 1000 coins, Bronze, no trophies');

    A.q.length = 0; A.send({ t: 'daily' }); const dr = await A.wait((x) => x.t === 'reward'); assert.equal(dr.amount, 100); assert.equal((await A.wait((x) => x.t === 'me')).coins, 1100);
    A.send({ t: 'daily' }); await A.err('NOT_READY'); ok('daily bonus is paid once per cooldown');
    A.send({ t: 'refill' }); await A.err('NOT_NEEDED'); ok('free refill is refused while you still have coins');

    A.q.length = 0; A.send({ t: 'ad_request' }); const ad = await A.wait((x) => x.t === 'ad_ok'); assert.match(ad.nonce, /^[0-9a-f]{16}$/);
    A.send({ t: 'ad_reward', nonce: ad.nonce }); await A.err('TOO_EARLY');
    await sleep(400); A.q.length = 0; A.send({ t: 'ad_reward', nonce: ad.nonce }); const ar = await A.wait((x) => x.t === 'reward'); assert.equal(ar.amount, 300);
    assert.equal((await A.wait((x) => x.t === 'me')).coins, 1400); ok('rewarded ad pays only after a real watch time');
    A.send({ t: 'ad_reward', nonce: ad.nonce }); await A.err('BAD_NONCE'); A.send({ t: 'ad_reward', nonce: 'nope' }); await A.err('BAD_NONCE'); ok('an ad reward cannot be replayed or invented');
    A.send({ t: 'ad_request' }); await A.err('NOT_READY'); await sleep(1300); A.send({ t: 'ad_request' }); await A.wait((x) => x.t === 'ad_ok'); ok('ads respect a cooldown between rewards');

    A.send({ t: 'register', username: 'a!', password: 'secret1' }); await A.err('BAD_USERNAME');
    A.send({ t: 'register', username: 'alice_pk', password: '123' }); await A.err('BAD_PASSWORD');
    A.q.length = 0; A.send({ t: 'register', username: 'Alice_PK', password: 'secret-pass-1' });
    const reg = await A.wait((x) => x.t === 'auth_ok'); assert.match(reg.recovery, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/); assert.equal(reg.username, 'alice_pk');
    assert.equal((await A.wait((x) => x.t === 'me')).registered, true);
    A.send({ t: 'register', username: 'other', password: 'secret-pass-2' }); await A.err('ALREADY_REGISTERED');
    const B = await new C('bob').open(); await B.hello('Bob');
    B.send({ t: 'register', username: 'ALICE_pk', password: 'secret-pass-3' }); await B.err('USERNAME_TAKEN'); ok('accounts: register with username + password; names are unique');
    await sleep(600);
    const disk = fs.readFileSync(path.join(DATA, 'friends.json'), 'utf8');
    assert.ok(!disk.includes('secret-pass-1') && !disk.includes(reg.recovery)); assert.ok(disk.includes('"pw":"')); ok('passwords and recovery codes are stored only as salted scrypt hashes');

    // login from a brand-new device brings back coins, rank and friend code
    const aliceCode = (await A.meNow()).code;
    const D2 = await new C('alice-phone2').open(); const g = await D2.hello('Player'); assert.equal(g.coins, 1000); assert.notEqual(g.code, aliceCode);
    D2.send({ t: 'login', username: 'alice_pk', password: 'wrong-pass' }); await D2.err('BAD_LOGIN');
    D2.q.length = 0; D2.send({ t: 'login', username: 'Alice_PK', password: 'secret-pass-1' });
    const li = await D2.wait((x) => x.t === 'auth_ok'); assert.equal(li.login, true);
    const back = await D2.wait((x) => x.t === 'me'); assert.equal(back.code, aliceCode); assert.equal(back.coins, 1400); assert.equal(back.username, 'alice_pk');
    const D2b = new C('alice-phone2'); await D2b.open(); const again = await D2b.hello('Whatever'); assert.equal(again.code, aliceCode); assert.equal(again.name, 'Alice'); ok('reinstall/new device: login restores the same coins, friend code and name');
    D2.send({ t: 'logout' }); await D2.wait((x) => x.t === 'logged_out'); D2.uid = 'uid-fresh-after-logout-0123456789'; const fresh = await D2.hello('Guest'); assert.notEqual(fresh.code, aliceCode); ok('logout returns the device to a fresh guest');

    // password reset with the recovery code
    const R = await new C('reset-dev').open(); await R.hello('R');
    R.send({ t: 'reset', username: 'alice_pk', recovery: 'AAAA-BBBB-CCCC', password: 'newpass-77' }); await R.err('BAD_RECOVERY');
    R.q.length = 0; R.send({ t: 'reset', username: 'alice_pk', recovery: reg.recovery.toLowerCase(), password: 'newpass-77' });
    const rs = await R.wait((x) => x.t === 'auth_ok'); assert.ok(rs.recovery && rs.recovery !== reg.recovery);
    const R2 = await new C('reset-dev2').open(); await R2.hello('R2'); R2.send({ t: 'login', username: 'alice_pk', password: 'secret-pass-1' }); await R2.err('BAD_LOGIN');
    R2.q.length = 0; R2.send({ t: 'login', username: 'alice_pk', password: 'newpass-77' }); await R2.wait((x) => x.t === 'auth_ok');
    R2.send({ t: 'reset', username: 'alice_pk', recovery: reg.recovery, password: 'newpass-88' }); await R2.err('BAD_RECOVERY'); ok('forgot password: the recovery code resets it once, then a new code is issued');
    const L = await new C('locker').open(); await L.hello('L');
    for (let i = 0; i < 5; i++) { L.send({ t: 'login', username: 'alice_pk', password: 'bad' + i }); await L.err('BAD_LOGIN'); }
    L.send({ t: 'login', username: 'alice_pk', password: 'newpass-77' }); await L.err('LOCKED'); ok('five wrong passwords lock the login for a minute');

    A.q.length = 0; A.send({ t: 'profile', name: 'Ali <b>X</b>', avatar: 5 }); let pm = await A.wait((x) => x.t === 'me'); assert.equal(pm.avatar, 5); assert.ok(!pm.name.includes('<'));
    A.send({ t: 'profile', avatar: 99 }); await sleep(100); assert.equal((await A.meNow()).avatar, 5); ok('profile: name and avatar can be changed; invalid avatars are ignored');

    // entry-fee table between two accounts
    const S1 = await new C('s1').open(), S2 = await new C('s2').open(); await S1.hello('Sana'); await S2.hello('Sami');
    S1.send({ t: 'create', pid: S1.uid, name: 'Sana' }); const rm = await S1.wait((x) => x.t === 'room');
    S2.send({ t: 'join', code: rm.code, pid: S2.uid, name: 'Sami' }); await S2.wait((x) => x.t === 'room');
    S2.send({ t: 'stake', amount: 100 }); await S2.err('NOT_HOST'); S1.send({ t: 'stake', amount: 7 }); await S1.err('BAD_STAKE');
    S2.q.length = 0; S1.send({ t: 'stake', amount: 100 }); assert.equal((await S2.wait((x) => x.t === 'room' && x.stake === 100)).stake, 100);
    const S1dup = await new C('s1').open(); await S1dup.hello('Sana'); S1dup.send({ t: 'join', code: rm.code, pid: 'another-pid-0123456789abc', name: 'Sana' }); await S1dup.err('DUPLICATE_ACCOUNT'); ok('host sets the entry fee; one account cannot take two seats');
    S1.q.length = 0; S2.q.length = 0; S1.send({ t: 'start' });
    await S1.wait((x) => x.t === 'state'); await S2.wait((x) => x.t === 'state');
    await sleep(200); assert.equal((await S1.meNow()).coins, 900); assert.equal((await S2.meNow()).coins, 900); ok('entry fee is taken from every player when the game starts');
    const byColor = {}; const players = [S1, S2];
    for (const p of players) { p.q.length = 0; }
    const result = {}; let seq = 0;
    const fin = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('game did not finish')), 90000);
      const act = (cl, st, legal) => {
        if (st.status === 'FINISHED') return;
        const seat = st.seats[st.turn]; const mine = (cl === S1 ? 'p1' : 'p2') === seat.playerId; if (!mine) return;
        if (st.phase === 'ROLL') cl.send({ t: 'roll', actionId: 'g' + (++seq), v: st.version }); else cl.send({ t: 'move', actionId: 'g' + (++seq), v: st.version, token: legal[legal.length - 1] });
      };
      for (const cl of players) {
        const prev = cl.ws.onmessage;
        cl.ws.onmessage = (e) => { prev(e); const x = JSON.parse(e.data); if (x.t === 'result') result[cl.n] = x; if (x.t === 'state') { if (x.state.status === 'FINISHED') { clearTimeout(to); res(x.state); } else act(cl, x.state, x.legal); } };
      }
      S1.send({ t: 'resync' });
    });
    await sleep(300);
    const winCl = fin.winner.playerId === 'p1' ? S1 : S2, loseCl = winCl === S1 ? S2 : S1;
    assert.equal(result[winCl.n].coins, 100); assert.equal(result[loseCl.n].coins, -100); assert.equal(result[winCl.n].trophies, 25); assert.equal(result[loseCl.n].trophies, 0);
    const wm = await winCl.meNow(), lm = await loseCl.meNow();
    assert.equal(wm.coins, 1100); assert.equal(lm.coins, 900); assert.equal(wm.wins, 1); assert.equal(wm.games, 1); assert.equal(lm.games, 1); assert.equal(wm.trophies, 25); ok('winner takes the pot, loser loses the entry, wins/games/trophies are recorded');
    winCl.q.length = 0; winCl.send({ t: 'board' }); const bd = await winCl.wait((x) => x.t === 'board'); assert.equal(bd.rows[0].you, true); assert.equal(bd.rows[0].trophies, 25); assert.equal(bd.myRank, 1); ok('leaderboard ranks players by trophies');

    // a player without enough coins cannot join a higher table
    for (const cl of [winCl, loseCl]) { cl.q.length = 0; cl.send({ t: 'leave' }); await cl.wait((x) => x.t === 'left'); }
    loseCl.send({ t: 'create', pid: loseCl.uid, name: 'Poor' }); const r2 = await loseCl.wait((x) => x.t === 'room');
    winCl.send({ t: 'join', code: r2.code, pid: winCl.uid, name: 'Rich' }); await winCl.wait((x) => x.t === 'room');
    loseCl.send({ t: 'stake', amount: 1000 }); await loseCl.wait((x) => x.t === 'room' && x.stake === 1000);
    loseCl.send({ t: 'start' }); const lc = await loseCl.wait((x) => x.t === 'error'); assert.equal(lc.code, 'LOW_COINS'); assert.ok(lc.names.length >= 1); ok('tables refuse players who cannot pay the entry fee');
    loseCl.send({ t: 'stake', amount: 0 }); await loseCl.wait((x) => x.t === 'room' && x.stake === 0);

    // everything survives a restart
    await sleep(700); srv.kill(); await sleep(300); srv = await startServer();
    const P = await new C('post-restart').open(); await P.hello('x'); P.q.length = 0; P.send({ t: 'login', username: 'alice_pk', password: 'newpass-77' });
    await P.wait((x) => x.t === 'auth_ok'); const pr = await P.wait((x) => x.t === 'me'); assert.equal(pr.coins, 1400 + 0); assert.equal(pr.avatar, 5); ok('accounts, coins and passwords survive a server restart');
    console.log(`\nALL ${done.length} ECONOMY CHECKS PASSED`);
  } catch (e) { console.error('\nFAILED:', e.message, '\n', (e.stack || '').split('\n').slice(1, 3).join('\n')); process.exitCode = 1; }
  finally { srv.kill(); process.exit(process.exitCode || 0); }
})();
