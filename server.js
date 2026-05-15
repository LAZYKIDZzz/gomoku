// GOMOKU PROTOCOL SERVER
// 零依赖 Node.js (>=14) HTTP + Server-Sent Events 实现
// 启动:  node server.js
// 自定义端口: PORT=9000 node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8080', 10);
const N = 15;
const RECONNECT_GRACE_MS = 15000;

// ─── 状态 ───────────────────────────────────────────────
let state = createGameState();
state.wins = [0, 0];
state.players = [null, null];           // 槽位: [p1SessionId, p2SessionId]
state.disconnects = Object.create(null); // sessionId -> 离线时间戳

let clients = []; // { id, role, res }

function createGameState() {
  return {
    board: Array.from({ length: N }, () => Array(N).fill(0)),
    current: 1,
    history: [],
    finished: false,
    winLine: null,
  };
}

function resetBoard() {
  const fresh = createGameState();
  state.board = fresh.board;
  state.current = fresh.current;
  state.history = fresh.history;
  state.finished = fresh.finished;
  state.winLine = fresh.winLine;
}

// ─── 角色管理 ───────────────────────────────────────────
function getRole(sessionId) {
  if (state.players[0] === sessionId) return 'p1';
  if (state.players[1] === sessionId) return 'p2';
  return 'spectator';
}

function assignRole(sessionId) {
  // 重连：清除离线记录
  if (state.disconnects[sessionId]) delete state.disconnects[sessionId];

  const existing = getRole(sessionId);
  if (existing !== 'spectator') return existing;

  // 填补空槽
  if (!state.players[0]) { state.players[0] = sessionId; return 'p1'; }
  if (!state.players[1]) { state.players[1] = sessionId; return 'p2'; }
  return 'spectator';
}

function clientCountById(sessionId) {
  return clients.filter(c => c.id === sessionId).length;
}

function scheduleSlotRelease(sessionId) {
  state.disconnects[sessionId] = Date.now();
  setTimeout(() => {
    const ts = state.disconnects[sessionId];
    if (!ts) return;
    if (Date.now() - ts < RECONNECT_GRACE_MS) return;
    if (clientCountById(sessionId) > 0) return;
    if (state.players[0] === sessionId) state.players[0] = null;
    if (state.players[1] === sessionId) state.players[1] = null;
    delete state.disconnects[sessionId];
    broadcast();
  }, RECONNECT_GRACE_MS + 200);
}

// ─── 胜负判定 ───────────────────────────────────────────
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

function inBounds(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

// ─── 广播 ───────────────────────────────────────────────
function snapshot() {
  return {
    board: state.board,
    current: state.current,
    history: state.history,
    finished: state.finished,
    winLine: state.winLine,
    wins: state.wins,
    p1Online: !!state.players[0] && clientCountById(state.players[0]) > 0,
    p2Online: !!state.players[1] && clientCountById(state.players[1]) > 0,
    p1Claimed: !!state.players[0],
    p2Claimed: !!state.players[1],
    spectators: clients.filter(c => c.role === 'spectator').length,
    serverTime: Date.now(),
  };
}

function broadcast() {
  // 给每个客户端发同一份快照 + 各自角色
  for (const c of clients) {
    sendTo(c, { ...snapshot(), youAre: getRole(c.id) });
  }
}

function sendTo(client, obj) {
  try {
    client.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch (e) { /* ignore */ }
}

// ─── HTTP ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 静态文件
  if (req.method === 'GET' && url.pathname === '/') {
    return serveFile(res, 'gomoku.html', 'text/html; charset=utf-8');
  }

  // SSE 事件流
  if (req.method === 'GET' && url.pathname === '/events') {
    const sessionId = url.searchParams.get('id');
    if (!sessionId) { res.writeHead(400); res.end('missing id'); return; }

    const role = assignRole(sessionId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client = { id: sessionId, role, res };
    clients.push(client);

    // 心跳保活
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(heartbeat); }
    }, 25000);

    // 立即推送一次
    sendTo(client, { ...snapshot(), youAre: role });
    broadcast();

    req.on('close', () => {
      clearInterval(heartbeat);
      clients = clients.filter(c => c !== client);
      // 如果是玩家且没有其他活跃连接，启动宽限计时
      if ((role === 'p1' || role === 'p2') && clientCountById(sessionId) === 0) {
        scheduleSlotRelease(sessionId);
      }
      broadcast();
    });
    return;
  }

  // POST 动作
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return respond(res, 400, { ok: false, err: 'bad json' }); }
      const sessionId = data.id;
      const role = sessionId ? getRole(sessionId) : 'spectator';

      if (url.pathname === '/move') {
        return handleMove(res, role, data);
      }
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

  state.board[r][c] = state.current;
  state.history.push({ r, c, p: state.current });
  const won = checkWin(r, c, state.current);
  if (won) {
    state.finished = true;
    state.winLine = won;
    state.wins[state.current - 1]++;
  } else {
    state.current = state.current === 1 ? 2 : 1;
  }
  broadcast();
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

// ─── 启动 ───────────────────────────────────────────────
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
  console.log(`  把 Network 链接发给对手 (需连同一 Wi-Fi)，打开即可对战。`);
  console.log(`  Ctrl+C 退出。\n`);
});
