// GOMOKU PROTOCOL SERVER
// 零依赖 Node.js (>=14) HTTP + Server-Sent Events 实现
// 启动:  node server.js
//
// 配置 (环境变量):
//   PORT=8080
//   MAX_ROOMS=16                  // 同时存在的房间总数
//   MAX_CLIENTS=100                // 全局并发连接数
//   MAX_SPECTATORS_PER_ROOM=10     // 单房间观战上限
//   ROOM_IDLE_TTL_MS=1800000       // 自定义房间空闲回收 (默认 30 min)
//
// 玩家身份:    通过 handle 识别，持久化到 players.json
// 分数体系:    胜 +10 (+连胜 +速胜)；负 -5
// 排行榜:      Top 10 全局，随快照广播
// 房间:        默认 OPEN 永不回收；自定义房间空闲超时回收

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── 配置 ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
const N = 15;
const RECONNECT_GRACE_MS = 15000;
const RECORDS_FILE = path.join(__dirname, 'players.json');
const LEADERBOARD_SIZE = 10;

const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '16', 10);
const MAX_CLIENTS = parseInt(process.env.MAX_CLIENTS || '100', 10);
const MAX_SPECTATORS_PER_ROOM = parseInt(process.env.MAX_SPECTATORS_PER_ROOM || '10', 10);
const ROOM_IDLE_TTL_MS = parseInt(process.env.ROOM_IDLE_TTL_MS || (30 * 60 * 1000), 10);
const DEFAULT_ROOM = 'OPEN';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉 I O
const ROOM_CODE_RE = /^[A-Z0-9]{2,8}$/;

const SCORE = {
  WIN_BASE: 10,
  LOSS: -5,
  STREAK_PER_WIN: 2,
  STREAK_MAX: 10,
  QUICK_WIN_BONUS: 5,
  QUICK_WIN_MOVES: 18,
};

// ─── 持久化 ────────────────────────────────────────────
let records = loadRecords();

function loadRecords() {
  try { return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8')); }
  catch { return {}; }
}

let saveTimer = null;
function saveRecords() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2)); }
    catch (e) { console.error('save failed:', e.message); }
  }, 50);
}

// ─── 房间 & 客户端 ─────────────────────────────────────
const rooms = new Map();     // code -> Room
const clients = [];          // { sessionId, nameKey, roomCode, res }

function createGameState() {
  return {
    board: Array.from({ length: N }, () => Array(N).fill(0)),
    current: 1,
    history: [],
    finished: false,
    winLine: null,
    gameStartTime: null,
  };
}

function createRoom(code, isDefault = false) {
  return {
    code,
    isDefault,
    state: createGameState(),
    players: [null, null],
    disconnects: Object.create(null),
    lastActivity: Date.now(),
    createdAt: Date.now(),
  };
}

function ensureDefaultRoom() {
  if (!rooms.has(DEFAULT_ROOM)) {
    rooms.set(DEFAULT_ROOM, createRoom(DEFAULT_ROOM, true));
  }
  return rooms.get(DEFAULT_ROOM);
}

function getRoom(code) { return rooms.get(code); }

function generateRoomCode() {
  for (let i = 0; i < 20; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) {
      c += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (c !== DEFAULT_ROOM && !rooms.has(c)) return c;
  }
  return null;
}

function getOrCreateRoom(code) {
  if (!code || !ROOM_CODE_RE.test(code)) code = DEFAULT_ROOM;
  if (rooms.has(code)) return { ok: true, room: rooms.get(code) };
  if (code === DEFAULT_ROOM) {
    return { ok: true, room: ensureDefaultRoom() };
  }
  if (rooms.size >= MAX_ROOMS) {
    return { ok: false, err: 'MAX_ROOMS_REACHED' };
  }
  const room = createRoom(code, false);
  rooms.set(code, room);
  return { ok: true, room, created: true };
}

function roomClients(code) { return clients.filter(c => c.roomCode === code); }
function roomSpectatorCount(code) {
  const room = rooms.get(code);
  if (!room) return 0;
  return roomClients(code).filter(c => roleInRoom(room, c.nameKey) === 'spectator').length;
}

