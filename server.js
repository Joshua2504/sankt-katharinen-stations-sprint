/*
 * ============================================================
 * STATIONS-SPRINT — Server (Shared World Edition)
 * ============================================================
 * Setup:
 *   1. npm install
 *   2. docker compose up --build     (recommended)
 *      — or —
 *      REDIS_URL=redis://localhost:6379 npm run dev  (local)
 *   3. Open http://localhost:8888
 *
 * Architecture:
 *   - ONE shared world for all connected players
 *   - Redis  → all live state (tasks, vitals, claims, sessions)
 *   - SQLite → durable persistence (leaderboard, session audit)
 *   - Server is fully authoritative; client only renders & emits input
 * ============================================================
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const Database   = require('better-sqlite3');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const r          = require('./redis');  // Redis helper layer

// ── Config ──────────────────────────────────────────────────
const PORT       = 3000;
const RATE_LIMIT = 15; // max socket events per second per player

// ── Game Speed ───────────────────────────────────────────────
// Multiplier applied to all time-based values (TTLs, spawn interval, claim window).
//   1.0 = normal  |  0.5 = twice as fast  |  2.0 = twice as slow
const GAME_SPEED = 0.1;

// Ward configuration — 8 rooms, each with a fixed patient
const PATIENTS = [
  { room: 1, name: 'Ernst Müller'    },
  { room: 2, name: 'Ingrid Schmidt'  },
  { room: 3, name: 'Walter Hoffmann' },
  { room: 4, name: 'Gerda Fischer'   },
  { room: 5, name: 'Heinrich Weber'  },
  { room: 6, name: 'Hildegard Meyer' },
  { room: 7, name: 'Otto Wagner'     },
  { room: 8, name: 'Elfriede Schulz' },
];

// ── Actions (treatments the player can pick) ────────────────
const ACTIONS = {
  betablocker:   { label: 'Betablocker geben',     icon: '💊' },
  sauerstoff:    { label: 'Sauerstoffmaske',        icon: '🫁' },
  fiebermittel:  { label: 'Wadenwickel & Antipyretikum', icon: '🌡️' },
  infusion:      { label: 'Volumen-Infusion',       icon: '💧' },
  schmerzmittel: { label: 'Schmerzmittel geben',    icon: '💊' },
  verband:       { label: 'Verband wechseln',       icon: '🩹' },
};

// ── Symptoms (vitals-driven conditions) ──────────────────────
// Each symptom defines:
//   trigger(v)       — returns true if the room's vitals match this condition
//   correctAction    — the key from ACTIONS that fixes it
//   label / hint     — shown to the player (NOT the solution!)
//   recovery         — vitals delta applied on correct resolution
//   priority         — higher = more likely to be picked when multiple triggers match
const SYMPTOMS = {
  tachycardia: {
    trigger: v => v.hr > 100,
    correctAction: 'betablocker',
    label: 'Herzrasen',
    hint:  'Der Puls ist stark erhöht. Der Patient ist unruhig und schwitzt.',
    recovery: { hr: -20, o2: 1, temp: 0, bp: 5 },
    priority: 3,
  },
  bradycardia: {
    trigger: v => v.hr < 55,
    correctAction: 'infusion',
    label: 'Bradykardie',
    hint:  'Der Puls ist bedrohlich niedrig. Der Patient wirkt benommen.',
    recovery: { hr: 15, o2: 1, temp: 0, bp: 10 },
    priority: 3,
  },
  hypoxia: {
    trigger: v => v.o2 < 93,
    correctAction: 'sauerstoff',
    label: 'Atemnot',
    hint:  'Die Sauerstoffsättigung fällt ab. Der Patient atmet schnell und flach.',
    recovery: { hr: -3, o2: 6, temp: 0, bp: 3 },
    priority: 4,
  },
  fever: {
    trigger: v => v.temp > 38.5,
    correctAction: 'fiebermittel',
    label: 'Fieber',
    hint:  'Die Temperatur ist deutlich erhöht. Der Patient glüht.',
    recovery: { hr: -3, o2: 1, temp: -1.5, bp: 2 },
    priority: 2,
  },
  hypotension: {
    trigger: v => v.bp < 100,
    correctAction: 'infusion',
    label: 'Kreislaufschwäche',
    hint:  'Der Blutdruck sackt ab. Dem Patienten wird schwindelig.',
    recovery: { hr: -2, o2: 1, temp: 0, bp: 25 },
    priority: 3,
  },
  hypertension: {
    trigger: v => v.bp > 160,
    correctAction: 'betablocker',
    label: 'Bluthochdruck-Krise',
    hint:  'Der Blutdruck ist gefährlich hoch. Der Patient klagt über Kopfschmerzen.',
    recovery: { hr: -5, o2: 1, temp: 0, bp: -30 },
    priority: 3,
  },
  pain: {
    trigger: () => true,  // always available as fallback
    correctAction: 'schmerzmittel',
    label: 'Starke Schmerzen',
    hint:  'Der Patient klagt über starke Schmerzen und bittet um Hilfe.',
    recovery: { hr: -3, o2: 1, temp: 0, bp: 3 },
    priority: 0,
  },
  bleeding: {
    trigger: () => true,  // always available as fallback
    correctAction: 'verband',
    label: 'Nachblutung',
    hint:  'Der Verband ist durchgeblutet. Die Wunde muss neu versorgt werden.',
    recovery: { hr: -2, o2: 1, temp: 0, bp: 5 },
    priority: 0,
  },
};

// Symptom keys that require a vitals trigger (priority > 0)
const TRIGGERED_SYMPTOMS = Object.entries(SYMPTOMS)
  .filter(([, s]) => s.priority > 0)
  .map(([key]) => key);
// Fallback symptoms (always available)
const FALLBACK_SYMPTOMS  = Object.entries(SYMPTOMS)
  .filter(([, s]) => s.priority === 0)
  .map(([key]) => key);

// Urgency tiers: weight (%), base TTL (s, scaled by GAME_SPEED), scoring
const URGENCY = {
  routine:  { weight: 60, ttl: Math.round(180 * GAME_SPEED), scoreCorrect: 10, scoreWrong: -3,  teamPenalty: -3  },
  urgent:   { weight: 30, ttl: Math.round(120 * GAME_SPEED), scoreCorrect: 15, scoreWrong: -5,  teamPenalty: -5  },
  critical: { weight: 10, ttl: Math.round( 75 * GAME_SPEED), scoreCorrect: 25, scoreWrong: -8,  teamPenalty: -10 },
};

// Vitals degradation per spawn / missed task (affects all 4 vitals)
const VITALS_DEGRADE = { hr: 4, o2: -2, temp: 0.3, bp: -4 };
// Generic recovery (used only when no symptom-specific recovery exists)
const VITALS_RECOVER = { hr: -3, o2: 1, temp: -0.2, bp: 3 };
const VITALS_LIMITS  = {
  hrMin: 40, hrMax: 140,
  o2Min: 82, o2Max: 100,
  tempMin: 35.0, tempMax: 41.0,
  bpMin: 70, bpMax: 190,
};

// ── SQLite setup ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'database.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS players_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    socket_id       TEXT,
    name            TEXT,
    score           INTEGER DEFAULT 0,
    connected_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    disconnected_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS leaderboard (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    score       INTEGER,
    achieved_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── SQLite helpers ───────────────────────────────────────────

function getTopScores() {
  return db.prepare(
    'SELECT name, score, achieved_at FROM leaderboard ORDER BY score DESC LIMIT 10'
  ).all();
}

function insertScore(name, score) {
  db.prepare('INSERT INTO leaderboard (name, score) VALUES (?, ?)').run(name, score);
  db.prepare(`
    DELETE FROM leaderboard
    WHERE id NOT IN (SELECT id FROM leaderboard ORDER BY score DESC LIMIT 10)
  `).run();
}

function insertSession(socketId, name) {
  db.prepare('INSERT INTO players_sessions (socket_id, name) VALUES (?, ?)').run(socketId, name);
}

function finalizeSession(socketId, score) {
  db.prepare(`
    UPDATE players_sessions
    SET score = ?, disconnected_at = CURRENT_TIMESTAMP
    WHERE socket_id = ?
  `).run(score, socketId);
}

// ── World spawner ────────────────────────────────────────────
// One Node.js timer handles all spawning — state lives in Redis.
let spawnerTimeout = null;

/** Pick a symptom based on patient vitals. Prefers triggered symptoms; falls back to random. */
function pickSymptom(vitals) {
  // Collect all triggered symptoms sorted by priority (desc)
  const triggered = TRIGGERED_SYMPTOMS
    .filter(key => SYMPTOMS[key].trigger(vitals))
    .sort((a, b) => SYMPTOMS[b].priority - SYMPTOMS[a].priority);

  if (triggered.length > 0) {
    // Weighted pick: higher-priority symptoms are more likely
    // Probability proportional to (priority + 1)
    const weights = triggered.map(k => SYMPTOMS[k].priority + 1);
    const total   = weights.reduce((s, w) => s + w, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < triggered.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return triggered[i];
    }
    return triggered[triggered.length - 1];
  }

  // No vitals trigger → random fallback (pain / bleeding)
  return FALLBACK_SYMPTOMS[Math.floor(Math.random() * FALLBACK_SYMPTOMS.length)];
}

