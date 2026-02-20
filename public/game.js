/**
 * game.js — Stations-Sprint client (Shared World Edition)
 *
 * Responsibilities:
 *   - Render worldUpdate: floor plan, vitals, tasks, players, scores
 *   - Send: registerPlayer, claimTask, resolveTask, releaseClaim
 *
 * The client NEVER calculates scores or generates tasks.
 * All authoritative state comes from the server.
 */

// ── Socket ───────────────────────────────────────────────────
const socket = io();

// ── DOM refs ─────────────────────────────────────────────────
const screenLobby  = document.getElementById('screen-lobby');
const screenGame   = document.getElementById('screen-game');
const nameInput    = document.getElementById('name-input');
const btnRegister  = document.getElementById('btn-register');
const hudTeamScore = document.getElementById('hud-team-score');
const hudPlayers   = document.getElementById('hud-players');
const hudMyScore   = document.getElementById('hud-my-score');
const hudStreak    = document.getElementById('hud-streak');
const playersStrip = document.getElementById('players-strip');
const wardGrid     = document.getElementById('ward-grid');
const lobbyBoard   = document.getElementById('lobby-leaderboard');
const gameBoard    = document.getElementById('game-leaderboard');
const taskModal    = document.getElementById('task-modal');
const modalPatient = document.getElementById('modal-patient');
const modalLabel   = document.getElementById('modal-task-label');
const modalUrgency = document.getElementById('modal-urgency-badge');
const modalTtlBar  = document.getElementById('modal-ttl-bar');
const modalActions = document.getElementById('modal-actions');
const modalCloseBtn = document.getElementById('modal-close-btn');
const toastEl      = document.getElementById('toast');
const toastInner   = document.getElementById('toast-inner');

// ── Client state (rendering only — no game logic) ────────────
let mySocketId  = null;
let activeModal = null;   // { taskId, ttlInterval, openedAt }
let toastTimer  = null;

// ── Metadata ──────────────────────────────────────────────────
// 6 treatment actions a player can choose
const ACTION_META = {
  betablocker:   { icon: '💊', label: 'Betablocker',       color: 'bg-blue-600   hover:bg-blue-500'   },
  sauerstoff:    { icon: '🫁', label: 'Sauerstoffmaske',   color: 'bg-cyan-600   hover:bg-cyan-500'   },
  fiebermittel:  { icon: '🌡️', label: 'Fiebermittel',      color: 'bg-orange-600 hover:bg-orange-500' },
  infusion:      { icon: '💧', label: 'Infusion',           color: 'bg-purple-600 hover:bg-purple-500' },
  schmerzmittel: { icon: '💊', label: 'Schmerzmittel',     color: 'bg-rose-600   hover:bg-rose-500'   },
  verband:       { icon: '🩹', label: 'Verband wechseln',  color: 'bg-amber-600  hover:bg-amber-500'  },
};

// Symptom display metadata (matches server-side SYMPTOMS keys)
const SYMPTOM_META = {
  tachycardia:  { icon: '❤️‍🔥', label: 'Herzrasen'           },
  bradycardia:  { icon: '💔',     label: 'Bradykardie'         },
  hypoxia:      { icon: '🫁',     label: 'Atemnot'             },
  fever:        { icon: '🤒',     label: 'Fieber'              },
  hypotension:  { icon: '🫨',     label: 'Kreislaufschwäche'  },
  hypertension: { icon: '💢',     label: 'Bluthochdruck-Krise' },
  pain:         { icon: '😖',     label: 'Starke Schmerzen'    },
  bleeding:     { icon: '🩸',     label: 'Nachblutung'         },
};

const URGENCY_META = {
  routine:  { label: 'Routine',  bg: 'bg-slate-600',  text: 'text-slate-200', border: 'border-slate-500'  },
  urgent:   { label: 'Dringend', bg: 'bg-orange-500', text: 'text-white',     border: 'border-orange-400' },
  critical: { label: 'Kritisch', bg: 'bg-red-600',    text: 'text-white',     border: 'border-red-400'    },
};