function roleInRoom(room, key) {
  if (!room || !key) return 'spectator';
  if (room.players[0] === key) return 'p1';
  if (room.players[1] === key) return 'p2';
  return 'spectator';
}

function roleByClient(c) {
  const room = rooms.get(c.roomCode);
  return roleInRoom(room, c.nameKey);
}

function getRoleBySession(sessionId) {
  const c = clients.find(c => c.sessionId === sessionId);
  if (!c) return { role: 'spectator', room: null, client: null };
  return { role: roleByClient(c), room: rooms.get(c.roomCode), client: c };
}

function keyHasActiveClientInRoom(key, code) {
  return clients.some(c => c.nameKey === key && c.roomCode === code);
}

function assignSlot(room, key) {
  if (room.disconnects[key]) delete room.disconnects[key];
  const existing = roleInRoom(room, key);
  if (existing !== 'spectator') return existing;
  if (!room.players[0]) { room.players[0] = key; return 'p1'; }
  if (!room.players[1]) { room.players[1] = key; return 'p2'; }
  return 'spectator';
}

function scheduleSlotRelease(roomCode, key) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.disconnects[key] = Date.now();
  setTimeout(() => {
    const r = rooms.get(roomCode);
    if (!r) return;
    const ts = r.disconnects[key];
    if (!ts) return;
    if (Date.now() - ts < RECONNECT_GRACE_MS) return;
    if (keyHasActiveClientInRoom(key, roomCode)) return;
    if (r.players[0] === key) r.players[0] = null;
    if (r.players[1] === key) r.players[1] = null;
    delete r.disconnects[key];
    broadcastRoom(roomCode);
  }, RECONNECT_GRACE_MS + 200);
}

// ─── 玩家档案 ─────────────────────────────────────────
function nameKey(name) { return String(name || '').trim().toLowerCase(); }

function validateName(name) {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (t.length < 2 || t.length > 16) return false;
  return /^[A-Za-z0-9_\-·一-龥]+$/.test(t);
}

function ensureRecord(key, displayName) {
  if (!records[key]) {
    records[key] = {
      name: displayName,
      score: 0, wins: 0, losses: 0,
      streak: 0, bestStreak: 0, totalGames: 0,
      lastSeen: Date.now(), createdAt: Date.now(),
    };
  } else {
    if (displayName) records[key].name = displayName;
    records[key].lastSeen = Date.now();
  }
  return records[key];
}

function publicRecord(key) {
  const r = records[key];
  if (!r) return null;
  return {
    name: r.name, key,
    score: r.score, wins: r.wins, losses: r.losses,
    streak: r.streak, bestStreak: r.bestStreak, games: r.totalGames,
  };
}

// ─── 胜负 ─────────────────────────────────────────────
function inBounds(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

function checkWin(board, r, c, p) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const line = [{ r, c }];
    let i = 1;
    while (inBounds(r + dr * i, c + dc * i) && board[r + dr * i][c + dc * i] === p) {
      line.push({ r: r + dr * i, c: c + dc * i }); i++;
    }
    i = 1;
    while (inBounds(r - dr * i, c - dc * i) && board[r - dr * i][c - dc * i] === p) {
      line.unshift({ r: r - dr * i, c: c - dc * i }); i++;
    }
    if (line.length >= 5) return [line[0], line[line.length - 1]];
  }
  return null;
}