/** Spawn one task into the shared world and store it in Redis. */
async function spawnTask() {
  const tasks       = await r.getTasks();
  const playerCount = await r.getActivePlayerCount();
  const maxTasks    = Math.max(4, playerCount * 2);
  if (tasks.length >= maxTasks) return;

  // Pick a room with < 2 active tasks
  const shuffled = [...PATIENTS].sort(() => Math.random() - 0.5);
  let patient = null;
  for (const p of shuffled) {
    if (tasks.filter(t => t.room === p.room).length < 2) { patient = p; break; }
  }
  if (!patient) return;

  const vitals     = await r.getAllVitals();
  const roomVitals = vitals[patient.room] || { hr: 72, o2: 98, temp: 36.8, bp: 125 };
  const symptomKey = pickSymptom(roomVitals);
  const symptom    = SYMPTOMS[symptomKey];
  const urgencyKey = pickUrgency();
  const cfg        = URGENCY[urgencyKey];
  const taskId     = crypto.randomUUID();
  const ttlMs      = cfg.ttl * 1000;

  const task = {
    id:            taskId,
    symptom:       symptomKey,
    correctAction: symptom.correctAction,
    label:         symptom.label,
    hint:          symptom.hint,
    urgency:       urgencyKey,
    room:          patient.room,
    patient:       patient.name,
    expiresAt:     Date.now() + ttlMs,
    claimedBy:     null,
    claimedByName: null,
  };

  await r.addTask(task);
  await adjustVitals(patient.room, VITALS_DEGRADE);

  // Schedule TTL expiry in Node (simpler than Redis keyspace notifications)
  setTimeout(() => handleTaskExpiry(taskId, urgencyKey, patient.room), ttlMs);

  await broadcastWorldUpdate();
}

