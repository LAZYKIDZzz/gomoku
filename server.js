// GOMOKU PROTOCOL SERVER
// 零依赖 Node.js (>=14) HTTP + Server-Sent Events 实现
// 启动:  node server.js
// 自定义端口: PORT=9000 node server.js
//
// 玩家身份:    通过 handle（玩家名/称号）识别，持久化到 players.json
// 分数体系:    胜 +10 (+连胜奖励 +速胜奖励)；负 -5
// 排行榜:      Top 10 实时随快照广播

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8080', 10);
const N = 15;
const RECONNECT_GRACE_MS = 15000;
const RECORDS_FILE = path.join(__dirname, 'players.json');
const LEADERBOARD_SIZE = 10;

const SCORE = {
  WIN_BASE: 10,           // 每胜基础分
  LOSS: -5,               // 每负扣分
  STREAK_PER_WIN: 2,      // 第 N 连胜额外: min((N-1)*PER, MAX)
  STREAK_MAX: 10,
  QUICK_WIN_BONUS: 5,     // 总步数 <= 阈值时奖励
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

// ─── 状态 ──────────────────────────────────────────────
let state = createGameState();
state.players = [null, null];          // 槽位: [p1 nameKey, p2 nameKey]
state.disconnects = Object.create(null); // nameKey -> 离线时间戳
let clients = [];                        // { sessionId, nameKey, role, res }

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

function resetBoard() {
  const fresh = createGameState();
  state.board = fresh.board;
  state.current = fresh.current;
  state.history = fresh.history;
  state.finished = fresh.finished;
  state.winLine = fresh.winLine;
  state.gameStartTime = null;
}

// ─── 玩家身份 ─────────────────────────────────────────
function nameKey(name) { return String(name || '').trim().toLowerCase(); }

function validateName(name) {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (t.length < 2 || t.length > 16) return false;
  // 字母 / 数字 / 下划线 / 连字符 / 中点 / 中文
  return /^[A-Za-z0-9_\-·一-龥]+$/.test(t);
}

function ensureRecord(key, displayName) {
  if (!records[key]) {
    records[key] = {
      name: displayName,
      score: 0,
      wins: 0,
      losses: 0,
      streak: 0,
      bestStreak: 0,
      totalGames: 0,
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
  } else {
    if (displayName) records[key].name = displayName;
    records[key].lastSeen = Date.now();
  }
  return records[key];
}

function getRoleByKey(key) {
  if (!key) return 'spectator';
  if (state.players[0] === key) return 'p1';
  if (state.players[1] === key) return 'p2';
  return 'spectator';
}

function getRoleBySession(sessionId) {
  const c = clients.find(c => c.sessionId === sessionId);
  if (!c) return 'spectator';
  return getRoleByKey(c.nameKey);
}

function assignSlot(key) {
  if (state.disconnects[key]) delete state.disconnects[key];
  const existing = getRoleByKey(key);
  if (existing !== 'spectator') return existing;
  if (!state.players[0]) { state.players[0] = key; return 'p1'; }
  if (!state.players[1]) { state.players[1] = key; return 'p2'; }
  return 'spectator';
}

function keyHasActiveClient(key) {
  return clients.some(c => c.nameKey === key);
}

function scheduleSlotRelease(key) {
  state.disconnects[key] = Date.now();
  setTimeout(() => {
    const ts = state.disconnects[key];
    if (!ts) return;
    if (Date.now() - ts < RECONNECT_GRACE_MS) return;
    if (keyHasActiveClient(key)) return;
    if (state.players[0] === key) state.players[0] = null;
    if (state.players[1] === key) state.players[1] = null;
    delete state.disconnects[key];
    broadcast();
  }, RECONNECT_GRACE_MS + 200);
}

// ─── 胜负 ─────────────────────────────────────────────
function inBounds(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

function checkWin(r, c, p) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const line = [{ r, c }];
    let i = 1;
    while (inBounds(r + dr * i, c + dc * i) && state.board[r + dr * i][c + dc * i] === p) {
      line.push({ r: r + dr * i, c: c + dc * i }); i++;
    }
    i = 1;
    while (inBounds(r - dr * i, c - dc * i) && state.board[r - dr * i][c - dc * i] === p) {
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
    ev.winner = {
      name: w.name, key: winnerKey,
      delta, base: SCORE.WIN_BASE, streakBonus, quickBonus,
      streak: w.streak, score: w.score,
    };
  }

  if (loserKey) {
    const l = ensureRecord(loserKey, records[loserKey]?.name || loserKey);
    l.streak = 0;
    l.score += SCORE.LOSS;
    l.losses += 1;
    l.totalGames += 1;
    l.lastSeen = Date.now();
    ev.loser = {
      name: l.name, key: loserKey,
      delta: SCORE.LOSS, score: l.score,
    };
  }

  saveRecords();
  return ev;
}

// ─── 排行榜 ──────────────────────────────────────────
function leaderboard() {
  return Object.entries(records)
    .map(([key, r]) => ({
      key,
      name: r.name,
      score: r.score,
      wins: r.wins,
      losses: r.losses,
      games: r.totalGames,
      winRate: r.totalGames ? r.wins / r.totalGames : 0,
      streak: r.streak,
      bestStreak: r.bestStreak,
      lastSeen: r.lastSeen,
      online: keyHasActiveClient(key),
    }))
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.losses - b.losses)
    .slice(0, LEADERBOARD_SIZE);
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

// ─── 广播 ────────────────────────────────────────────
function snapshot(extras) {
  return {
    board: state.board,
    current: state.current,
    history: state.history,
    finished: state.finished,
    winLine: state.winLine,
    gameStartTime: state.gameStartTime,
    p1: state.players[0] ? publicRecord(state.players[0]) : null,
    p2: state.players[1] ? publicRecord(state.players[1]) : null,
    p1Online: !!state.players[0] && keyHasActiveClient(state.players[0]),
    p2Online: !!state.players[1] && keyHasActiveClient(state.players[1]),
    p1Claimed: !!state.players[0],
    p2Claimed: !!state.players[1],
    spectators: clients.filter(c => getRoleByKey(c.nameKey) === 'spectator').length,
    leaderboard: leaderboard(),
    totalPlayers: Object.keys(records).length,
    serverTime: Date.now(),
    ...(extras || {}),
  };
}

function broadcast(extras) {
  for (const c of clients) {
    sendTo(c, {
      ...snapshot(extras),
      youAre: getRoleByKey(c.nameKey),
      youKey: c.nameKey,
      youName: records[c.nameKey]?.name,
    });
  }
}

function sendTo(client, obj) {
  try { client.res.write(`data: ${JSON.stringify(obj)}\n\n`); }
  catch (e) {}
}

// ─── HTTP ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return serveFile(res, 'gomoku.html', 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/leaderboard') {
    return respond(res, 200, { ok: true, leaderboard: leaderboard() });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const sessionId = url.searchParams.get('id');
    const rawName = url.searchParams.get('name');
    if (!sessionId) { res.writeHead(400); res.end('missing id'); return; }
    if (!validateName(rawName)) { res.writeHead(400); res.end('invalid name'); return; }

    const displayName = rawName.trim();
    const key = nameKey(displayName);
    ensureRecord(key, displayName);
    const role = assignSlot(key);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client = { sessionId, nameKey: key, role, res };
    clients.push(client);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    sendTo(client, { ...snapshot(), youAre: role, youKey: key, youName: displayName });
    broadcast();

    req.on('close', () => {
      clearInterval(heartbeat);
      clients = clients.filter(c => c !== client);
      if ((role === 'p1' || role === 'p2') && !keyHasActiveClient(key)) {
        scheduleSlotRelease(key);
      }
      broadcast();
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

      const sessionId = data.id;

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

      const role = sessionId ? getRoleBySession(sessionId) : 'spectator';

      if (url.pathname === '/move') return handleMove(res, role, data);

      if (url.pathname === '/restart') {
        if (role === 'spectator') return respond(res, 403, { ok: false, err: 'spectator' });
        resetBoard();
        broadcast();
        return respond(res, 200, { ok: true });
      }

      if (url.pathname === '/undo') {
        if (role === 'spectator') return respond(res, 403, { ok: false, err: 'spectator' });
        if (state.finished || !state.history.length) return respond(res, 400, { ok: false, err: 'cannot undo' });
        const last = state.history.pop();
        state.board[last.r][last.c] = 0;
        state.current = last.p;
        state.winLine = null;
        broadcast();
        return respond(res, 200, { ok: true });
      }

      respond(res, 404, { ok: false, err: 'unknown' });
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

function handleMove(res, role, data) {
  if (state.finished) return respond(res, 400, { ok: false, err: 'finished' });
  const expected = state.current === 1 ? 'p1' : 'p2';
  if (role !== expected) return respond(res, 403, { ok: false, err: 'not your turn' });

  const r = data.r | 0, c = data.c | 0;
  if (!inBounds(r, c) || state.board[r][c]) {
    return respond(res, 400, { ok: false, err: 'invalid move' });
  }

  if (state.history.length === 0) state.gameStartTime = Date.now();

  state.board[r][c] = state.current;
  state.history.push({ r, c, p: state.current });
  const won = checkWin(r, c, state.current);

  let lastEvent = null;
  if (won) {
    state.finished = true;
    state.winLine = won;
    const winnerSlot = state.current;
    const winnerKey = state.players[winnerSlot - 1];
    const loserKey = state.players[winnerSlot === 1 ? 1 : 0];
    const settle = settleScores(winnerKey, loserKey, state.history.length);
    lastEvent = {
      type: 'WIN',
      winnerSlot,
      duration: Date.now() - (state.gameStartTime || Date.now()),
      moves: state.history.length,
      ...settle,
    };
  } else {
    state.current = state.current === 1 ? 2 : 1;
  }
  broadcast(lastEvent ? { lastEvent } : null);
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
server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  const line = '─'.repeat(48);
  console.log(`\n  GOMOKU // PROTOCOL SERVER`);
  console.log(`  ${line}`);
  console.log(`  Local    →  http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Network  →  http://${ip}:${PORT}`));
  console.log(`  ${line}`);
  console.log(`  Records  →  ${RECORDS_FILE}`);
  console.log(`  Players  →  ${Object.keys(records).length} registered`);
  console.log(`  把 Network 链接发给对手 (需连同一 Wi-Fi)，打开即可对战。`);
  console.log(`  Ctrl+C 退出。\n`);
});