// ─── 分数结算 ─────────────────────────────────────────
function settleScores(winnerKey, loserKey, moveCount) {
  const ev = { winner: null, loser: null };
  if (winnerKey) {
    const w = ensureRecord(winnerKey, records[winnerKey]?.name || winnerKey);
    w.streak = (w.streak || 0) + 1;
    if (w.streak > (w.bestStreak || 0)) w.bestStreak = w.streak;
    const streakBonus = Math.min((w.streak - 1) * SCORE.STREAK_PER_WIN, SCORE.STREAK_MAX);
    const quickBonus = moveCount <= SCORE.QUICK_WIN_MOVES ? SCORE.QUICK_WIN_BONUS : 0;
    const delta = SCORE.WIN_BASE + streakBonus + quickBonus;
    w.score += delta;
    w.wins += 1;
    w.totalGames += 1;
    w.lastSeen = Date.now();
    ev.winner = { name: w.name, key: winnerKey, delta, base: SCORE.WIN_BASE, streakBonus, quickBonus, streak: w.streak, score: w.score };
  }
  if (loserKey) {
    const l = ensureRecord(loserKey, records[loserKey]?.name || loserKey);
    l.streak = 0;
    l.score += SCORE.LOSS;
    l.losses += 1;
    l.totalGames += 1;
    l.lastSeen = Date.now();
    ev.loser = { name: l.name, key: loserKey, delta: SCORE.LOSS, score: l.score };
  }
  saveRecords();
  return ev;
}

// ─── 排行榜 ──────────────────────────────────────────
function leaderboard() {
  const onlineKeys = new Set(clients.map(c => c.nameKey));
  return Object.entries(records)
    .map(([key, r]) => ({
      key, name: r.name,
      score: r.score, wins: r.wins, losses: r.losses,
      games: r.totalGames,
      winRate: r.totalGames ? r.wins / r.totalGames : 0,
      streak: r.streak, bestStreak: r.bestStreak,
      lastSeen: r.lastSeen,
      online: onlineKeys.has(key),
    }))
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.losses - b.losses)
    .slice(0, LEADERBOARD_SIZE);
}

// ─── 房间摘要（供切换器） ────────────────────────────
function roomSummary(room) {
  const cs = roomClients(room.code);
  const p1Online = !!room.players[0] && cs.some(c => c.nameKey === room.players[0]);
  const p2Online = !!room.players[1] && cs.some(c => c.nameKey === room.players[1]);
  const inProgress = room.state.history.length > 0 && !room.state.finished;
  let status = 'EMPTY';
  if (room.state.finished) status = 'ENDED';
  else if (inProgress) status = 'PLAYING';
  else if (room.players[0] || room.players[1]) status = 'WAITING';
  return {
    code: room.code,
    isDefault: room.isDefault,
    p1Name: room.players[0] ? records[room.players[0]]?.name || room.players[0] : null,
    p2Name: room.players[1] ? records[room.players[1]]?.name || room.players[1] : null,
    p1Online, p2Online,
    spectators: cs.length - (p1Online ? 1 : 0) - (p2Online ? 1 : 0),
    clients: cs.length,
    status,
    lastActivity: room.lastActivity,
    full: !!room.players[0] && !!room.players[1],
  };
}

function roomsSummary() {
  return [...rooms.values()].map(roomSummary)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    });
}

function limitsInfo() {
  return {
    maxRooms: MAX_ROOMS,
    maxClients: MAX_CLIENTS,
    maxSpectatorsPerRoom: MAX_SPECTATORS_PER_ROOM,
    currentRooms: rooms.size,
    currentClients: clients.length,
  };
}

// ─── 广播 ────────────────────────────────────────────
function snapshotForClient(client, extras) {
  const room = rooms.get(client.roomCode);
  const cs = roomClients(client.roomCode);
  const p1Online = !!room.players[0] && cs.some(c => c.nameKey === room.players[0]);
  const p2Online = !!room.players[1] && cs.some(c => c.nameKey === room.players[1]);
  return {
    room: room.code,
    isDefaultRoom: room.isDefault,
    board: room.state.board,
    current: room.state.current,
    history: room.state.history,
    finished: room.state.finished,
    winLine: room.state.winLine,
    gameStartTime: room.state.gameStartTime,
    p1: room.players[0] ? publicRecord(room.players[0]) : null,
    p2: room.players[1] ? publicRecord(room.players[1]) : null,
    p1Online, p2Online,
    p1Claimed: !!room.players[0],
    p2Claimed: !!room.players[1],
    spectators: cs.length - (p1Online ? 1 : 0) - (p2Online ? 1 : 0),
    rooms: roomsSummary(),
    leaderboard: leaderboard(),
    totalPlayers: Object.keys(records).length,
    limits: limitsInfo(),
    serverTime: Date.now(),
    youAre: roleInRoom(room, client.nameKey),
    youKey: client.nameKey,
    youName: records[client.nameKey]?.name,
    ...(extras || {}),
  };
}

