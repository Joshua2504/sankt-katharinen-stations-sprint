/**
 * game.js — Stations-Sprint client
 *
 * Responsibilities:
 *   - Connect to the server via Socket.io
 *   - Send input events: registerPlayer, startGame, handleTask
 *   - Render server-pushed state: gameStateUpdate, leaderboardUpdate, gameOver
 *
 * The client NEVER calculates scores or generates tasks.
 * All authoritative data comes from the server.
 */

// ── Socket connection ───────────────────────────────────────
const socket = io();

// ── DOM refs ────────────────────────────────────────────────
const screenLobby    = document.getElementById('screen-lobby');
const screenGame     = document.getElementById('screen-game');
const screenGameover = document.getElementById('screen-gameover');

const nameInput      = document.getElementById('name-input');
const btnRegister    = document.getElementById('btn-register');
const btnPlayAgain   = document.getElementById('btn-play-again');

const hudTimer       = document.getElementById('hud-timer');
const hudScore       = document.getElementById('hud-score');
const hudName        = document.getElementById('hud-name');

const tasksContainer = document.getElementById('tasks-container');
const tasksEmpty     = document.getElementById('tasks-empty');

const lobbyBoard     = document.getElementById('lobby-leaderboard');
const gameBoard      = document.getElementById('game-leaderboard');
const gameoverBoard  = document.getElementById('gameover-leaderboard');

const finalScore     = document.getElementById('final-score');

// ── State ───────────────────────────────────────────────────
let playerName = '';

// Task type metadata for button rendering
const TASK_META = {
  medication:  { icon: '💊', color: 'bg-blue-600   hover:bg-blue-500',   label: 'Medikament geben' },
  bandage:     { icon: '🩹', color: 'bg-rose-600   hover:bg-rose-500',   label: 'Verband anlegen' },
  infusion:    { icon: '💉', color: 'bg-purple-600 hover:bg-purple-500', label: 'Infusion wechseln' },
  call_button: { icon: '🔔', color: 'bg-amber-600  hover:bg-amber-500',  label: 'Klingel beantworten' }
};

// ── Screen helpers ──────────────────────────────────────────
function showScreen(screen) {
  [screenLobby, screenGame, screenGameover].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// ── Leaderboard renderer ────────────────────────────────────
function renderLeaderboard(container, entries) {
  if (!entries || entries.length === 0) {
    container.innerHTML = '<p class="text-center text-slate-500 py-4">Noch keine Einträge</p>';
    return;
  }
  container.innerHTML = entries.map((e, i) => `
    <div class="flex items-center justify-between px-4 py-2">
      <span class="text-slate-400 w-6">${i + 1}.</span>
      <span class="flex-1 font-medium truncate">${escHtml(e.name)}</span>
      <span class="font-mono font-bold text-yellow-400">${e.score}</span>
    </div>
  `).join('');
}

// ── Task list renderer ──────────────────────────────────────
function renderTasks(tasks) {
  if (tasks.length === 0) {
    tasksContainer.innerHTML = '';
    tasksContainer.appendChild(tasksEmpty);
    tasksEmpty.style.display = 'block';
    return;
  }

  tasksEmpty.style.display = 'none';

  // Add new tasks and remove resolved ones
  const existingIds = new Set(
    [...tasksContainer.querySelectorAll('[data-task-id]')].map(el => el.dataset.taskId)
  );
  const incomingIds = new Set(tasks.map(t => t.id));

  // Remove tasks no longer in the list
  tasksContainer.querySelectorAll('[data-task-id]').forEach(el => {
    if (!incomingIds.has(el.dataset.taskId)) el.remove();
  });

  // Add new tasks (preserve order, avoid duplicate DOM nodes)
  tasks.forEach(task => {
    if (existingIds.has(task.id)) return; // already rendered

    const meta = TASK_META[task.type] || {
      icon: '❓', color: 'bg-slate-600 hover:bg-slate-500', label: task.type
    };

    const card = document.createElement('button');
    card.dataset.taskId   = task.id;
    card.dataset.taskType = task.type;
    card.className = [
      'task-card w-full rounded-xl text-white font-bold text-left px-5 py-4',
      'flex items-center gap-4 active:scale-95 transition',
      meta.color
    ].join(' ');
    card.style.minHeight = '80px';

    card.innerHTML = `
      <span class="text-4xl">${meta.icon}</span>
      <span class="flex-1 text-lg leading-tight">${escHtml(task.label || meta.label)}</span>
    `;

    // Clicking a task button sends handleTask to the server.
    // We pass the task's own type as the chosenType because each button IS its task.
    // (In a more complex UI you'd pick from multiple options — but here one button = one action.)
    card.addEventListener('click', () => {
      socket.emit('handleTask', { taskId: task.id, chosenType: task.type });
      card.remove(); // optimistic UI removal; server confirms via gameStateUpdate
    });

    tasksContainer.appendChild(card);
  });
}

// ── Utility ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Socket event handlers ───────────────────────────────────

// Server asks for player name → show lobby
socket.on('requestName', () => {
  const saved = localStorage.getItem('stationsSprintName') || '';
  nameInput.value = saved;
  showScreen(screenLobby);
  socket.emit('getLeaderboard');
});

// Server pushes authoritative game state every tick and on score changes
socket.on('gameStateUpdate', ({ score, timeLeft, tasks }) => {
  hudScore.textContent = score;
  hudTimer.textContent = timeLeft;

  // Color-code timer when low
  hudTimer.classList.toggle('text-red-400', timeLeft <= 10);
  hudTimer.classList.toggle('text-emerald-400', timeLeft > 10);

  renderTasks(tasks);
});

// Leaderboard update broadcast (also sent on connect)
socket.on('leaderboardUpdate', (entries) => {
  renderLeaderboard(lobbyBoard, entries);
  renderLeaderboard(gameBoard, entries);
  renderLeaderboard(gameoverBoard, entries);
});

// Game finished
socket.on('gameOver', ({ score }) => {
  finalScore.textContent = score;
  showScreen(screenGameover);
});

// ── UI interactions ─────────────────────────────────────────

// Register + start game
btnRegister.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  playerName = name;
  localStorage.setItem('stationsSprintName', name);
  hudName.textContent = name;

  socket.emit('registerPlayer', name);

  showScreen(screenGame);
  socket.emit('startGame');
});

// Enter key on name input
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnRegister.click();
});

// Play again — go back to lobby and re-register
btnPlayAgain.addEventListener('click', () => {
  showScreen(screenLobby);
  socket.emit('getLeaderboard');
});
