'use strict';
// Schwindler: Bluff-Partyspiel mit Lobby-Code. Alle spielen auf dem eigenen Handy.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const CATEGORIES = [...new Set(QUESTIONS.map((q) => q.cat))];
const INDEX_FILE = path.join(__dirname, 'index.html');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const MAX_ROOMS = 500;
const REVEAL_AUTO_MS = 45000;
const POINTS_TRUTH = 1000;
const POINTS_FOOLED = 500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const rooms = new Map();

// ---------- Hilfsfunktionen ----------
function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function clamp(n, lo, hi) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
function cleanText(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- Räume ----------
function makeRoom(code) {
  return {
    code,
    hostId: null,
    players: new Map(),
    nextId: 1,
    phase: 'lobby',
    settings: { rounds: 6, writeSecs: 60, voteSecs: 30, cats: CATEGORIES.slice() },
    deck: [],
    idx: -1,
    q: null,
    lies: new Map(),
    options: [],
    votes: new Map(),
    reveal: null,
    endsAt: 0,
    timer: null,
    lastActive: Date.now(),
    createdAt: Date.now(),
  };
}

function addPlayer(room, name, ws) {
  const p = { id: 'p' + room.nextId++, token: crypto.randomBytes(12).toString('hex'), name, score: 0, ws, connected: true, left: false, lastSeen: Date.now() };
  room.players.set(p.id, p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}
function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected && !p.left);
}
function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected && !host.left) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

function view(room, me) {
  const inGame = room.phase === 'write' || room.phase === 'vote';
  const v = {
    code: room.code,
    you: me.id,
    host: room.hostId,
    phase: room.phase,
    serverNow: Date.now(),
    endsAt: room.endsAt,
    settings: room.settings,
    allCats: CATEGORIES,
    minPlayers: MIN_PLAYERS,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected && !p.left,
      done: room.phase === 'write' ? room.lies.has(p.id) : room.phase === 'vote' ? room.votes.has(p.id) : false,
    })),
  };
  if (inGame || room.phase === 'reveal') {
    v.round = { n: room.idx + 1, total: room.deck.length, cat: room.q.cat, q: room.q.q };
  }
  if (room.phase === 'write') {
    v.mySubmitted = room.lies.has(me.id);
    v.myLie = room.lies.get(me.id) || '';
  }
  if (room.phase === 'vote') {
    v.options = room.options.map((o) => ({ id: o.id, text: o.text, mine: o.authors.includes(me.id) }));
    v.myVote = room.votes.get(me.id) || null;
  }
  if (room.phase === 'reveal') v.reveal = room.reveal;
  if (room.phase === 'final') {
    v.ranking = [...room.players.values()].sort((a, b) => b.score - a.score).map((p) => ({ id: p.id, name: p.name, score: p.score }));
  }
  return v;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.ws) send(p.ws, { t: 'state', state: view(room, p) });
  }
}

function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.endsAt = Date.now() + ms;
  room.timer = setTimeout(() => {
    room.timer = null;
    fn();
    broadcast(room);
  }, ms);
}
function clearTimer(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.endsAt = 0;
}

// ---------- Spielablauf ----------
function startGame(room) {
  const cats = new Set(room.settings.cats);
  const pool = QUESTIONS.filter((q) => cats.has(q.cat));
  const rounds = Math.min(room.settings.rounds, pool.length);
  room.deck = shuffle(pool).slice(0, rounds);
  room.idx = -1;
  for (const p of room.players.values()) p.score = 0;
  nextRound(room);
}

function nextRound(room) {
  room.idx++;
  if (room.idx >= room.deck.length) {
    room.phase = 'final';
    clearTimer(room);
    return;
  }
  room.q = room.deck[room.idx];
  room.lies = new Map();
  room.votes = new Map();
  room.options = [];
  room.reveal = null;
  room.phase = 'write';
  setTimer(room, room.settings.writeSecs * 1000, () => endWrite(room));
}

function isTruth(q, text) {
  const n = norm(text);
  if (!n) return false;
  return [q.a, ...(q.alt || [])].some((x) => norm(x) === n);
}

function endWrite(room) {
  if (room.phase !== 'write') return;
  const q = room.q;
  const opts = new Map();
  const decoys = shuffle(q.decoys);
  const addOpt = (text, author, truth) => {
    const key = truth ? '__truth__' : norm(text);
    if (!key) return;
    if (opts.has(key)) {
      if (author && !opts.get(key).authors.includes(author)) opts.get(key).authors.push(author);
      return;
    }
    opts.set(key, { text, authors: author ? [author] : [], isTruth: !!truth });
  };
  addOpt(q.a, null, true);
  for (const p of room.players.values()) {
    if (p.left || !p.connected) continue;
    const lie = room.lies.get(p.id);
    if (lie) addOpt(lie, p.id, false);
  }
  // Spieler ohne eigene Antwort bekommen einen Köder des Spiels
  const lieAuthors = new Set([...opts.values()].flatMap((o) => o.authors));
  let d = 0;
  for (const p of room.players.values()) {
    if (p.left || !p.connected || lieAuthors.has(p.id)) continue;
    if (d < decoys.length) addOpt(decoys[d++], null, false);
  }
  while (opts.size < 5 && d < decoys.length) addOpt(decoys[d++], null, false);
  room.options = shuffle([...opts.values()]).map((o, i) => ({ id: 'o' + i, ...o }));
  room.votes = new Map();
  room.phase = 'vote';
  setTimer(room, room.settings.voteSecs * 1000, () => endVote(room));
}