/** Called when a task's TTL fires without being resolved. */
async function handleTaskExpiry(taskId, urgencyKey, roomNum) {
  const removed = await r.removeTask(taskId);
  if (!removed) return; // already resolved

  await r.releaseClaim(taskId);
  await r.incrTeamScore(URGENCY[urgencyKey].teamPenalty);
  await adjustVitals(roomNum, VITALS_DEGRADE);
  await broadcastWorldUpdate();
}

/** Clamp vitals (4 fields) and write to Redis. */
async function adjustVitals(roomNum, delta) {
  const vitals  = await r.getAllVitals();
  const c = vitals[roomNum] || { hr: 72, o2: 98, temp: 36.8, bp: 125 };
  const L = VITALS_LIMITS;
  const clamped = {
    hr:   Math.min(L.hrMax,   Math.max(L.hrMin,   Math.round(c.hr + delta.hr))),
    o2:   Math.min(L.o2Max,   Math.max(L.o2Min,   Math.round(c.o2 + delta.o2))),
    temp: Math.min(L.tempMax,  Math.max(L.tempMin,  Math.round((c.temp + (delta.temp || 0)) * 10) / 10)),
    bp:   Math.min(L.bpMax,   Math.max(L.bpMin,   Math.round(c.bp + (delta.bp || 0)))),
  };
  await r.setVitals(roomNum, clamped);
}

