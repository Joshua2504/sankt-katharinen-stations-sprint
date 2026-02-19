/*
 * ============================================================
 * STATIONS-SPRINT — Server
 * ============================================================
 * Setup:
 *   1. npm install
 *   2. node server.js        (production)
 *      npm run dev           (development, auto-restart via nodemon)
 *   3. Open http://localhost:3000
 *      (or http://localhost:8888 when running via Docker Compose)
 * ============================================================
 */

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const Database  = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

// ── Config ─────────────────────────────────────────────────
const PORT          = 3000;
const GAME_DURATION = 60;          // seconds
const TASK_TYPES    = ['medication', 'bandage', 'infusion', 'call_button'];
const RATE_LIMIT    = 15;          // max socket events per second per player

// ── Database setup ─────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'database.db'));

// Create tables on startup
db.exec(`
  CREATE TABLE IF NOT EXISTS players_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    socket_id  TEXT,
    name       TEXT,
    score      INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    score       INTEGER,
    achieved_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── DB helpers ──────────────────────────────────────────────

/** Return the top 10 leaderboard entries, highest score first. */
function getTopScores() {
  return db.prepare(
    'SELECT name, score, achieved_at FROM leaderboard ORDER BY score DESC LIMIT 10'
  ).all();
}

/** Insert a finished game score and prune to top 10. */
function insertScore(name, score) {
  db.prepare('INSERT INTO leaderboard (name, score) VALUES (?, ?)').run(name, score);

  // Keep only the top 10 rows
  db.prepare(`
    DELETE FROM leaderboard
    WHERE id NOT IN (
      SELECT id FROM leaderboard
      ORDER BY score DESC
      LIMIT 10
    )
  `).run();
}

// ── In-memory player state ─────────────────────────────────
/*
  players[socketId] = {
    name:        string,
    score:       number,
    activeTasks: [ { id, type, expiresAt } ],
    gameActive:  boolean,
    timeLeft:    number,
    intervals:   [ NodeJS.Timeout, ... ]   ← all clearable timers
  }
*/
const players = {};

// ── Express / Socket.io ─────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Socket events ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Per-socket rate limiter ───────────────────────────────
  let eventCount = 0;
  const rateLimitInterval = setInterval(() => { eventCount = 0; }, 1000);

  function rateCheck() {
    eventCount++;
    if (eventCount > RATE_LIMIT) {
      console.warn(`[!] Rate limit exceeded: ${socket.id}`);
      return false;
    }
    return true;
  }

  // Ask client to provide a name
  socket.emit('requestName');

  // ── registerPlayer ────────────────────────────────────────
  socket.on('registerPlayer', (name) => {
    if (!rateCheck()) return;

    name = String(name).trim().substring(0, 32);
    if (!name) return;

    players[socket.id] = {
      name,
      score:       0,
      activeTasks: [],
      gameActive:  false,
      timeLeft:    GAME_DURATION,
      intervals:   []
    };

    console.log(`[→] Registered: "${name}" (${socket.id})`);

    // Send current leaderboard so the lobby shows it immediately
    socket.emit('leaderboardUpdate', getTopScores());
  });

  // ── getLeaderboard ────────────────────────────────────────
  socket.on('getLeaderboard', () => {
    if (!rateCheck()) return;
    socket.emit('leaderboardUpdate', getTopScores());
  });

  // ── startGame ─────────────────────────────────────────────
  socket.on('startGame', () => {
    if (!rateCheck()) return;

    const player = players[socket.id];
    if (!player) return;
    if (player.gameActive) return; // already running

    // Reset state
    player.score       = 0;
    player.timeLeft    = GAME_DURATION;
    player.activeTasks = [];
    player.gameActive  = true;
    clearAllIntervals(player);

    emitGameState(socket, player);

    // 1-second countdown ticker
    const countdown = setInterval(() => {
      player.timeLeft--;

      emitGameState(socket, player);

      if (player.timeLeft <= 0) {
        endGame(socket, player);
      }
    }, 1000);
    player.intervals.push(countdown);

    // Task generator — fires every 1–2 seconds
    scheduleNextTask(socket, player);
  });

  // ── handleTask ────────────────────────────────────────────
  socket.on('handleTask', ({ taskId, chosenType }) => {
    if (!rateCheck()) return;

    const player = players[socket.id];
    if (!player || !player.gameActive) return;

    const taskIndex = player.activeTasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) return; // already resolved or expired

    const task = player.activeTasks[taskIndex];

    if (chosenType === task.type) {
      player.score += 10;  // correct
    } else {
      player.score -= 5;   // wrong action
    }

    // Remove task and its expiry timer
    clearTimeout(task.expiryTimer);
    player.activeTasks.splice(taskIndex, 1);

    emitGameState(socket, player);
  });

  // ── disconnect ────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    clearInterval(rateLimitInterval);

    const player = players[socket.id];
    if (player) {
      clearAllIntervals(player);
      // Cancel all active task expiry timers
      player.activeTasks.forEach(t => clearTimeout(t.expiryTimer));
    }
    delete players[socket.id];
  });
});

// ── Game helpers ────────────────────────────────────────────

/** Clear all game intervals stored for a player. */
function clearAllIntervals(player) {
  player.intervals.forEach(id => clearInterval(id));
  player.intervals = [];
}

/** Emit the current game state to one socket. */
function emitGameState(socket, player) {
  socket.emit('gameStateUpdate', {
    score:    player.score,
    timeLeft: player.timeLeft,
    // Send tasks without the internal timer reference
    tasks: player.activeTasks.map(({ id, type, label }) => ({ id, type, label }))
  });
}

/**
 * Schedule the next task spawn after a random 1–2 second delay.
 * Uses chained timeouts so the interval itself is random each time.
 */
function scheduleNextTask(socket, player) {
  const delay = 1000 + Math.random() * 1000; // 1000–2000 ms

  const t = setTimeout(() => {
    if (!player.gameActive) return;

    spawnTask(socket, player);

    // Remove this timeout from intervals (it has already fired)
    player.intervals = player.intervals.filter(id => id !== t);

    // Schedule the next one
    if (player.gameActive) scheduleNextTask(socket, player);
  }, delay);

  player.intervals.push(t);
}

/** Spawn a new task, set its expiry, and notify the client. */
function spawnTask(socket, player) {
  const type  = TASK_TYPES[Math.floor(Math.random() * TASK_TYPES.length)];
  const ttl   = 3000 + Math.random() * 2000; // 3000–5000 ms
  const taskId = crypto.randomUUID();

  const expiryTimer = setTimeout(() => {
    // Task timed out — remove and penalise
    const idx = player.activeTasks.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      player.activeTasks.splice(idx, 1);
      player.score -= 10;
      emitGameState(socket, player);
    }
  }, ttl);

  player.activeTasks.push({
    id:          taskId,
    type,
    label:       taskLabel(type),
    expiryTimer,
    expiresAt:   Date.now() + ttl
  });

  emitGameState(socket, player);
}

/** Human-readable label for a task type. */
function taskLabel(type) {
  const labels = {
    medication:  'Medikament geben',
    bandage:     'Verband anlegen',
    infusion:    'Infusion wechseln',
    call_button: 'Klingelruf beantworten'
  };
  return labels[type] || type;
}

/** End the game: save score, trim leaderboard, notify all clients. */
function endGame(socket, player) {
  player.gameActive  = false;
  player.activeTasks.forEach(t => clearTimeout(t.expiryTimer));
  player.activeTasks = [];
  clearAllIntervals(player);

  insertScore(player.name, player.score);
  const top10 = getTopScores();

  socket.emit('gameOver', { score: player.score });
  io.emit('leaderboardUpdate', top10); // broadcast to all connected clients
}

// ── Start ───────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Stations-Sprint running → http://localhost:${PORT}`);
});
