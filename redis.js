/**
 * redis.js — Redis helper layer for Stations-Sprint
 *
 * All live game state lives in Redis:
 *   world:tasks          → Redis List, each item is a JSON-serialised task
 *   world:teamScore      → Redis String (integer counter)
 *   vitals:{roomNum}     → Redis Hash  { hr, o2 }
 *   player:{socketId}    → Redis Hash  { name, score, streak }
 *   active:players       → Redis Set   of socketIds
 *   claim:{taskId}       → Redis String (socketId, TTL 20 s via EXPIRE)
 *
 * SQLite (better-sqlite3) stays for durable persistence:
 *   leaderboard          → top-10 all-time scores
 *   players_sessions     → connect/disconnect audit trail
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis     = new Redis(REDIS_URL, { lazyConnect: false });

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error',   (err) => console.error('[Redis] Error:', err.message));

// ── Task queue ──────────────────────────────────────────────

/** Push a new task onto the world task list. */
async function addTask(task) {
  await redis.rpush('world:tasks', JSON.stringify(task));
}

/** Get all current tasks as parsed objects. */
async function getTasks() {
  const raw = await redis.lrange('world:tasks', 0, -1);
  return raw.map(r => JSON.parse(r));
}

/** Remove a specific task by id from the list. */
async function removeTask(taskId) {
  const raw = await redis.lrange('world:tasks', 0, -1);
  for (const item of raw) {
    const t = JSON.parse(item);
    if (t.id === taskId) {
      // LREM count=0 removes all occurrences of this exact serialised value
      await redis.lrem('world:tasks', 0, item);
      return t; // return the removed task
    }
  }
  return null;
}

/** Update a task in place (e.g. set claimedBy). */
async function updateTask(taskId, patch) {
  const raw = await redis.lrange('world:tasks', 0, -1);
  for (let i = 0; i < raw.length; i++) {
    const t = JSON.parse(raw[i]);
    if (t.id === taskId) {
      const updated = { ...t, ...patch };
      // Replace via index: LSET key index value
      await redis.lset('world:tasks', i, JSON.stringify(updated));
      return updated;
    }
  }
  return null;
}

/** Get a single task by id. */
async function getTask(taskId) {
  const tasks = await getTasks();
  return tasks.find(t => t.id === taskId) || null;
}

// ── Team score ──────────────────────────────────────────────

async function getTeamScore() {
  const val = await redis.get('world:teamScore');
  return parseInt(val || '0', 10);
}

async function incrTeamScore(delta) {
  if (delta >= 0) return redis.incrby('world:teamScore', delta);
  return redis.decrby('world:teamScore', Math.abs(delta));
}

// ── Vitals ──────────────────────────────────────────────────

/** Get vitals for all 8 rooms as { roomNum: { hr, o2 } } */
const BASELINE_VITALS = { hr: 72, o2: 98, temp: 36.8, bp: 125 };

async function getAllVitals() {
  const result = {};
  const pipeline = redis.pipeline();
  for (let i = 1; i <= 8; i++) pipeline.hgetall(`vitals:${i}`);
  const responses = await pipeline.exec();
  for (let i = 0; i < 8; i++) {
    const [err, data] = responses[i];
    const roomNum = i + 1;
    if (!err && data && data.hr) {
      result[roomNum] = {
        hr:   parseInt(data.hr, 10),
        o2:   parseInt(data.o2, 10),
        temp: parseFloat(data.temp),
        bp:   parseInt(data.bp, 10),
      };
    } else {
      result[roomNum] = { ...BASELINE_VITALS };
    }
  }
  return result;
}

async function setVitals(roomNum, { hr, o2, temp, bp }) {
  await redis.hset(`vitals:${roomNum}`,
    'hr',   String(hr),
    'o2',   String(o2),
    'temp', String(temp),
    'bp',   String(bp)
  );
}

/** Initialise all 8 rooms to baseline vitals (called on first player connect). */
async function initVitals() {
  const pipeline = redis.pipeline();
  for (let i = 1; i <= 8; i++) {
    pipeline.hset(`vitals:${i}`,
      'hr',   String(BASELINE_VITALS.hr),
      'o2',   String(BASELINE_VITALS.o2),
      'temp', String(BASELINE_VITALS.temp),
      'bp',   String(BASELINE_VITALS.bp)
    );
  }
  await pipeline.exec();
}

// ── Player sessions ─────────────────────────────────────────

async function setPlayer(socketId, data) {
  // data: { name, score, streak }
  await redis.hset(`player:${socketId}`,
    'name',   String(data.name),
    'score',  String(data.score  ?? 0),
    'streak', String(data.streak ?? 0)
  );
}

async function getPlayer(socketId) {
  const data = await redis.hgetall(`player:${socketId}`);
  if (!data || !data.name) return null;
  return {
    name:   data.name,
    score:  parseInt(data.score,  10),
    streak: parseInt(data.streak, 10)
  };
}

async function deletePlayer(socketId) {
  await redis.del(`player:${socketId}`);
}

/** Atomically increment player score. Returns new score. */
async function incrPlayerScore(socketId, delta) {
  if (delta >= 0) return redis.hincrby(`player:${socketId}`, 'score', delta);
  return redis.hincrby(`player:${socketId}`, 'score', delta); // hincrby handles negatives
}

/** Set player streak field. */
async function setPlayerStreak(socketId, streak) {
  await redis.hset(`player:${socketId}`, 'streak', String(streak));
}

async function incrPlayerStreak(socketId) {
  return redis.hincrby(`player:${socketId}`, 'streak', 1);
}

// ── Active player set ───────────────────────────────────────

async function addPlayerToSet(socketId) {
  await redis.sadd('active:players', socketId);
}

async function removePlayerFromSet(socketId) {
  await redis.srem('active:players', socketId);
}

async function getActivePlayers() {
  return redis.smembers('active:players');
}

async function getActivePlayerCount() {
  return redis.scard('active:players');
}

// ── Task claiming (atomic SET NX EX) ───────────────────────

/**
 * Try to claim a task exclusively.
 * Returns true if claim succeeded, false if already claimed by someone else.
 * Claim auto-expires after 20 seconds via Redis TTL.
 */
async function claimTask(taskId, socketId, ttlSeconds = 70) {
  const result = await redis.set(`claim:${taskId}`, socketId, 'NX', 'EX', ttlSeconds);
  return result === 'OK'; // 'OK' = claimed, null = already taken
}

async function releaseClaim(taskId) {
  await redis.del(`claim:${taskId}`);
}

async function getClaim(taskId) {
  return redis.get(`claim:${taskId}`); // returns socketId or null
}

// ── Cleanup helpers ─────────────────────────────────────────

/** Clear all transient world state (call when last player leaves). */
async function flushWorldState() {
  const pipeline = redis.pipeline();
  pipeline.del('world:tasks');
  pipeline.del('world:teamScore');
  pipeline.del('active:players');
  for (let i = 1; i <= 8; i++) pipeline.del(`vitals:${i}`);
  await pipeline.exec();
}

module.exports = {
  redis, // raw client for advanced use
  // Tasks
  addTask, getTasks, removeTask, updateTask, getTask,
  // Team score
  getTeamScore, incrTeamScore,
  // Vitals
  getAllVitals, setVitals, initVitals,
  // Players
  setPlayer, getPlayer, deletePlayer, incrPlayerScore, setPlayerStreak, incrPlayerStreak,
  // Active set
  addPlayerToSet, removePlayerFromSet, getActivePlayers, getActivePlayerCount,
  // Claims
  claimTask, releaseClaim, getClaim,
  // Cleanup
  flushWorldState,
};