/** Schedule next spawn (interval also scaled by GAME_SPEED). */
function scheduleNextSpawn() {
  const delay = (20000 + Math.random() * 15000) * GAME_SPEED;
  spawnerTimeout = setTimeout(async () => {
    if ((await r.getActivePlayerCount()) === 0) { spawnerTimeout = null; return; }
    try { await spawnTask(); } catch (e) { console.error('[Spawner]', e.message); }
    scheduleNextSpawn();
  }, delay);
}

async function startSpawner() {
  if (spawnerTimeout) return;
  console.log('[World] Spawner started');
  spawnerTimeout = setTimeout(async () => {
    try { await spawnTask(); } catch (e) { console.error('[Spawner]', e.message); }
    scheduleNextSpawn();
  }, 3000); // 3-second grace period before first task
}

function stopSpawner() {
  clearTimeout(spawnerTimeout);
  spawnerTimeout = null;
  console.log('[World] Spawner stopped');
}

// ── World state builder ─────────────────────────────────────

async function buildWorldState() {
  const [tasks, teamScore, vitals, playerIds] = await Promise.all([
    r.getTasks(),
    r.getTeamScore(),
    r.getAllVitals(),
    r.getActivePlayers(),
  ]);

  // Attach live vitals to each task so the modal can display them
  const enrichedTasks = tasks.map(t => ({
    ...t,
    vitals: vitals[t.room] || { hr: 72, o2: 98, temp: 36.8, bp: 125 },
  }));

  const playerData = await Promise.all(playerIds.map(id => r.getPlayer(id)));
  const players = playerIds
    .map((id, i) => ({ id, ...playerData[i] }))
    .filter(p => p && p.name)
    .sort((a, b) => b.score - a.score);

  return { tasks: enrichedTasks, teamScore, vitals, players, rooms: PATIENTS };
}

async function broadcastWorldUpdate() {
  const state = await buildWorldState();
  io.emit('worldUpdate', state);
}