function sendTo(client, obj) {
  try { client.res.write(`data: ${JSON.stringify(obj)}\n\n`); }
  catch (e) {}
}

function broadcastRoom(roomCode, extras) {
  for (const c of clients) {
    if (c.roomCode === roomCode) sendTo(c, snapshotForClient(c, extras));
  }
}

function broadcastAll(extras) {
  for (const c of clients) sendTo(c, snapshotForClient(c, extras));
}

// ─── 空闲房间回收 ────────────────────────────────────
function reapIdleRooms() {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.isDefault) continue;
    if (roomClients(code).length > 0) continue;
    if (now - r.lastActivity < ROOM_IDLE_TTL_MS) continue;
    rooms.delete(code);
    console.log(`[reap] room ${code} removed (idle)`);
  }
}
setInterval(reapIdleRooms, 60 * 1000);

// ─── HTTP ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return serveFile(res, 'gomoku.html', 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/leaderboard') {
    return respond(res, 200, { ok: true, leaderboard: leaderboard() });
  }

  if (req.method === 'GET' && url.pathname === '/rooms') {
    return respond(res, 200, { ok: true, rooms: roomsSummary(), limits: limitsInfo() });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const sessionId = url.searchParams.get('id');
    const rawName = url.searchParams.get('name');
    const rawRoom = (url.searchParams.get('room') || DEFAULT_ROOM).toUpperCase();

    if (!sessionId) { res.writeHead(400); res.end('missing id'); return; }
    if (!validateName(rawName)) { res.writeHead(400); res.end('invalid name'); return; }

    // 全局连接上限
    if (clients.length >= MAX_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, err: 'SERVER_FULL', message: 'MAX_CLIENTS reached' }));
      return;
    }

    if (!ROOM_CODE_RE.test(rawRoom) && rawRoom !== DEFAULT_ROOM) {
      res.writeHead(400); res.end('invalid room'); return;
    }

    const got = getOrCreateRoom(rawRoom);
    if (!got.ok) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, err: got.err, message: 'Max rooms reached, join OPEN instead.' }));
      return;
    }
    const room = got.room;

    const displayName = rawName.trim();
    const key = nameKey(displayName);
    ensureRecord(key, displayName);

    const role = assignSlot(room, key);

    // 房间观战上限
    if (role === 'spectator' && roomSpectatorCount(room.code) >= MAX_SPECTATORS_PER_ROOM) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, err: 'ROOM_FULL', message: 'Spectator slots full' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client = { sessionId, nameKey: key, roomCode: room.code, res };
    clients.push(client);
    room.lastActivity = Date.now();

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    sendTo(client, snapshotForClient(client));
    broadcastRoom(room.code);
    // 其他房间也更新 rooms 摘要
    broadcastAll();

    req.on('close', () => {
      clearInterval(heartbeat);
      const idx = clients.indexOf(client);
      if (idx >= 0) clients.splice(idx, 1);

      const stillIn = keyHasActiveClientInRoom(key, room.code);
      if ((role === 'p1' || role === 'p2') && !stillIn) {
        scheduleSlotRelease(room.code, key);
      }
      broadcastAll();
    });
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body || '{}'); }
      catch { return respond(res, 400, { ok: false, err: 'bad json' }); }

      if (url.pathname === '/check-name') {
        const name = data.name;
        if (!validateName(name)) return respond(res, 200, { ok: false, err: 'INVALID_FORMAT' });
        const key = nameKey(name);
        const r = records[key];
        return respond(res, 200, {
          ok: true,
          exists: !!r,
          record: r ? {
            name: r.name, score: r.score, wins: r.wins, losses: r.losses,
            bestStreak: r.bestStreak, games: r.totalGames,
          } : null,
        });
      }

      const { role, room, client } = getRoleBySession(data.id);

      if (url.pathname === '/move') return handleMove(res, role, room, data);

      if (url.pathname === '/restart') {
        if (role === 'spectator' || !room) return respond(res, 403, { ok: false, err: 'spectator' });
        room.state = createGameState();
        room.lastActivity = Date.now();
        broadcastRoom(room.code);
        return respond(res, 200, { ok: true });
      }

      if (url.pathname === '/undo') {
        if (role === 'spectator' || !room) return respond(res, 403, { ok: false, err: 'spectator' });
        if (room.state.finished || !room.state.history.length) return respond(res, 400, { ok: false, err: 'cannot undo' });
        const last = room.state.history.pop();
        room.state.board[last.r][last.c] = 0;
        room.state.current = last.p;
        room.state.winLine = null;
        room.lastActivity = Date.now();
        broadcastRoom(room.code);
        return respond(res, 200, { ok: true });
      }

      respond(res, 404, { ok: false, err: 'unknown' });
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

