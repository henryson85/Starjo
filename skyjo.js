'use strict';
// Skyjo: Kartenspiel mit Lobby-Code, 2 bis 8 Spieler, jeder auf dem eigenen Handy.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_ROOMS = 300;
const TARGET = 100;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const AUTO_AFTER_MS = 12000; // so lange wartet das Spiel auf einen getrennten Spieler

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeDeck() {
  const d = [];
  const add = (v, n) => { for (let i = 0; i < n; i++) d.push(v); };
  add(-2, 5); add(-1, 10); add(0, 15);
  for (let v = 1; v <= 12; v++) add(v, 10);
  return shuffle(d);
}
function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function createSkyjo() {
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  function newCode() {
    for (let t = 0; t < 200; t++) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  function makeRoom(code) {
    return {
      code, createdAt: Date.now(), lastActive: Date.now(), phase: 'lobby',
      players: new Map(), order: [], host: null, nextId: 1, round: 0,
      deck: [], discard: [], turn: null, tphase: null, holding: null,
      finisher: null, result: null,
    };
  }
  function active(room) {
    return room.order.map((id) => room.players.get(id)).filter(Boolean);
  }
  function connectedPlayers(room) {
    return [...room.players.values()].filter((p) => p.connected && !p.left);
  }
  function ensureHost(room) {
    const h = room.players.get(room.host);
    if (h && h.connected && !h.left) return;
    const next = [...room.players.values()].find((p) => p.connected && !p.left);
    if (next) room.host = next.id;
  }
  function visibleSum(p) {
    return p.cards.reduce((s, c) => (c.s === 'up' ? s + c.v : s), 0);
  }
  function fullSum(p) {
    return p.cards.reduce((s, c) => (c.s === 'gone' ? s : s + c.v), 0);
  }

  // ---------- Ansicht je Spieler ----------
  function viewFor(room, pid) {
    const reveal = room.phase === 'roundEnd' || room.phase === 'final';
    const v = {
      phase: room.phase, code: room.code, you: pid, host: room.host, round: room.round,
      target: TARGET, minPlayers: MIN_PLAYERS, serverNow: Date.now(),
      players: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, connected: p.connected, left: p.left, total: p.total,
        inRound: room.order.includes(p.id),
        visible: room.phase === 'lobby' ? 0 : visibleSum(p),
        ups: p.cards.filter((c) => c.s === 'up').length,
        cards: p.cards.map((c) => (c.s === 'up' || (reveal && c.s !== 'gone') ? { s: 'up', v: c.v } : { s: c.s })),
      })),
      turn: room.turn, tphase: room.tphase, holding: room.holding,
      discardTop: room.discard.length ? room.discard[room.discard.length - 1] : null,
      deckCount: room.deck.length, finisher: room.finisher, result: room.result,
    };
    if (room.phase === 'final') {
      v.ranking = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, total: p.total }))
        .sort((a, b) => a.total - b.total);
    }
    return v;
  }
  function broadcast(room) {
    room.lastActive = Date.now();
    for (const p of room.players.values()) if (p.ws) send(p.ws, { t: 'state', state: viewFor(room, p.id) });
  }

  // ---------- Spielablauf ----------
  function startRound(room) {
    room.order = [...room.players.values()].filter((p) => !p.left).map((p) => p.id);
    room.deck = makeDeck();
    for (const p of active(room)) {
      p.cards = [];
      for (let i = 0; i < 12; i++) p.cards.push({ v: room.deck.pop(), s: 'down' });
    }
    room.discard = [room.deck.pop()];
    room.round += 1;
    room.phase = 'setup';
    room.turn = null; room.tphase = null; room.holding = null; room.finisher = null; room.result = null;
  }
  function beginPlay(room) {
    let best = null;
    for (const p of active(room)) if (!best || visibleSum(p) > visibleSum(best)) best = p;
    room.phase = 'play';
    room.turn = best.id;
    room.tphase = 'choose';
    room.holding = null;
  }
  function drawFromDeck(room) {
    if (!room.deck.length) {
      const top = room.discard.pop();
      room.deck = shuffle(room.discard);
      room.discard = top === undefined ? [] : [top];
    }
    return room.deck.pop();
  }
  function removeColumns(room, p) {
    for (let col = 0; col < 4; col++) {
      const a = p.cards[col], b = p.cards[col + 4], c = p.cards[col + 8];
      if (a.s === 'up' && b.s === 'up' && c.s === 'up' && a.v === b.v && b.v === c.v) {
        room.discard.push(a.v, b.v, c.v);
        a.s = b.s = c.s = 'gone';
      }
    }
  }
  function nextActive(room, pid) {
    const i = room.order.indexOf(pid);
    return room.order[(i + 1) % room.order.length];
  }
  function endTurn(room) {
    const p = room.players.get(room.turn);
    removeColumns(room, p);
    if (room.finisher == null && p.cards.every((c) => c.s !== 'down')) room.finisher = p.id;
    const next = nextActive(room, p.id);
    if (room.finisher != null && next === room.finisher) return endRound(room);
    room.turn = next;
    room.tphase = 'choose';
    room.holding = null;
  }
  function endRound(room) {
    for (const p of active(room)) for (const c of p.cards) if (c.s === 'down') c.s = 'up';
    const sums = new Map(active(room).map((p) => [p.id, fullSum(p)]));
    const rows = [];
    for (const p of active(room)) {
      let pts = sums.get(p.id);
      let doubled = false;
      if (p.id === room.finisher && pts > 0) {
        const lower = active(room).every((o) => o.id === p.id || sums.get(o.id) > pts);
        if (!lower) { pts *= 2; doubled = true; }
      }
      p.total += pts;
      rows.push({ id: p.id, name: p.name, points: pts, doubled, total: p.total });
    }
    room.result = { rows, finisher: room.finisher };
    room.turn = null; room.tphase = null; room.holding = null;
    room.phase = [...room.players.values()].some((p) => p.total >= TARGET) ? 'final' : 'roundEnd';
  }

  // Aktionen eines Spielers (auch vom Autopiloten genutzt)
  function doFlipSetup(room, p, i) {
    if (room.phase !== 'setup' || p.cards[i].s !== 'down') return false;
    if (p.cards.filter((c) => c.s === 'up').length >= 2) return false;
    p.cards[i].s = 'up';
    if (active(room).every((q) => q.cards.filter((c) => c.s === 'up').length >= 2)) beginPlay(room);
    return true;
  }
  function doDraw(room, p) {
    if (room.phase !== 'play' || room.turn !== p.id || room.tphase !== 'choose') return false;
    room.holding = drawFromDeck(room);
    room.tphase = 'holdDeck';
    return true;
  }
  function doTake(room, p) {
    if (room.phase !== 'play' || room.turn !== p.id || room.tphase !== 'choose' || !room.discard.length) return false;
    room.holding = room.discard.pop();
    room.tphase = 'holdDiscard';
    return true;
  }
  function doPlace(room, p, i) {
    if (room.phase !== 'play' || room.turn !== p.id) return false;
    if (room.tphase !== 'holdDeck' && room.tphase !== 'holdDiscard') return false;
    const c = p.cards[i];
    if (!c || c.s === 'gone') return false;
    room.discard.push(c.v);
    c.v = room.holding; c.s = 'up';
    room.holding = null;
    endTurn(room);
    return true;
  }
  function doDiscardHeld(room, p) {
    if (room.phase !== 'play' || room.turn !== p.id || room.tphase !== 'holdDeck') return false;
    if (!p.cards.some((c) => c.s === 'down')) return false;
    room.discard.push(room.holding);
    room.holding = null;
    room.tphase = 'mustFlip';
    return true;
  }
  function doFlipTurn(room, p, i) {
    if (room.phase !== 'play' || room.turn !== p.id || room.tphase !== 'mustFlip') return false;
    if (!p.cards[i] || p.cards[i].s !== 'down') return false;
    p.cards[i].s = 'up';
    endTurn(room);
    return true;
  }

  // Autopilot für getrennte oder ausgestiegene Spieler, damit das Spiel nie hängt
  function autoStep(room) {
    const now = Date.now();
    const away = (p) => p.left || (!p.connected && now - p.lastSeen > AUTO_AFTER_MS);
    let changed = false;
    if (room.phase === 'setup') {
      for (const p of active(room)) {
        if (!away(p)) continue;
        while (room.phase === 'setup' && p.cards.filter((c) => c.s === 'up').length < 2) {
          const downs = p.cards.map((c, i) => (c.s === 'down' ? i : -1)).filter((i) => i >= 0);
          if (!downs.length || !doFlipSetup(room, p, downs[crypto.randomInt(downs.length)])) break;
          changed = true;
        }
      }
    } else if (room.phase === 'play') {
      const p = room.players.get(room.turn);
      if (p && away(p)) {
        if (room.tphase === 'choose') doDraw(room, p);
        if (room.tphase === 'holdDeck' || room.tphase === 'holdDiscard') {
          const downs = p.cards.map((c, i) => (c.s === 'down' ? i : -1)).filter((i) => i >= 0);
          if (room.tphase === 'holdDeck' && downs.length) doDiscardHeld(room, p);
          else {
            let idx = -1;
            for (let i = 0; i < 12; i++) if (p.cards[i].s !== 'gone' && (idx < 0 || p.cards[i].v > p.cards[idx].v)) idx = i;
            doPlace(room, p, idx);
          }
        }
        if (room.phase === 'play' && room.turn === p.id && room.tphase === 'mustFlip') {
          const downs = p.cards.map((c, i) => (c.s === 'down' ? i : -1)).filter((i) => i >= 0);
          doFlipTurn(room, p, downs[crypto.randomInt(downs.length)]);
        }
        changed = true;
      }
    }
    if (changed) broadcast(room);
  }

  // ---------- Nachrichten ----------
  function addPlayer(room, name, ws) {
    const id = 'p' + room.nextId++;
    const p = {
      id, name, token: crypto.randomBytes(12).toString('hex'), ws, connected: true, left: false,
      lastSeen: Date.now(), cards: [], total: 0,
    };
    room.players.set(id, p);
    return p;
  }
  function attachCtx(ws, room, p) {
    ws.ctx = { code: room.code, pid: p.id };
    send(ws, { t: 'joined', code: room.code, pid: p.id, token: p.token });
  }
  const err = (ws, msg) => send(ws, { t: 'error', msg });

  function handle(ws, msg) {
    const t = msg.t;
    if (t === 'create') {
      if (rooms.size >= MAX_ROOMS) return err(ws, 'Gerade ist alles belegt. Versuch es gleich nochmal.');
      const name = cleanName(msg.name);
      if (!name) return err(ws, 'Gib dir einen Namen.');
      const code = newCode();
      if (!code) return err(ws, 'Kein freier Code. Versuch es nochmal.');
      const room = makeRoom(code);
      rooms.set(code, room);
      const p = addPlayer(room, name, ws);
      room.host = p.id;
      attachCtx(ws, room, p);
      return broadcast(room);
    }
    if (t === 'join') {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return err(ws, 'Diese Lobby gibt es nicht.');
      const name = cleanName(msg.name);
      if (!name) return err(ws, 'Gib dir einen Namen.');
      if (room.phase !== 'lobby') return err(ws, 'Das Spiel läuft schon.');
      if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return err(ws, 'Der Name ist schon vergeben.');
      if (room.players.size >= MAX_PLAYERS) return err(ws, 'Die Lobby ist voll (maximal 8).');
      const p = addPlayer(room, name, ws);
      attachCtx(ws, room, p);
      return broadcast(room);
    }
    if (t === 'rejoin') {
      const room = rooms.get(String(msg.code || '').toUpperCase());
      const p = room && room.players.get(String(msg.pid));
      if (!p || p.left || p.token !== msg.token) return send(ws, { t: 'rejoin_failed' });
      if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch (e) { /* weg */ } }
      p.ws = ws; p.connected = true;
      ws.ctx = { code: room.code, pid: p.id };
      send(ws, { t: 'joined', code: room.code, pid: p.id, token: p.token });
      ensureHost(room);
      return broadcast(room);
    }
    const ctx = ws.ctx;
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    const me = room && room.players.get(ctx.pid);
    if (!me) return;
    const isHost = room.host === me.id;

    if (t === 'start') {
      if (!isHost || room.phase !== 'lobby') return;
      if (connectedPlayers(room).length < MIN_PLAYERS) return err(ws, `Ihr braucht mindestens ${MIN_PLAYERS} Spieler.`);
      for (const p of room.players.values()) { p.total = 0; }
      room.round = 0;
      startRound(room);
      return broadcast(room);
    }
    if (t === 'flip') {
      const i = Number(msg.i);
      if (!Number.isInteger(i) || i < 0 || i > 11) return;
      const ok = room.phase === 'setup' ? doFlipSetup(room, me, i) : doFlipTurn(room, me, i);
      if (ok) broadcast(room);
      return;
    }
    if (t === 'draw') { if (doDraw(room, me)) broadcast(room); return; }
    if (t === 'take') { if (doTake(room, me)) broadcast(room); return; }
    if (t === 'discard') { if (doDiscardHeld(room, me)) broadcast(room); return; }
    if (t === 'place') {
      const i = Number(msg.i);
      if (!Number.isInteger(i) || i < 0 || i > 11) return;
      if (doPlace(room, me, i)) broadcast(room);
      return;
    }
    if (t === 'next') {
      if (!isHost || room.phase !== 'roundEnd') return;
      if (active(room).filter((p) => !p.left).length < 1) return;
      startRound(room);
      return broadcast(room);
    }
    if (t === 'again') {
      if (!isHost || room.phase !== 'final') return;
      for (const p of [...room.players.values()]) { if (p.left || !p.connected) room.players.delete(p.id); else p.total = 0; }
      room.order = []; room.round = 0; room.phase = 'lobby'; room.result = null;
      ensureHost(room);
      return broadcast(room);
    }
    if (t === 'leave') {
      ws.ctx = null;
      me.ws = null; me.connected = false;
      if (room.phase === 'lobby' || room.phase === 'final') room.players.delete(me.id);
      else me.left = true;
      ensureHost(room);
      broadcast(room);
      return;
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true; ws.ctx = null; ws.hits = 0;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      if (++ws.hits > 40) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      try { handle(ws, msg); } catch (e) { console.error('Skyjo-Fehler:', e); }
    });
    ws.on('close', () => {
      const ctx = ws.ctx;
      if (!ctx) return;
      const room = rooms.get(ctx.code);
      const p = room && room.players.get(ctx.pid);
      if (!p || p.ws !== ws) return;
      p.ws = null; p.connected = false; p.lastSeen = Date.now();
      ensureHost(room);
      broadcast(room);
    });
    ws.on('error', () => {});
  });

  const tick = setInterval(() => { for (const ws of wss.clients) ws.hits = 0; }, 1000);
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* weg */ }
    }
  }, 25000);
  const auto = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyone = connectedPlayers(room).length > 0;
      if ((!anyone && now - room.lastActive > 10 * 60 * 1000) || now - room.createdAt > 8 * 3600 * 1000) { rooms.delete(code); continue; }
      try { autoStep(room); } catch (e) { console.error('Skyjo-Auto:', e); }
      if (room.phase === 'lobby') {
        let changed = false;
        for (const p of [...room.players.values()]) {
          if (!p.connected && now - p.lastSeen > 3 * 60 * 1000) { room.players.delete(p.id); changed = true; }
        }
        if (changed) { ensureHost(room); broadcast(room); }
      }
    }
  }, 2000);

  function dispose() {
    clearInterval(tick); clearInterval(beat); clearInterval(auto);
    for (const ws of wss.clients) ws.terminate();
    rooms.clear();
  }
  return { wss, rooms, dispose };
}

module.exports = { createSkyjo };