// ── Express / Socket.io ─────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Socket events ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  let eventCount = 0;
  const rateLimitClear = setInterval(() => { eventCount = 0; }, 1000);

  function rateCheck() {
    if (++eventCount > RATE_LIMIT) {
      console.warn(`[!] Rate limit: ${socket.id}`);
      return false;
    }
    return true;
  }

  socket.emit('requestName');

  // ── registerPlayer ────────────────────────────────────────
  socket.on('registerPlayer', async (name) => {
    if (!rateCheck()) return;
    name = String(name).trim().substring(0, 32);
    if (!name) return;

    const isFirst = (await r.getActivePlayerCount()) === 0;

    await r.setPlayer(socket.id, { name, score: 0, streak: 0 });
    await r.addPlayerToSet(socket.id);
    insertSession(socket.id, name);

    console.log(`[→] Registered: "${name}" (${socket.id})`);

    if (isFirst) {
      // Fresh world for the first player
      await r.flushWorldState();
      await r.setPlayer(socket.id, { name, score: 0, streak: 0 });
      await r.addPlayerToSet(socket.id);
      await r.initVitals();
      startSpawner();
    }

    const state = await buildWorldState();
    socket.emit('worldUpdate', state);
    socket.emit('leaderboardUpdate', getTopScores());

    if (!isFirst) await broadcastWorldUpdate();
  });

  // ── getLeaderboard ────────────────────────────────────────
  socket.on('getLeaderboard', () => {
    if (!rateCheck()) return;
    socket.emit('leaderboardUpdate', getTopScores());
  });

  // ── claimTask ─────────────────────────────────────────────
  socket.on('claimTask', async (taskId) => {
    if (!rateCheck()) return;
    const player = await r.getPlayer(socket.id);
    if (!player) return;

    const ok = await r.claimTask(taskId, socket.id, Math.round(70 * GAME_SPEED));
    if (!ok) {
      // If WE already hold the claim (double-tap / ghost click), ignore silently
      const existing = await r.getClaim(taskId);
      if (existing === socket.id) return;
      socket.emit('claimFailed', { taskId, reason: 'Bereits beansprucht' });
      return;
    }

    await r.updateTask(taskId, { claimedBy: socket.id, claimedByName: player.name });
    await broadcastWorldUpdate();
  });

  // ── resolveTask ───────────────────────────────────────────
  socket.on('resolveTask', async ({ taskId, chosenType }) => {
    if (!rateCheck()) return;
    const player = await r.getPlayer(socket.id);
    if (!player) return;

    // Must hold the claim
    if ((await r.getClaim(taskId)) !== socket.id) {
      socket.emit('resolveError', { taskId, reason: 'Du hältst diesen Auftrag nicht' });
      return;
    }

    const task = await r.getTask(taskId);
    if (!task) return; // expired

    const cfg     = URGENCY[task.urgency] || URGENCY.routine;
    const correct = chosenType === task.correctAction;
    const delta   = correct ? cfg.scoreCorrect : cfg.scoreWrong;

    const newScore = await r.incrPlayerScore(socket.id, delta);
    let newStreak = 0;
    let bonus = 0;

    if (correct) {
      newStreak = await r.incrPlayerStreak(socket.id);
      // Streak bonus every 3 correct in a row (capped at +20)
      if (newStreak % 3 === 0) {
        bonus = Math.min(20, 5 * (newStreak / 3));
        await r.incrPlayerScore(socket.id, bonus);
      }
      await r.incrTeamScore(cfg.scoreCorrect + bonus);
      // Apply symptom-specific recovery
      const sym = SYMPTOMS[task.symptom];
      await adjustVitals(task.room, sym ? sym.recovery : VITALS_RECOVER);
      await r.removeTask(taskId);
      await r.releaseClaim(taskId);
    } else {
      await r.setPlayerStreak(socket.id, 0);
      await r.incrTeamScore(cfg.scoreWrong);
      await adjustVitals(task.room, { hr: 2, o2: -1, temp: 0.1, bp: -2 });
      // Wrong answer: release the claim but keep the task on the board
      await r.releaseClaim(taskId);
      await r.updateTask(taskId, { claimedBy: null, claimedByName: null });
    }

    socket.emit('playerUpdate', {
      score:   newScore + bonus,
      streak:  newStreak,
      bonus,
      correct,
    });

    await broadcastWorldUpdate();
  });

  // ── releaseClaim (player closed modal without acting) ─────
  socket.on('releaseClaim', async (taskId) => {
    if (!rateCheck()) return;
    if ((await r.getClaim(taskId)) !== socket.id) return;
    await r.releaseClaim(taskId);
    await r.updateTask(taskId, { claimedBy: null, claimedByName: null });
    await broadcastWorldUpdate();
  });

  // ── disconnect ────────────────────────────────────────────
  socket.on('disconnect', async () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    clearInterval(rateLimitClear);

    const player = await r.getPlayer(socket.id);
    if (!player) return;

    finalizeSession(socket.id, player.score);

    if (player.score > 0) {
      insertScore(player.name, player.score);
      io.emit('leaderboardUpdate', getTopScores());
    }

    // Release any claims held by disconnecting player
    const tasks = await r.getTasks();
    await Promise.all(
      tasks
        .filter(t => t.claimedBy === socket.id)
        .map(async t => {
          await r.releaseClaim(t.id);
          await r.updateTask(t.id, { claimedBy: null, claimedByName: null });
        })
    );

    await r.deletePlayer(socket.id);
    await r.removePlayerFromSet(socket.id);

    const remaining = await r.getActivePlayerCount();
    if (remaining === 0) {
      stopSpawner();
      await r.flushWorldState();
    } else {
      await broadcastWorldUpdate();
    }
  });
});

// ── Helper ──────────────────────────────────────────────────

/** Weighted random urgency pick. */
function pickUrgency() {
  const roll = Math.random() * 100;
  if (roll < URGENCY.critical.weight) return 'critical';
  if (roll < URGENCY.critical.weight + URGENCY.urgent.weight) return 'urgent';
  return 'routine';
}

// ── Start ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Stations-Sprint → http://localhost:${PORT}`);
});