function handleMove(res, role, room, data) {
  if (!room) return respond(res, 400, { ok: false, err: 'no room' });
  if (room.state.finished) return respond(res, 400, { ok: false, err: 'finished' });
  const expected = room.state.current === 1 ? 'p1' : 'p2';
  if (role !== expected) return respond(res, 403, { ok: false, err: 'not your turn' });

  const r = data.r | 0, c = data.c | 0;
  if (!inBounds(r, c) || room.state.board[r][c]) {
    return respond(res, 400, { ok: false, err: 'invalid move' });
  }

  if (room.state.history.length === 0) room.state.gameStartTime = Date.now();

  room.state.board[r][c] = room.state.current;
  room.state.history.push({ r, c, p: room.state.current });
  room.lastActivity = Date.now();
  const won = checkWin(room.state.board, r, c, room.state.current);

  let lastEvent = null;
  let isWin = false;
  if (won) {
    room.state.finished = true;
    room.state.winLine = won;
    const winnerSlot = room.state.current;
    const winnerKey = room.players[winnerSlot - 1];
    const loserKey = room.players[winnerSlot === 1 ? 1 : 0];
    const settle = settleScores(winnerKey, loserKey, room.state.history.length);
    lastEvent = {
      type: 'WIN',
      winnerSlot,
      duration: Date.now() - (room.state.gameStartTime || Date.now()),
      moves: room.state.history.length,
      ...settle,
    };
    isWin = true;
  } else {
    room.state.current = room.state.current === 1 ? 2 : 1;
  }

  if (isWin) {
    // 分数变化 → 全房间刷 leaderboard
    broadcastRoom(room.code, { lastEvent });
    // 其他房间也广播一次以刷新 leaderboard
    for (const c of clients) {
      if (c.roomCode !== room.code) sendTo(c, snapshotForClient(c));
    }
  } else {
    broadcastRoom(room.code);
  }
  respond(res, 200, { ok: true });
}

function respond(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, name, mime) {
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(500); res.end('read error'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ─── 启动 ────────────────────────────────────────────
ensureDefaultRoom();

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  const line = '─'.repeat(56);
  console.log(`\n  GOMOKU // PROTOCOL SERVER`);
  console.log(`  ${line}`);
  console.log(`  Local    →  http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Network  →  http://${ip}:${PORT}`));
  console.log(`  ${line}`);
  console.log(`  Capacity →  ROOMS ${MAX_ROOMS} · CLIENTS ${MAX_CLIENTS} · SPEC/ROOM ${MAX_SPECTATORS_PER_ROOM}`);
  console.log(`  IdleTTL  →  ${(ROOM_IDLE_TTL_MS / 60000).toFixed(0)} min (default room never reaped)`);
  console.log(`  Records  →  ${RECORDS_FILE}  (${Object.keys(records).length} players)`);
  console.log(`  Default  →  ${DEFAULT_ROOM} room ready`);
  console.log(`  ${line}`);
  console.log(`  把 Network 链接发给对手 (需连同一 Wi-Fi)，打开即可对战。`);
  console.log(`  分享自定义房间：在链接后加 ?room=CODE 即可。`);
  console.log(`  Ctrl+C 退出。\n`);
});