function endVote(room) {
  if (room.phase !== 'vote') return;
  const gains = {};
  for (const p of room.players.values()) gains[p.id] = 0;
  const voters = new Map(room.options.map((o) => [o.id, []]));
  for (const [voterId, optId] of room.votes) {
    const o = room.options.find((x) => x.id === optId);
    if (!o) continue;
    voters.get(optId).push(voterId);
    if (o.isTruth) gains[voterId] += POINTS_TRUTH;
    else for (const a of o.authors) if (a !== voterId) gains[a] += POINTS_FOOLED;
  }
  for (const p of room.players.values()) p.score += gains[p.id] || 0;
  const name = (id) => (room.players.get(id) || { name: '?' }).name;
  room.reveal = {
    truth: room.q.a,
    options: room.options.map((o) => ({
      id: o.id,
      text: o.text,
      isTruth: o.isTruth,
      authors: o.authors.map(name),
      byGame: !o.isTruth && o.authors.length === 0,
      voters: voters.get(o.id).map(name),
    })),
    gains,
    last: room.idx === room.deck.length - 1,
  };
  room.phase = 'reveal';
  setTimer(room, REVEAL_AUTO_MS, () => nextRound(room));
}

function maybeAdvance(room) {
  const alive = connectedPlayers(room);
  if (!alive.length) return;
  if (room.phase === 'write' && alive.every((p) => room.lies.has(p.id))) {
    clearTimer(room);
    endWrite(room);
  } else if (room.phase === 'vote' && alive.every((p) => room.votes.has(p.id))) {
    clearTimer(room);
    endVote(room);
  }
}