// ── Screens ───────────────────────────────────────────────────
function showScreen(screen) {
  [screenLobby, screenGame].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// ── Leaderboard ───────────────────────────────────────────────
function renderLeaderboard(container, entries) {
  if (!entries || entries.length === 0) {
    container.innerHTML = '<p class="text-center text-slate-500 py-3 text-xs">Noch keine Einträge</p>';
    return;
  }
  if (container === gameBoard) {
    container.innerHTML = entries.slice(0, 5).map((e, i) => `
      <div class="flex flex-col items-center gap-0.5 min-w-fit px-3 py-1 bg-slate-700/60 rounded-lg">
        <span class="text-slate-400 text-[10px]">#${i + 1}</span>
        <span class="font-medium text-xs truncate max-w-[70px]">${esc(e.name)}</span>
        <span class="font-mono font-bold text-yellow-400 text-sm">${e.score}</span>
      </div>
    `).join('');
  } else {
    container.innerHTML = entries.map((e, i) => `
      <div class="flex items-center justify-between px-4 py-2">
        <span class="text-slate-400 w-6 text-sm">${i + 1}.</span>
        <span class="flex-1 font-medium truncate text-sm">${esc(e.name)}</span>
        <span class="font-mono font-bold text-yellow-400">${e.score}</span>
      </div>
    `).join('');
  }
}

// ── Ward floor plan ───────────────────────────────────────────
function renderWard({ tasks = [], vitals = {}, rooms = [] }) {
  rooms.forEach(({ room, name }) => {
    let card = document.getElementById(`room-${room}`);
    if (!card) {
      card = document.createElement('div');
      card.id = `room-${room}`;
      wardGrid.appendChild(card);
    }

    const v        = vitals[room] || { hr: 72, o2: 98, temp: 36.8, bp: 125 };
    const hrWarn   = v.hr > 100 || v.hr < 55;
    const o2Warn   = v.o2 < 94;
    const hrCrit   = v.hr > 115 || v.hr < 45;
    const o2Crit   = v.o2 < 90;
    const tempWarn = v.temp > 38.0;
    const tempCrit = v.temp > 39.5;
    const bpWarn   = v.bp < 100 || v.bp > 150;
    const bpCrit   = v.bp < 85  || v.bp > 170;

    const roomTasks = tasks.filter(t => t.room === room);
    const topTask   = roomTasks[0] || null;
    const urgency   = topTask ? topTask.urgency : null;
    const umeta     = urgency ? URGENCY_META[urgency] : null;

    const borderCls = urgency === 'critical' ? 'border-red-500'
                    : urgency === 'urgent'   ? 'border-orange-500'
                    :                          'border-slate-700';
    const pulseCls  = urgency === 'critical' ? 'pulse-critical'
                    : urgency === 'urgent'   ? 'pulse-urgent'
                    :                          '';

    card.className = `relative rounded-2xl bg-slate-800 border-2 ${borderCls} ${pulseCls} p-3 flex flex-col gap-2 transition-all duration-300`;

    const claimed     = topTask && topTask.claimedBy;
    const claimedByMe = topTask && topTask.claimedBy === mySocketId;

    card.style.cursor = (topTask && !claimed) ? 'pointer' : 'default';
    card.onclick = (topTask && !claimed)
      ? (e) => { e.stopPropagation(); handleClaim(topTask); }
      : null;

    const symMeta = topTask ? (SYMPTOM_META[topTask.symptom] || { icon: '❓', label: topTask.label }) : null;

    card.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Zi. ${room}</span>
        ${umeta ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full ${umeta.bg} ${umeta.text}">${umeta.label}</span>` : ''}
      </div>

      <p class="font-bold text-sm text-white leading-tight truncate">${esc(name)}</p>

      <div class="grid grid-cols-4 gap-1 text-[10px]">
        <span class="${hrCrit ? 'vital-crit' : hrWarn ? 'vital-warn' : 'text-slate-400'}">
          ❤️ <span class="font-mono font-bold">${v.hr}</span>
        </span>
        <span class="${o2Crit ? 'vital-crit' : o2Warn ? 'vital-warn' : 'text-slate-400'}">
          💨 <span class="font-mono font-bold">${v.o2}%</span>
        </span>
        <span class="${tempCrit ? 'vital-crit' : tempWarn ? 'vital-warn' : 'text-slate-400'}">
          🌡 <span class="font-mono font-bold">${v.temp}°</span>
        </span>
        <span class="${bpCrit ? 'vital-crit' : bpWarn ? 'vital-warn' : 'text-slate-400'}">
          🩸 <span class="font-mono font-bold">${v.bp}</span>
        </span>
      </div>

      ${topTask ? `
        <div class="mt-1">
          ${claimed ? `
            <p class="text-[11px] text-slate-400 italic">
              ${claimedByMe ? '📋 Du hast übernommen …' : `📋 ${esc(topTask.claimedByName || '?')} übernimmt …`}
            </p>
          ` : `
            <div class="rounded-xl ${umeta ? umeta.bg : 'bg-slate-700'} ${umeta ? umeta.text : 'text-white'} px-3 py-2.5 text-sm font-semibold" style="min-height:52px">
              ${symMeta.icon} ${esc(topTask.label)}
              <span class="block text-[10px] font-normal opacity-70 mt-0.5">Antippen zum Übernehmen</span>
            </div>
          `}
          ${roomTasks.length > 1 ? `<p class="text-[10px] text-slate-500 mt-1">+${roomTasks.length - 1} weitere</p>` : ''}
        </div>
      ` : `<p class="text-[11px] text-slate-500 mt-1 italic">Alles in Ordnung ✓</p>`}
    `;
  });
}

// ── Players strip ─────────────────────────────────────────────
function renderPlayersStrip(players) {
  if (!players || players.length === 0) {
    playersStrip.innerHTML = '<span class="text-slate-500 italic">Keine weiteren Spieler online</span>';
    return;
  }
  playersStrip.innerHTML = players.map(p => {
    const isMe = p.id === mySocketId;
    return `<span class="${isMe ? 'text-emerald-400 font-bold' : 'text-slate-300'} whitespace-nowrap">
      ${isMe ? '🧑‍⚕️' : '👤'} ${esc(p.name)} <span class="font-mono text-yellow-400">${p.score}</span>
    </span>`;
  }).join('<span class="text-slate-600 mx-1">·</span>');
}

// ── Claiming ──────────────────────────────────────────────────
function handleClaim(task) {
  if (activeModal) return; // already in a claim — ignore ghost clicks / double-taps
  socket.emit('claimTask', task.id);
  openModal(task); // optimistic open; server confirms or sends claimFailed
}

function openModal(task) {
  if (activeModal) {
    clearInterval(activeModal.ttlInterval);
    activeModal = null;
  }

  const symMeta = SYMPTOM_META[task.symptom] || { icon: '❓', label: task.label };
  const umeta   = URGENCY_META[task.urgency] || URGENCY_META.routine;

  modalPatient.textContent = `Zimmer ${task.room} · ${esc(task.patient)}`;
  modalLabel.textContent   = `${symMeta.icon} ${symMeta.label}`;
  modalUrgency.textContent = umeta.label;
  modalUrgency.className   = `inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded-full ${umeta.bg} ${umeta.text}`;

  // Hint text
  const hintEl = document.getElementById('modal-hint');
  if (hintEl) hintEl.textContent = task.hint || '';

  // Vitals display in modal
  const vitalsEl = document.getElementById('modal-vitals');
  if (vitalsEl && task.vitals) {
    const v = task.vitals;
    const hrW = v.hr > 100 || v.hr < 55; const hrC = v.hr > 115 || v.hr < 45;
    const o2W = v.o2 < 94;               const o2C = v.o2 < 90;
    const tW  = v.temp > 38.0;           const tC  = v.temp > 39.5;
    const bpW = v.bp < 100 || v.bp > 150; const bpC = v.bp < 85 || v.bp > 170;
    vitalsEl.innerHTML = `
      <span class="${hrC ? 'vital-crit' : hrW ? 'vital-warn' : 'text-slate-300'}">❤️ <strong class="font-mono">${v.hr}</strong> bpm</span>
      <span class="${o2C ? 'vital-crit' : o2W ? 'vital-warn' : 'text-slate-300'}">💨 <strong class="font-mono">${v.o2}%</strong> SpO₂</span>
      <span class="${tC ? 'vital-crit' : tW ? 'vital-warn' : 'text-slate-300'}">🌡 <strong class="font-mono">${v.temp}°</strong> Temp</span>
      <span class="${bpC ? 'vital-crit' : bpW ? 'vital-warn' : 'text-slate-300'}">🩸 <strong class="font-mono">${v.bp}</strong> mmHg</span>
    `;
  }

  // 6 action buttons (3×2 grid)
  modalActions.innerHTML = Object.entries(ACTION_META).map(([actionKey, m]) => `
    <button
      data-resolve="${task.id}" data-type="${actionKey}"
      class="rounded-xl ${m.color} text-white font-bold px-2 py-3 active:scale-95 transition flex flex-col items-center gap-1"
      style="min-height:72px"
    >
      <span class="text-2xl">${m.icon}</span>
      <span class="text-[11px] leading-tight text-center">${m.label}</span>
    </button>
  `).join('');

  modalActions.querySelectorAll('[data-resolve]').forEach(btn => {
    btn.addEventListener('click', () => {
      resolveTask(btn.dataset.resolve, btn.dataset.type);
    });
  });

  // TTL bar
  const totalTtl = task.expiresAt - Date.now();
  modalTtlBar.style.width = '100%';
  const ttlInterval = setInterval(() => {
    const remaining = Math.max(0, task.expiresAt - Date.now());
    const pct = totalTtl > 0 ? (remaining / totalTtl) * 100 : 0;
    modalTtlBar.style.width = `${pct}%`;
    modalTtlBar.className = `ttl-bar h-1.5 rounded-full ${pct > 50 ? 'bg-emerald-400' : pct > 20 ? 'bg-orange-400' : 'bg-red-500'}`;
    if (remaining === 0) closeModal(); // TTL expired
  }, 300);

  activeModal = { taskId: task.id, ttlInterval };

  taskModal.style.pointerEvents = 'none';
  setTimeout(() => { taskModal.style.pointerEvents = ''; }, 600);

  taskModal.classList.remove('hidden');
  taskModal.classList.add('flex');
}

/**
 * Close the modal.
 * @param {boolean} force — bypass the ghost-click guard (TTL expiry, worldUpdate, etc.)
 */
function closeModal() {
  if (!activeModal) return;
  clearInterval(activeModal.ttlInterval);
  socket.emit('releaseClaim', activeModal.taskId);
  activeModal = null;
  taskModal.style.pointerEvents = '';
  taskModal.classList.add('hidden');
  taskModal.classList.remove('flex');
}

function resolveTask(taskId, chosenType) {
  if (activeModal && activeModal.taskId === taskId) {
    clearInterval(activeModal.ttlInterval);
    activeModal = null;
  }
  socket.emit('resolveTask', { taskId, chosenType });
  taskModal.style.pointerEvents = '';
  taskModal.classList.add('hidden');
  taskModal.classList.remove('flex');
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, colorCls = 'bg-orange-500') {
  clearTimeout(toastTimer);
  toastInner.textContent = msg;
  toastInner.className   = `toast ${colorCls} text-white font-bold px-5 py-3 rounded-xl shadow-xl text-sm text-center whitespace-nowrap`;
  toastEl.classList.remove('hidden');
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2800);
}

// ── Utility ───────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Socket events ─────────────────────────────────────────────

socket.on('connect', () => { mySocketId = socket.id; });

socket.on('requestName', () => {
  nameInput.value = localStorage.getItem('stationsSprintName') || '';
  showScreen(screenLobby);
  socket.emit('getLeaderboard');
});

socket.on('worldUpdate', (state) => {
  hudTeamScore.textContent = state.teamScore ?? 0;

  const count = state.players?.length ?? 0;
  hudPlayers.textContent = `${count} Pflegekraft${count !== 1 ? 'kraft' : ''}`;

  const me = state.players?.find(p => p.id === mySocketId);
  if (me) {
    hudMyScore.textContent = me.score;
    if (me.streak >= 3) {
      hudStreak.textContent = `×${me.streak}`;
      hudStreak.classList.remove('hidden');
    } else {
      hudStreak.classList.add('hidden');
    }
  }

  renderPlayersStrip(state.players);
  renderWard(state);

  // Force-close modal if the claimed task no longer exists (resolved or expired by server)
  if (activeModal) {
    const stillExists = state.tasks?.some(t => t.id === activeModal.taskId);
    if (!stillExists) {
      clearInterval(activeModal.ttlInterval);
      activeModal = null;
      taskModal.style.pointerEvents = '';
      taskModal.classList.add('hidden');
      taskModal.classList.remove('flex');
    }
  }
});

socket.on('playerUpdate', ({ score, streak, bonus, correct }) => {
  hudMyScore.textContent = score;

  if (streak >= 3) {
    hudStreak.textContent = `×${streak}`;
    hudStreak.classList.remove('hidden');
    hudStreak.classList.add('streak-pop');
    setTimeout(() => hudStreak.classList.remove('streak-pop'), 300);
  } else {
    hudStreak.classList.add('hidden');
  }

  if (bonus > 0)      showToast(`🔥 Streak-Bonus! +${bonus} Punkte`, 'bg-orange-500');
  else if (correct)   showToast('✓ Richtig!',           'bg-emerald-600');
  else                showToast('✗ Falsche Maßnahme',   'bg-red-600');
});

socket.on('claimFailed', ({ reason }) => {
  if (activeModal) { clearInterval(activeModal.ttlInterval); activeModal = null; }
  taskModal.style.pointerEvents = '';
  taskModal.classList.add('hidden');
  taskModal.classList.remove('flex');
  showToast(`⚡ ${reason}`, 'bg-slate-600');
});

socket.on('leaderboardUpdate', (entries) => {
  renderLeaderboard(lobbyBoard, entries);
  renderLeaderboard(gameBoard, entries);
});

// ── UI interactions ───────────────────────────────────────────

btnRegister.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  localStorage.setItem('stationsSprintName', name);
  socket.emit('registerPlayer', name);
  showScreen(screenGame);
});

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnRegister.click();
});

// Modal close button and backdrop
modalCloseBtn.addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', closeModal);