// ---------- Nachrichten ----------
function handle(ws, msg) {
  const ctx = ws.ctx;
  const t = msg && msg.t;
  if (t === 'create') {
    if (ctx) return send(ws, { t: 'error', msg: 'Du bist schon in einer Lobby.' });
    const name = cleanName(msg.name);
    if (!name) return send(ws, { t: 'error', msg: 'Bitte gib einen Namen ein.' });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Gerade sind zu viele Lobbys offen. Versuch es später nochmal.' });
    const code = newCode();
    const room = makeRoom(code);
    rooms.set(code, room);
    const p = addPlayer(room, name, ws);
    ws.ctx = { code, pid: p.id };
    send(ws, { t: 'joined', code, pid: p.id, token: p.token });
    return broadcast(room);
  }
  if (t === 'join') {
    if (ctx) return send(ws, { t: 'error', msg: 'Du bist schon in einer Lobby.' });
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const name = cleanName(msg.name);
    if (!name) return send(ws, { t: 'error', msg: 'Bitte gib einen Namen ein.' });
    const room = rooms.get(code);
    if (!room) return send(ws, { t: 'error', msg: 'Diese Lobby gibt es nicht. Prüf den Code.' });
    if (room.phase !== 'lobby' && room.phase !== 'final') return send(ws, { t: 'error', msg: 'Das Spiel läuft schon. Warte auf die nächste Runde.' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Die Lobby ist voll.' });
    for (const x of room.players.values()) {
      if (!x.left && norm(x.name) === norm(name)) return send(ws, { t: 'error', msg: 'Der Name ist schon vergeben.' });
    }
    const p = addPlayer(room, name, ws);
    ws.ctx = { code, pid: p.id };
    room.lastActive = Date.now();
    send(ws, { t: 'joined', code, pid: p.id, token: p.token });
    return broadcast(room);
  }
  if (t === 'rejoin') {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const p = room && room.players.get(String(msg.pid || ''));
    if (!p || p.left || p.token !== msg.token) return send(ws, { t: 'rejoin_failed' });
    if (p.ws && p.ws !== ws) {
      p.ws.ctx = null;
      try { p.ws.close(); } catch (e) { /* schon zu */ }
    }
    p.ws = ws;
    p.connected = true;
    p.lastSeen = Date.now();
    ws.ctx = { code: room.code, pid: p.id };
    ensureHost(room);
    room.lastActive = Date.now();
    send(ws, { t: 'joined', code: room.code, pid: p.id, token: p.token });
    return broadcast(room);
  }

  if (!ctx) return;
  const room = rooms.get(ctx.code);
  const me = room && room.players.get(ctx.pid);
  if (!room || !me) return;
  room.lastActive = Date.now();
  const isHost = room.hostId === me.id;

  if (t === 'settings') {
    if (!isHost || room.phase !== 'lobby') return;
    const s = room.settings;
    if (msg.rounds !== undefined) s.rounds = clamp(msg.rounds, 3, 15);
    if (msg.writeSecs !== undefined) s.writeSecs = clamp(msg.writeSecs, 20, 120);
    if (msg.voteSecs !== undefined) s.voteSecs = clamp(msg.voteSecs, 15, 60);
    if (Array.isArray(msg.cats)) {
      const cats = msg.cats.filter((c) => CATEGORIES.includes(c));
      if (cats.length) s.cats = CATEGORIES.filter((c) => cats.includes(c));
    }
    return broadcast(room);
  }
  if (t === 'start') {
    if (!isHost || room.phase !== 'lobby') return;
    if (connectedPlayers(room).length < MIN_PLAYERS) return send(ws, { t: 'error', msg: `Ihr braucht mindestens ${MIN_PLAYERS} Spieler.` });
    // Wer nicht mehr verbunden ist, fliegt vor dem Start raus.
    for (const p of [...room.players.values()]) if (!p.connected || p.left) room.players.delete(p.id);
    startGame(room);
    return broadcast(room);
  }
  if (t === 'answer') {
    if (room.phase !== 'write' || room.lies.has(me.id)) return;
    const text = cleanText(msg.text);
    if (!text || !norm(text)) return send(ws, { t: 'error', msg: 'Schreib eine Antwort.' });
    if (isTruth(room.q, text)) return send(ws, { t: 'error', msg: 'Das ist die richtige Antwort! Denk dir was anderes aus.', code: 'truth' });
    room.lies.set(me.id, text);
    maybeAdvance(room);
    return broadcast(room);
  }
  if (t === 'vote') {
    if (room.phase !== 'vote' || room.votes.has(me.id)) return;
    const o = room.options.find((x) => x.id === msg.option);
    if (!o) return;
    if (o.authors.includes(me.id)) return send(ws, { t: 'error', msg: 'Das ist deine eigene Antwort.' });
    room.votes.set(me.id, o.id);
    maybeAdvance(room);
    return broadcast(room);
  }
  if (t === 'next') {
    if (!isHost || room.phase !== 'reveal') return;
    clearTimer(room);
    nextRound(room);
    return broadcast(room);
  }
  if (t === 'again') {
    if (!isHost || room.phase !== 'final') return;
    room.phase = 'lobby';
    room.idx = -1;
    room.deck = [];
    for (const p of room.players.values()) p.score = 0;
    for (const p of [...room.players.values()]) if (!p.connected || p.left) room.players.delete(p.id);
    return broadcast(room);
  }
  if (t === 'leave') {
    ws.ctx = null;
    me.ws = null;
    me.connected = false;
    if (room.phase === 'lobby' || room.phase === 'final') room.players.delete(me.id);
    else me.left = true;
    ensureHost(room);
    maybeAdvance(room);
    return broadcast(room);
  }
}

// ---------- Server ----------
function createServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    // Es werden nur die beiden Spielseiten ausgeliefert, nie der Server-Code oder die Fragen.
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Seite fehlt');
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  server.on('upgrade', (req, socket, head) => {
    let p = '';
    try { p = new URL(req.url, 'http://x').pathname; } catch (e) { /* ungueltig */ }
    const target = p === '/ws' ? wss : null;
    if (!target) { socket.destroy(); return; }
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.ctx = null;
    ws.hits = 0;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      if (++ws.hits > 40) return; // einfacher Schutz vor Spam, Zähler wird jede Sekunde zurückgesetzt
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      try { handle(ws, msg); } catch (e) { console.error('Fehler in handle:', e); }
    });
    ws.on('close', () => {
      const ctx = ws.ctx;
      if (!ctx) return;
      const room = rooms.get(ctx.code);
      const p = room && room.players.get(ctx.pid);
      if (!p || p.ws !== ws) return;
      p.ws = null;
      p.connected = false;
      p.lastSeen = Date.now();
      ensureHost(room);
      maybeAdvance(room);
      broadcast(room);
    });
    ws.on('error', () => {});
  });

  const tick = setInterval(() => {
    for (const ws of wss.clients) {
      ws.hits = 0;
    }
  }, 1000);
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* weg */ }
    }
  }, 25000);
  const clean = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyone = connectedPlayers(room).length > 0;
      if ((!anyone && now - room.lastActive > 10 * 60 * 1000) || now - room.createdAt > 8 * 3600 * 1000) {
        clearTimeout(room.timer);
        rooms.delete(code);
        continue;
      }
      if (room.phase === 'lobby') {
        let changed = false;
        for (const p of [...room.players.values()]) {
          if (!p.connected && now - p.lastSeen > 3 * 60 * 1000) { room.players.delete(p.id); changed = true; }
        }
        if (changed) { ensureHost(room); broadcast(room); }
      }
    }
  }, 60000);
  server.on('close', () => { clearInterval(tick); clearInterval(beat); clearInterval(clean); for (const r of rooms.values()) clearTimeout(r.timer); rooms.clear(); });
  return server;
}

module.exports = { createServer, rooms };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`Schwindler läuft auf http://localhost:${port}`));
}
