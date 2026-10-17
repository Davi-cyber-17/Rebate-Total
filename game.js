(() => {
'use strict';

/* =====================================================================
   CONFIGURAÇÃO
   ===================================================================== */
const COLORS = ['#00f0ff', '#ff2a7a', '#ffd400', '#39ff88'];
const SIDES = ['left', 'right', 'top', 'bottom'];
const SIDE_DIR = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const PUCK_R = 16;
const MALLET_R = 30;
const STEP = 1 / 120;          // passo fixo da física
const NET_RATE = 1 / 30;       // 30 envios por segundo
const PEER_PREFIX = 'neon-rebatetotal-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    // retransmissão (TURN) de reserva para redes móveis/CG-NAT onde a conexão direta falha ou fica instável
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};
const CONN_OPTS = { reliable: false, serialization: 'json' };   // sem bloqueio de ordem + JSON leve
const MAX_BUFFER = 4096;       // bytes pendentes no canal antes de pular um envio (evita acumular atraso)
const TOUCH_LIFT = 56;         // px: o taco fica acima do dedo para não ficar escondido

const DIFFS = {
  easy:   { label: 'EASY',   cap: 300, react: 0.22, err: 90, predict: false },
  medium: { label: 'MEDIUM', cap: 520, react: 0.12, err: 45, predict: true },
  hard:   { label: 'HARD',   cap: 860, react: 0.04, err: 14, predict: true }
};

const KEYS_WASD   = { u: 'KeyW', d: 'KeyS', l: 'KeyA', r: 'KeyD' };
const KEYS_ARROWS = { u: 'ArrowUp', d: 'ArrowDown', l: 'ArrowLeft', r: 'ArrowRight' };

/* =====================================================================
   UTILITÁRIOS
   ===================================================================== */
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const fold = (y, min, max) => {
  const range = max - min;
  let v = (y - min) % (2 * range);
  if (v < 0) v += 2 * range;
  if (v > range) v = 2 * range - v;
  return min + v;
};
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 12);
const randomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const congested = (conn) => {
  try {
    if (conn.bufferSize > 2) return true;
    return !!(conn.dataChannel && conn.dataChannel.bufferedAmount > MAX_BUFFER);
  } catch (e) { return false; }
};
const isTouchDevice = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

function copyText(txt, okMsg) {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? okMsg : 'Não foi possível copiar.');
    } catch (e) { toast('Não foi possível copiar.'); }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(txt).then(() => toast(okMsg), fallback);
  } else fallback();
}

/* ---------- Som (WebAudio, sem arquivos) ---------- */
let audioCtx = null;
let muted = false;
function beep(freq = 440, dur = 0.08, type = 'sine', vol = 0.06) {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur);
  } catch (e) { /* sem áudio, segue o jogo */ }
}

/* ---------- Tela sempre ligada (celular) ---------- */
let wakeLock = null;
async function lockScreen() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* não suportado */ }
}
function unlockScreen() {
  try { wakeLock && wakeLock.release(); } catch (e) { /* ok */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && game) lockScreen(); });

/* =====================================================================
   MOTOR DO JOGO (roda no modo local e no anfitrião da sala)
   ===================================================================== */
class Game {
  constructor(cfg) {
    this.n = cfg.players.length;
    this.pts = cfg.pts;
    this.label = cfg.label || '';
    this.w = this.n === 2 ? 800 : 700;
    this.h = this.n === 2 ? 500 : 700;
    this.gh = this.n === 2 ? 190 : 240;      // abertura do gol

    this.players = cfg.players.map((pl, i) => {
      const side = SIDES[i];
      const s = this.startPos(side);
      return {
        idx: i, name: pl.name, color: COLORS[i], side,
        score: 0, active: true,
        x: s[0], y: s[1], vx: 0, vy: 0,
        tx: s[0], ty: s[1], keyActive: false,
        speedCap: pl.ai ? pl.ai.cap : 0,
        ai: pl.ai ? { ...pl.ai, t: 0 } : null
      };
    });

    this.puck = { x: this.w / 2, y: this.h / 2, vx: 0, vy: 0 };
    this.status = 'serve';                   // serve | play | over
    this.cd = 1.8;
    this.winner = -1;
    this.lastTouch = -1;
    this.serveTo = Math.floor(Math.random() * this.n);
    this.events = [];
    this.t = 0;
    this.lastHitT = 0;
    this.lastWallT = 0;
    this.idle = 0;
  }

  startPos(side) {
    const { w, h } = this;
    if (side === 'left') return [w * 0.12, h / 2];
    if (side === 'right') return [w * 0.88, h / 2];
    if (side === 'top') return [w / 2, h * 0.12];
    return [w / 2, h * 0.88];
  }

  zone(side) {
    const { w, h, n } = this;
    const M = MALLET_R;
    const dx = n === 2 ? w / 2 - M - 24 : w * 0.36;
    const dy = h * 0.36;
    if (side === 'left') return { x0: M, x1: dx, y0: M, y1: h - M };
    if (side === 'right') return { x0: w - dx, x1: w - M, y0: M, y1: h - M };
    if (side === 'top') return { x0: M, x1: w - M, y0: M, y1: dy };
    return { x0: M, x1: w - M, y0: h - dy, y1: h - M };
  }

  hasGoal(side) {
    return this.players.some((p) => p.active && p.side === side);
  }

  removePlayer(idx) {
    const p = this.players[idx];
    if (!p || !p.active) return;
    p.active = false;
    const alive = this.players.filter((q) => q.active);
    if (alive.length < 2 && this.status !== 'over') {
      this.status = 'over';
      this.winner = alive.length ? alive[0].idx : -1;
      this.events.push({ t: 'over' });
    }
  }

  /* ---------- Movimento do taco (também usado na previsão do cliente) ---------- */
  moveMallet(p, dt) {
    const cap = p.speedCap || (p.keyActive ? 560 : 1100);
    const z = this.zone(p.side);
    const tx = clamp(p.tx, z.x0, z.x1);
    const ty = clamp(p.ty, z.y0, z.y1);
    const dx = tx - p.x, dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    const mv = cap * dt;
    let nx = tx, ny = ty;
    if (d > mv) { nx = p.x + (dx / d) * mv; ny = p.y + (dy / d) * mv; }
    p.vx = (nx - p.x) / dt;
    p.vy = (ny - p.y) / dt;
    p.x = nx;
    p.y = ny;
  }

  /* ---------- IA ---------- */
  aiThink(p, dt) {
    const a = p.ai;
    a.t -= dt;
    if (a.t > 0) return;
    a.t = a.react;

    const pk = this.puck;
    const { w, h } = this;
    const homeX = w - 70;
    let tx, ty;

    if (this.status === 'play' && pk.x > w / 2 - 20) {
      if (pk.x < p.x - 4) {
        tx = pk.x;
        ty = pk.y + (Math.random() - 0.5) * a.err * 0.4;
      } else {
        tx = Math.min(pk.x + 50, w - MALLET_R);
        ty = pk.y + (p.y < pk.y ? 1 : -1) * (MALLET_R + PUCK_R + 20);
      }
    } else {
      tx = homeX;
      let y;
      if (a.predict && pk.vx > 20 && this.status === 'play') {
        y = fold(pk.y + pk.vy * ((homeX - pk.x) / pk.vx), PUCK_R, h - PUCK_R);
      } else {
        y = h / 2 + (pk.y - h / 2) * 0.55;
      }
      ty = y + (Math.random() - 0.5) * a.err;
      const gy = this.gh / 2 + 10;
      ty = clamp(ty, h / 2 - gy, h / 2 + gy);
    }
    p.tx = tx;
    p.ty = ty;
  }

  /* ---------- Física ---------- */
  step(dt) {
    this.t += dt;
    const { w, h } = this;

    for (const p of this.players) {
      if (!p.active) continue;
      if (p.ai) this.aiThink(p, dt);
      this.moveMallet(p, dt);
    }

    if (this.status === 'serve') {
      this.cd -= dt;
      if (this.cd <= 0) this.launch(this.players[this.serveTo]);
      return;
    }
    if (this.status !== 'play') return;

    const pk = this.puck;
    pk.x += pk.vx * dt;
    pk.y += pk.vy * dt;
    const f = Math.exp(-0.45 * dt);          // atrito do ar
    pk.vx *= f;
    pk.vy *= f;

    // colisão taco x disco
    for (const p of this.players) {
      if (!p.active) continue;
      const dx = pk.x - p.x, dy = pk.y - p.y;
      const dist = Math.hypot(dx, dy);
      const min = PUCK_R + MALLET_R;
      if (dist < min) {
        const nx = dist ? dx / dist : 1;
        const ny = dist ? dy / dist : 0;
        pk.x = p.x + nx * min;
        pk.y = p.y + ny * min;
        const rvx = pk.vx - p.vx, rvy = pk.vy - p.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const j = -(1 + 0.92) * vn;
          pk.vx += j * nx;
          pk.vy += j * ny;
        }
        this.lastTouch = p.idx;
        if (this.t - this.lastHitT > 0.06) {
          this.events.push({ t: 'hit' });
          this.lastHitT = this.t;
        }
      }
    }

    // paredes e gols
    const r = PUCK_R;
    const gh2 = this.gh / 2 - r * 0.6;
    const REST = 0.94;
    let bounced = false;

    if (pk.x - r < 0) {
      if (this.hasGoal('left') && Math.abs(pk.y - h / 2) < gh2) {
        if (pk.x < -r) return this.goal('left');
      } else { pk.x = r; pk.vx = Math.abs(pk.vx) * REST; bounced = true; }
    }
    if (pk.x + r > w) {
      if (this.hasGoal('right') && Math.abs(pk.y - h / 2) < gh2) {
        if (pk.x > w + r) return this.goal('right');
      } else { pk.x = w - r; pk.vx = -Math.abs(pk.vx) * REST; bounced = true; }
    }
    if (pk.y - r < 0) {
      if (this.hasGoal('top') && Math.abs(pk.x - w / 2) < gh2) {
        if (pk.y < -r) return this.goal('top');
      } else { pk.y = r; pk.vy = Math.abs(pk.vy) * REST; bounced = true; }
    }
    if (pk.y + r > h) {
      if (this.hasGoal('bottom') && Math.abs(pk.x - w / 2) < gh2) {
        if (pk.y > h + r) return this.goal('bottom');
      } else { pk.y = h - r; pk.vy = -Math.abs(pk.vy) * REST; bounced = true; }
    }
    if (bounced && this.t - this.lastWallT > 0.08) {
      this.events.push({ t: 'wall' });
      this.lastWallT = this.t;
    }

    const sp = Math.hypot(pk.vx, pk.vy);
    if (sp > 1300) { pk.vx *= 1300 / sp; pk.vy *= 1300 / sp; }

    // anti-travamento: disco parado fora do alcance de todos os tacos
    if (sp < 30 && !this.reachable()) {
      this.idle += dt;
      if (this.idle > 1.2) {
        this.idle = 0;
        const alive = this.players.filter((p) => p.active);
        this.launch(alive[Math.floor(Math.random() * alive.length)], true);
      }
    } else {
      this.idle = 0;
    }
  }

  reachable() {
    const pk = this.puck;
    for (const p of this.players) {
      if (!p.active) continue;
      const z = this.zone(p.side);
      const cx = clamp(pk.x, z.x0, z.x1);
      const cy = clamp(pk.y, z.y0, z.y1);
      if (Math.hypot(pk.x - cx, pk.y - cy) <= MALLET_R + PUCK_R + 4) return true;
    }
    return false;
  }

  launch(target, keepStatus) {
    let t = target;
    if (!t || !t.active) {
      const alive = this.players.filter((p) => p.active);
      t = alive[Math.floor(Math.random() * alive.length)];
    }
    if (!t) return;
    const d = SIDE_DIR[t.side];
    const ang = Math.atan2(d[1], d[0]) + (Math.random() - 0.5) * 0.9;
    const speed = keepStatus ? 300 : 380;
    this.puck.vx = Math.cos(ang) * speed;
    this.puck.vy = Math.sin(ang) * speed;
    if (!keepStatus) {
      this.status = 'play';
      this.lastTouch = -1;
    }
  }

  goal(side) {
    const c = this.players.find((p) => p.active && p.side === side);
    if (!c) return;
    let s = this.lastTouch;
    if (s === c.idx || s < 0 || !this.players[s] || !this.players[s].active) {
      s = this.n === 2 ? 1 - c.idx : -1;   // gol contra: só pontua no 1x1
    }
    if (s >= 0) this.players[s].score++;
    this.events.push({ t: 'goal', s, c: c.idx });

    const pk = this.puck;
    pk.x = this.w / 2; pk.y = this.h / 2; pk.vx = 0; pk.vy = 0;
    this.lastTouch = -1;

    if (s >= 0 && this.players[s].score >= this.pts) {
      this.status = 'over';
      this.winner = s;
      this.events.push({ t: 'over' });
    } else {
      this.status = 'serve';
      this.cd = 1.5;
      this.serveTo = c.idx;
    }
  }

  /* ---------- Rede ---------- */
  snapshot() {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      t: 's',
      p: this.players.map((p) => [r1(p.x), r1(p.y), p.score, p.active ? 1 : 0]),
      k: [r1(this.puck.x), r1(this.puck.y)],
      st: this.status,
      cd: Math.round(this.cd * 100) / 100,
      w: this.winner
    };
  }

  applySnapshot(m) {
    this.players.forEach((p, i) => {
      const s = m.p[i];
      if (!s) return;
      if (p.sx === undefined) { p.x = s[0]; p.y = s[1]; }
      p.sx = s[0]; p.sy = s[1];
      p.score = s[2];
      p.active = !!s[3];
    });
    const pk = this.puck;
    const now = performance.now();
    if (pk.sx === undefined) { pk.x = m.k[0]; pk.y = m.k[1]; pk.vx = 0; pk.vy = 0; }
    else {
      const dtS = (now - pk.st) / 1000;
      const jx = m.k[0] - pk.sx, jy = m.k[1] - pk.sy;
      if (dtS > 0.005 && dtS < 0.25 && Math.hypot(jx, jy) < 120) { pk.vx = jx / dtS; pk.vy = jy / dtS; }
      else { pk.vx = 0; pk.vy = 0; }
    }
    pk.st = now;
    pk.sx = m.k[0]; pk.sy = m.k[1];
    this.status = m.st;
    this.cd = m.cd;
    this.winner = m.w;
  }

  // suaviza os dados recebidos; o taco do próprio jogador é previsto localmente
  smooth(dt, meIdx) {
    const k = 1 - Math.exp(-dt * 22);
    for (const p of this.players) {
      if (p.sx === undefined) continue;
      if (p.idx === meIdx && p.active) {
        this.moveMallet(p, dt);
        const c = Math.min(1, dt * 3);       // correção suave em direção ao estado do anfitrião
        p.x += (p.sx - p.x) * c;
        p.y += (p.sy - p.y) * c;
      } else {
        p.x += (p.sx - p.x) * k;
        p.y += (p.sy - p.y) * k;
      }
    }
    const pk = this.puck;
    if (pk.sx !== undefined) {
      // projeta o disco um pouco à frente (até 60 ms) para compensar o intervalo entre pacotes
      const ahead = Math.min(0.06, (performance.now() - pk.st) / 1000);
      const tx = pk.sx + (pk.vx || 0) * ahead;
      const ty = pk.sy + (pk.vy || 0) * ahead;
      if (Math.hypot(tx - pk.x, ty - pk.y) > 180) { pk.x = tx; pk.y = ty; }
      else { pk.x += (tx - pk.x) * k; pk.y += (ty - pk.y) * k; }
    }
  }
}

/* =====================================================================
   ESTADO DO APP
   ===================================================================== */
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const hud = $('#hud');
const wrap = $('.canvas-wrap');

let game = null;
let mode = null;                 // 'local-2p' | 'local-ai' | 'online'
let lastCfg = null;
let controls = [];
let trail = [];
let particles = [];
let flash = null;
let overShown = false;
let simAcc = 0;
let netAcc = 0;
let lastTs = 0;
let pendingEv = [];
let snapSeq = 0;
let lastSeq = 0;
const keys = new Set();

// visão: rot gira o campo (0,1,2,3 = x90° horário) para o jogador ficar sempre "por baixo"
const view = { rot: 0, sw: 800, sh: 500, scale: 1, px: 1 };
let bgCanvas = null;
let bgKey = '';

const newNet = () => ({ role: null, peer: null, conn: null, lobby: [], started: false, code: '', pts: 7, myIdx: 0, joined: false, pingTimer: null });
let net = newNet();

const myIdx = () => (mode === 'online' ? net.myIdx : 0);

function show(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
  document.body.classList.toggle('in-game', name === 'game');
  if (name !== 'game') window.scrollTo(0, 0);
}

function setBadge(text, cls) {
  const b = $('#net-badge');
  b.textContent = text || '';
  b.className = 'net-badge' + (cls ? ' ' + cls : '');
}

/* =====================================================================
   LAYOUT / ROTAÇÃO DO CAMPO
   ===================================================================== */
function computeRot(portrait) {
  const me = game.players[myIdx()];
  const side = me ? me.side : 'left';
  if (game.n === 2) {
    if (!portrait) return 0;                       // tela deitada: campo na horizontal
    return side === 'right' ? 1 : 3;               // tela em pé: campo na vertical, eu embaixo
  }
  const map = { left: 3, right: 1, top: 2, bottom: 0 };
  return map[side] ?? 0;
}

function layout() {
  if (!game) return;
  const r = wrap.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return;
  view.rot = computeRot(r.height > r.width);
  const odd = view.rot % 2 === 1;
  view.sw = odd ? game.h : game.w;
  view.sh = odd ? game.w : game.h;
  view.scale = Math.min(r.width / view.sw, r.height / view.sh);

  const cssW = Math.floor(view.sw * view.scale);
  const cssH = Math.floor(view.sh * view.scale);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  view.px = pw / view.sw;
  bgKey = '';
}

if ('ResizeObserver' in window) new ResizeObserver(() => layout()).observe(wrap);
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));

function applyView() {
  const p = view.px, W = game.w, H = game.h;
  let m;
  switch (view.rot) {
    case 1: m = [0, 1, -1, 0, H, 0]; break;
    case 2: m = [-1, 0, 0, -1, W, H]; break;
    case 3: m = [0, -1, 1, 0, 0, W]; break;
    default: m = [1, 0, 0, 1, 0, 0];
  }
  ctx.setTransform(m[0] * p, m[1] * p, m[2] * p, m[3] * p, m[4] * p, m[5] * p);
}

function toLogical(clientX, clientY, liftPx) {
  const r = canvas.getBoundingClientRect();
  const sx = ((clientX - r.left) / r.width) * view.sw;
  const sy = ((clientY - r.top - (liftPx || 0)) / r.height) * view.sh;
  const W = game.w, H = game.h;
  switch (view.rot) {
    case 1: return [sy, H - sx];
    case 2: return [W - sx, H - sy];
    case 3: return [W - sy, sx];
    default: return [sx, sy];
  }
}

/* =====================================================================
   INICIAR PARTIDAS
   ===================================================================== */
function startGame(cfg, m) {
  lastCfg = cfg;
  mode = m;
  game = new Game(cfg);
  trail = [];
  particles = [];
  flash = null;
  overShown = false;
  simAcc = 0;
  netAcc = 0;
  pendingEv = [];
  snapSeq = 0;
  lastSeq = 0;
  bgKey = '';
  hideOverlay();

  if (m === 'local-2p') {
    controls = [{ idx: 0, sets: [KEYS_WASD] }, { idx: 1, sets: [KEYS_ARROWS] }];
  } else if (m === 'local-ai') {
    controls = [{ idx: 0, sets: [KEYS_WASD, KEYS_ARROWS] }];
  } else {
    controls = [{ idx: net.myIdx, sets: [KEYS_WASD, KEYS_ARROWS] }];
  }

  show('game');
  buildHud();
  layout();
  lockScreen();

  if (m === 'online') setBadge(net.role === 'host' ? 'ANFITRIÃO' : 'CONECTANDO...');
  else setBadge('');

  const touch = isTouchDevice();
  if (m === 'local-2p') toast(touch ? 'Cada jogador toca na sua metade da tela.' : 'P1: W A S D  |  P2: setas.');
  else toast(touch ? 'Arraste o dedo na tela para mover o taco.' : 'Mova o mouse (ou use W A S D / setas).');
}

function startLocal(kind, diff) {
  const pts = +$('#local-pts').value;
  if (kind === '2p') {
    startGame({ players: [{ name: 'P1' }, { name: 'P2' }], pts, label: 'LOCAL 1V1' }, 'local-2p');
  } else {
    const d = DIFFS[diff];
    startGame({
      players: [{ name: 'P1' }, { name: 'P2', ai: d }],
      pts,
      label: `VS IA (${d.label})`
    }, 'local-ai');
  }
}

function buildHud() {
  hud.innerHTML = '';
  const els = game.players.map((p, i) => {
    const s = document.createElement('span');
    s.className = 'score';
    s.dataset.i = i;
    s.style.color = p.color;
    s.style.textShadow = `0 0 10px ${p.color}`;
    s.style.boxShadow = `0 0 12px ${rgba(p.color, 0.25)}`;
    return s;
  });
  const mid = document.createElement('span');
  mid.className = 'hud-mode';
  mid.textContent = game.label;
  els.splice(Math.ceil(game.n / 2), 0, mid);
  els.forEach((e) => hud.appendChild(e));
}

function refreshHud() {
  hud.querySelectorAll('.score').forEach((s) => {
    const p = game.players[+s.dataset.i];
    const txt = `${p.active ? '' : '✖ '}${p.name}: ${p.score}`;
    if (s.textContent !== txt) s.textContent = txt;
  });
}

/* =====================================================================
   ENTRADAS (teclado / mouse / toque)
   ===================================================================== */
window.addEventListener('keydown', (e) => {
  if (!game || !$('#screen-game').classList.contains('active')) return;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function applyKeys() {
  for (const c of controls) {
    const p = game.players[c.idx];
    if (!p || !p.active) continue;
    let dx = 0, dy = 0;
    for (const s of c.sets) {
      if (keys.has(s.l)) dx--;
      if (keys.has(s.r)) dx++;
      if (keys.has(s.u)) dy--;
      if (keys.has(s.d)) dy++;
    }
    if (dx || dy) {
      // direção da tela -> direção do campo (considera a rotação)
      let lx = dx, ly = dy;
      if (view.rot === 1) { lx = dy; ly = -dx; }
      else if (view.rot === 2) { lx = -dx; ly = -dy; }
      else if (view.rot === 3) { lx = -dy; ly = dx; }
      const l = Math.hypot(lx, ly);
      p.tx = p.x + (lx / l) * 120;
      p.ty = p.y + (ly / l) * 120;
      p.keyActive = true;
    } else if (p.keyActive) {
      p.tx = p.x;
      p.ty = p.y;
      p.keyActive = false;
    }
  }
}

function onPointer(e) {
  if (!game) return;
  if (mode === 'local-2p' && e.pointerType === 'mouse') return;   // 1x1 local no mouse não faz sentido
  e.preventDefault();
  const lift = (e.pointerType === 'touch' && mode !== 'local-2p') ? TOUCH_LIFT : 0;
  const [x, y] = toLogical(e.clientX, e.clientY, lift);
  const idx = mode === 'local-2p' ? (x < game.w / 2 ? 0 : 1) : controls[0].idx;
  const p = game.players[idx];
  if (!p || !p.active) return;
  p.tx = x;
  p.ty = y;
  p.keyActive = false;
}
canvas.addEventListener('pointermove', onPointer);
canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
  onPointer(e);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* =====================================================================
   PARTÍCULAS, EVENTOS, FIM DE PARTIDA
   ===================================================================== */
function burst(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.9);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color });
  }
  if (particles.length > 260) particles.splice(0, particles.length - 260);
}

function goalPoint(side) {
  const W = game.w, H = game.h;
  if (side === 'left') return [6, H / 2];
  if (side === 'right') return [W - 6, H / 2];
  if (side === 'top') return [W / 2, 6];
  return [W / 2, H - 6];
}

function handleEvents(evs) {
  for (const e of evs) {
    if (e.t === 'hit') {
      beep(520, 0.05, 'square', 0.04);
      const lt = game.players[game.lastTouch];
      burst(game.puck.x, game.puck.y, lt ? lt.color : '#ffffff', 7, 260);
    } else if (e.t === 'wall') {
      beep(300, 0.04, 'triangle', 0.035);
    } else if (e.t === 'goal') {
      beep(180, 0.35, 'sawtooth', 0.07);
      const c = game.players[e.c];
      const sc = game.players[e.s];
      flash = { color: c ? c.color : '#ffffff', t: 1 };
      if (c) {
        const [gx, gy] = goalPoint(c.side);
        burst(gx, gy, sc ? sc.color : c.color, 54, 420);
      }
    }
  }
}

function hideOverlay() { $('#overlay').classList.add('hidden'); }

function showOver() {
  const w = game.players[game.winner];
  const title = $('#overlay-title');
  title.textContent = w ? `${w.name} venceu!` : 'Fim de jogo';
  title.style.color = w ? w.color : '';
  $('#overlay-sub').textContent = game.players.map((p) => `${p.name} ${p.score}`).join('  |  ');
  const canRestart = mode !== 'online' || net.role === 'host';
  $('#btn-again').style.display = canRestart ? '' : 'none';
  if (!canRestart) $('#overlay-sub').textContent += '  —  aguardando o anfitrião';
  $('#overlay').classList.remove('hidden');
  beep(660, 0.25, 'triangle', 0.07);
}

function leaveGame() {
  if (mode === 'online') cleanupNet();
  game = null;
  mode = null;
  keys.clear();
  unlockScreen();
  show('menu');
}

/* =====================================================================
   REDE (PeerJS / WebRTC) — o anfitrião é a autoridade da partida
   ===================================================================== */
function cleanupNet() {
  clearInterval(net.pingTimer);
  try { net.conn && net.conn.close(); } catch (e) { /* ok */ }
  try { net.lobby.forEach((l) => l.conn && l.conn.close()); } catch (e) { /* ok */ }
  try { net.peer && net.peer.destroy(); } catch (e) { /* ok */ }
  net = newNet();
  pendingEv = [];
  snapSeq = 0;
  lastSeq = 0;
}

function setOnlineStatus(msg) { $('#online-status').textContent = msg || ''; }

function getName() {
  const n = cleanName($('#player-name').value) || 'Jogador';
  try { localStorage.setItem('ah-name', n); } catch (e) { /* ok */ }
  return n;
}

/* ---------- Anfitrião ---------- */
function createRoom() {
  if (typeof Peer === 'undefined') { toast('Não foi possível carregar a biblioteca online. Verifique sua internet.'); return; }
  const name = getName();
  cleanupNet();
  setOnlineStatus('Criando sala...');
  let tries = 0;

  const attempt = () => {
    const code = randomCode();
    const peer = new Peer(PEER_PREFIX + code, { config: ICE_CONFIG });
    peer.on('open', () => {
      net.role = 'host';
      net.peer = peer;
      net.code = code;
      net.lobby = [{ conn: null, name }];
      net.myIdx = 0;
      setOnlineStatus('');
      show('lobby');
      renderLobby();
    });
    peer.on('connection', onGuestConnection);
    // se o servidor de sinalização derrubar o anfitrião, reconecta sem encerrar a sala
    peer.on('disconnected', () => { if (net.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ok */ } } });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && tries++ < 5) { peer.destroy(); attempt(); return; }
      toast('Erro ao criar a sala (' + err.type + ')');
      setOnlineStatus('');
      cleanupNet();
    });
  };
  attempt();
}

function onGuestConnection(conn) {
  conn.on('data', (msg) => {
    if (!msg || net.role !== 'host') return;

    if (msg.t === 'ping') { if (conn.open) conn.send({ t: 'pong', ts: msg.ts }); return; }

    if (msg.t === 'hello') {
      if (net.lobby.some((l) => l.conn === conn)) return;
      if (net.started) { conn.send({ t: 'full', why: 'A partida já começou.' }); setTimeout(() => conn.close(), 500); return; }
      if (net.lobby.length >= 4) { conn.send({ t: 'full', why: 'Sala cheia (máximo de 4 jogadores).' }); setTimeout(() => conn.close(), 500); return; }
      net.lobby.push({ conn, name: cleanName(msg.name) || `Jogador ${net.lobby.length + 1}` });
      broadcastLobby();
      renderLobby();
    } else if (msg.t === 'in' && game && mode === 'online') {
      const i = net.lobby.findIndex((l) => l.conn === conn);
      const p = game.players[i];
      if (!p || !p.active) return;
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        p.tx = clamp(msg.x, -50, game.w + 50);
        p.ty = clamp(msg.y, -50, game.h + 50);
        p.keyActive = !!msg.k;
      }
    }
  });
  conn.on('close', () => onGuestLeft(conn));
  conn.on('error', () => onGuestLeft(conn));
}

function onGuestLeft(conn) {
  const i = net.lobby.findIndex((l) => l.conn === conn);
  if (i < 0) return;
  const name = net.lobby[i].name;
  if (!net.started) {
    net.lobby.splice(i, 1);
    broadcastLobby();
    renderLobby();
  } else {
    net.lobby[i].gone = true;
    if (game) game.removePlayer(i);
  }
  toast(`${name} saiu da sala`);
}

function broadcastLobby() {
  net.lobby.forEach((l, i) => {
    if (!l.conn || !l.conn.open) return;
    l.conn.send({ t: 'lobby', players: net.lobby.map((x) => x.name), pts: net.pts, code: net.code, you: i });
  });
}

function startOnline() {
  net.lobby = net.lobby.filter((l) => !l.gone);
  if (net.lobby.length < 2) {
    net.started = false;
    toast('É preciso de pelo menos 2 jogadores.');
    broadcastLobby();
    renderLobby();
    show('lobby');
    return;
  }
  net.started = true;
  net.myIdx = 0;
  const cfg = { players: net.lobby.map((l) => ({ name: l.name })), pts: net.pts, label: 'SALA ' + net.code };
  net.lobby.forEach((l, i) => { if (l.conn && l.conn.open) l.conn.send({ t: 'start', cfg, you: i }); });
  startGame(cfg, 'online');
}

function broadcastState() {
  const m = game.snapshot();
  m.n = ++snapSeq;
  if (pendingEv.length) m.ev = pendingEv.splice(0);
  let evSent = false;
  net.lobby.forEach((l) => {
    if (!l.conn || !l.conn.open || l.gone) return;
    // eventos (gol, som) precisam chegar; o estado, se o canal estiver cheio, é pulado (o próximo substitui)
    if (congested(l.conn)) {
      if (m.ev) l.conn.send({ t: 's', n: m.n, ev: m.ev, only: 1 });
      return;
    }
    l.conn.send(m);
  });
}

/* ---------- Convidado ---------- */
function joinRoom() {
  if (typeof Peer === 'undefined') { toast('Não foi possível carregar a biblioteca online. Verifique sua internet.'); return; }
  const code = $('#room-code').value.trim().toUpperCase();
  if (code.length < 4) { toast('Digite o código da sala.'); return; }
  const name = getName();
  cleanupNet();
  setOnlineStatus('Conectando à sala...');

  const peer = new Peer({ config: ICE_CONFIG });
  net.peer = peer;
  net.role = 'client';

  const fail = (msg) => {
    toast(msg);
    setOnlineStatus('');
    cleanupNet();
    show('online');
  };

  const timeout = setTimeout(() => { if (net.peer === peer && !net.joined) fail('Tempo esgotado. Confira o código e tente de novo.'); }, 15000);

  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + code, CONN_OPTS);
    net.conn = conn;
    conn.on('open', () => {
      conn.send({ t: 'hello', name });
      net.pingTimer = setInterval(() => {
        if (conn.open) conn.send({ t: 'ping', ts: performance.now() });
      }, 2000);
    });
    conn.on('data', onHostMessage);
    conn.on('close', () => {
      if (net.conn !== conn) return;
      toast('A sala foi encerrada.');
      leaveToMenu();
    });
    conn.on('error', () => { if (net.conn === conn && !net.joined) fail('Não foi possível entrar na sala.'); });
  });
  peer.on('error', (err) => {
    clearTimeout(timeout);
    if (net.peer !== peer) return;
    if (err.type === 'peer-unavailable') fail('Sala não encontrada. Confira o código.');
    else fail('Erro de conexão (' + err.type + ')');
  });
}

function leaveToMenu() {
  cleanupNet();
  game = null;
  mode = null;
  keys.clear();
  unlockScreen();
  setOnlineStatus('');
  show('menu');
}

function onHostMessage(m) {
  if (!m) return;
  if (m.t === 'pong') {
    const ms = Math.round(performance.now() - m.ts);
    setBadge(`PING ${ms} MS`, ms < 90 ? '' : ms < 180 ? 'ok' : 'bad');
  } else if (m.t === 'lobby') {
    net.joined = true;
    net.lobby = m.players.map((n) => ({ name: n }));
    net.pts = m.pts;
    net.code = m.code;
    net.myIdx = m.you;
    setOnlineStatus('');
    if (!$('#screen-lobby').classList.contains('active') && !game) show('lobby');
    renderLobby();
  } else if (m.t === 'full') {
    toast(m.why || 'Não foi possível entrar.');
    leaveToMenu();
  } else if (m.t === 'start') {
    net.joined = true;
    net.myIdx = m.you;
    startGame(m.cfg, 'online');
    lastSeq = 0;
  } else if (m.t === 's' && game) {
    if (m.ev) handleEvents(m.ev);                 // eventos sempre, mesmo de pacote atrasado
    if (!m.only && m.n > lastSeq) {               // estado: só o mais novo (descarta pacote fora de ordem)
      lastSeq = m.n;
      game.applySnapshot(m);
    }
  }
}

function sendInput() {
  const p = game.players[net.myIdx];
  if (!p || !net.conn || !net.conn.open || congested(net.conn)) return;
  net.conn.send({ t: 'in', x: Math.round(p.tx * 10) / 10, y: Math.round(p.ty * 10) / 10, k: p.keyActive ? 1 : 0 });
}

/* ---------- Tela da sala ---------- */
function renderLobby() {
  const isHost = net.role === 'host';
  $('#lobby-code').textContent = net.code || '-----';

  const ul = $('#lobby-list');
  ul.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    const l = net.lobby[i];
    if (l) {
      li.style.setProperty('--pc', COLORS[i]);
      dot.style.background = COLORS[i];
      dot.style.boxShadow = `0 0 10px ${COLORS[i]}`;
      name.textContent = l.name;
      li.append(dot, name);
      const tag = document.createElement('span');
      tag.className = 'tag';
      const parts = [];
      if (i === 0) parts.push('anfitrião');
      if (i === net.myIdx) parts.push('você');
      tag.textContent = parts.join(' · ');
      li.appendChild(tag);
    } else {
      li.className = 'empty';
      dot.style.border = '1px dashed #4a4f6a';
      name.textContent = 'Aguardando jogador...';
      li.append(dot, name);
    }
    ul.appendChild(li);
  }

  const sel = $('#lobby-pts');
  sel.value = String(net.pts);
  sel.disabled = !isHost;

  const start = $('#btn-start');
  start.style.display = isHost ? '' : 'none';
  start.disabled = net.lobby.length < 2;

  $('#lobby-hint').textContent = isHost
    ? (net.lobby.length < 2 ? 'Envie o código ou o link para os amigos. São necessários de 2 a 4 jogadores.' : 'Tudo pronto. Inicie quando quiser.')
    : 'Aguardando o anfitrião iniciar a partida.';
}

/* =====================================================================
   RENDERIZAÇÃO
   ===================================================================== */
function drawText(txt, x, y, font, color, align) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-view.rot * Math.PI / 2);          // mantém o texto de pé mesmo com o campo girado
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(txt, 0, 0);
  ctx.restore();
}

function drawSideWall(c, g, side, W, H) {
  const pl = g.players.find((p) => p.active && p.side === side);
  const horizontal = side === 'top' || side === 'bottom';
  const len = horizontal ? W : H;
  const mid = len / 2;
  const half = g.gh / 2;
  const I = 2;
  const pt = (t) => {
    if (side === 'left') return [I, t];
    if (side === 'right') return [W - I, t];
    if (side === 'top') return [t, I];
    return [t, H - I];
  };
  const line = (a, b, color, blur, lw) => {
    c.strokeStyle = color;
    c.shadowColor = color;
    c.shadowBlur = blur;
    c.lineWidth = lw;
    c.beginPath();
    c.moveTo(...pt(a));
    c.lineTo(...pt(b));
    c.stroke();
  };
  const WALL = '#19e3f2';
  if (!pl) {
    line(0, len, WALL, 12, 3);
  } else {
    line(0, mid - half, WALL, 12, 3);
    line(mid + half, len, WALL, 12, 3);
    line(mid - half, mid + half, pl.color, 22, 6);
  }
}

function paintField(c, g) {
  const W = g.w, H = g.h;

  const grd = c.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, Math.max(W, H) * 0.78);
  grd.addColorStop(0, '#09192e');
  grd.addColorStop(1, '#03060d');
  c.fillStyle = grd;
  c.fillRect(0, 0, W, H);

  // grade
  c.strokeStyle = 'rgba(0,240,255,.055)';
  c.lineWidth = 1;
  c.beginPath();
  for (let x = 50; x < W; x += 50) { c.moveTo(x, 0); c.lineTo(x, H); }
  for (let y = 50; y < H; y += 50) { c.moveTo(0, y); c.lineTo(W, y); }
  c.stroke();

  // marcações
  c.save();
  c.lineWidth = 2;
  c.setLineDash([10, 12]);
  if (g.n === 2) {
    c.strokeStyle = 'rgba(0,240,255,.25)';
    c.beginPath();
    c.moveTo(W / 2, 0);
    c.lineTo(W / 2, H);
    c.stroke();
  } else {
    for (const p of g.players) {
      if (!p.active) continue;
      const z = g.zone(p.side);
      c.strokeStyle = rgba(p.color, 0.22);
      c.beginPath();
      if (p.side === 'left') { c.moveTo(z.x1, 0); c.lineTo(z.x1, H); }
      else if (p.side === 'right') { c.moveTo(z.x0, 0); c.lineTo(z.x0, H); }
      else if (p.side === 'top') { c.moveTo(0, z.y1); c.lineTo(W, z.y1); }
      else { c.moveTo(0, z.y0); c.lineTo(W, z.y0); }
      c.stroke();
    }
  }
  c.setLineDash([]);

  // círculo central com marcas
  const cr = g.n === 2 ? 70 : 60;
  c.strokeStyle = 'rgba(0,240,255,.28)';
  c.beginPath();
  c.arc(W / 2, H / 2, cr, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = 'rgba(0,240,255,.5)';
  c.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    c.beginPath();
    c.moveTo(W / 2 + Math.cos(a) * (cr + 4), H / 2 + Math.sin(a) * (cr + 4));
    c.lineTo(W / 2 + Math.cos(a) * (cr + 12), H / 2 + Math.sin(a) * (cr + 12));
    c.stroke();
  }
  c.fillStyle = 'rgba(0,240,255,.5)';
  c.beginPath();
  c.arc(W / 2, H / 2, 5, 0, Math.PI * 2);
  c.fill();

  // áreas dos gols
  const arcs = {
    left:   [-Math.PI / 2, Math.PI / 2],
    right:  [Math.PI / 2, Math.PI * 1.5],
    top:    [0, Math.PI],
    bottom: [Math.PI, Math.PI * 2]
  };
  const gp = { left: [0, H / 2], right: [W, H / 2], top: [W / 2, 0], bottom: [W / 2, H] };
  for (const p of g.players) {
    if (!p.active) continue;
    const [cx, cy] = gp[p.side];
    const [a0, a1] = arcs[p.side];
    const rad = g.gh * 0.62;
    const rg = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
    rg.addColorStop(0, rgba(p.color, 0.22));
    rg.addColorStop(1, rgba(p.color, 0));
    c.fillStyle = rg;
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, rad, a0, a1);
    c.closePath();
    c.fill();
    c.strokeStyle = rgba(p.color, 0.4);
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cx, cy, rad, a0, a1);
    c.stroke();
  }
  c.restore();

  // paredes e bocas de gol
  c.save();
  for (const s of SIDES) drawSideWall(c, g, s, W, H);
  c.restore();
}

function bgKeyOf() {
  return `${game.n}:${game.players.map((p) => (p.active ? 1 : 0)).join('')}:${Math.round(view.px * 10)}`;
}

function buildBg() {
  const s = clamp(view.px, 1, 2.5);
  bgCanvas = bgCanvas || document.createElement('canvas');
  bgCanvas.width = Math.round(game.w * s);
  bgCanvas.height = Math.round(game.h * s);
  const c = bgCanvas.getContext('2d');
  c.setTransform(s, 0, 0, s, 0, 0);
  paintField(c, game);
  bgKey = bgKeyOf();
}

function drawMallet(x, y, color, ts) {
  const R = MALLET_R;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 22;
  const body = ctx.createRadialGradient(x, y, 2, x, y, R);
  body.addColorStop(0, rgba(color, 0.55));
  body.addColorStop(1, rgba(color, 0.14));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(color, 0.8);
  ctx.beginPath();
  ctx.arc(x, y, R * 0.62, 0, Math.PI * 2);
  ctx.stroke();

  // marcas giratórias
  const rot = ts / 1400;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const a = rot + (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (R * 0.7), y + Math.sin(a) * (R * 0.7));
    ctx.lineTo(x + Math.cos(a) * (R * 0.9), y + Math.sin(a) * (R * 0.9));
    ctx.stroke();
  }

  // núcleo
  const core = ctx.createRadialGradient(x, y, 0, x, y, R * 0.36);
  core.addColorStop(0, '#ffffff');
  core.addColorStop(1, color);
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, R * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw(ts) {
  const g = game;
  const W = g.w, H = g.h;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#03060d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  applyView();

  if (bgKey !== bgKeyOf()) buildBg();
  ctx.drawImage(bgCanvas, 0, 0, W, H);

  // clarão do gol
  if (flash && flash.t > 0) {
    ctx.globalAlpha = flash.t * 0.22;
    ctx.fillStyle = flash.color;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // contagem do saque
  if (g.status === 'serve' && g.cd > 0) {
    drawText(String(Math.ceil(g.cd)), W / 2, H / 2, '900 130px Orbitron, "Segoe UI", sans-serif', 'rgba(0,240,255,.09)');
  }

  // rastro do disco
  trail.forEach((t, i) => {
    const k = i / trail.length;
    ctx.globalAlpha = k * 0.28;
    ctx.fillStyle = '#9ff8ff';
    ctx.beginPath();
    ctx.arc(t.x, t.y, PUCK_R * (0.45 + 0.55 * k), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // disco
  ctx.save();
  ctx.shadowColor = '#bffcff';
  ctx.shadowBlur = 20;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(g.puck.x, g.puck.y, PUCK_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(0,240,255,.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(g.puck.x, g.puck.y, PUCK_R - 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // tacos
  for (const p of g.players) {
    if (!p.active) continue;
    drawMallet(p.x, p.y, p.color, ts);
    if (mode === 'online') {
      drawText(p.name, p.x, p.y - MALLET_R - 12, '700 13px Orbitron, "Segoe UI", sans-serif', p.color);
      if (p.idx === net.myIdx) {
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, MALLET_R + 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // partículas
  if (particles.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const q of particles) {
      ctx.globalAlpha = Math.max(0, q.life);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/* =====================================================================
   LOOP PRINCIPAL
   ===================================================================== */
function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
  lastTs = ts;

  if (game && $('#screen-game').classList.contains('active')) {
    applyKeys();

    if (mode === 'online' && net.role === 'client') {
      netAcc += dt;
      if (netAcc >= NET_RATE) { netAcc = 0; sendInput(); }
      game.smooth(dt, net.myIdx);
    } else {
      simAcc += dt;
      let guard = 0;
      while (simAcc >= STEP && guard++ < 20) { game.step(STEP); simAcc -= STEP; }
      const evs = game.events.splice(0);
      if (evs.length) {
        handleEvents(evs);
        if (net.role === 'host') pendingEv.push(...evs);
      }
      if (net.role === 'host') {
        netAcc += dt;
        if (netAcc >= NET_RATE) { netAcc = 0; broadcastState(); }
      }
    }

    trail.push({ x: game.puck.x, y: game.puck.y });
    if (trail.length > 8) trail.shift();
    if (flash) { flash.t -= dt * 1.8; if (flash.t <= 0) flash = null; }

    for (const q of particles) { q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.96; q.vy *= 0.96; q.life -= dt * 2.2; }
    particles = particles.filter((q) => q.life > 0);

    if (game.status === 'over' && !overShown) { overShown = true; showOver(); }

    refreshHud();
    draw(ts);
  }

  requestAnimationFrame(frame);
}

/* =====================================================================
   LIGAÇÃO DOS BOTÕES
   ===================================================================== */
$('#btn-online').onclick = () => {
  if (typeof Peer === 'undefined') { toast('Não foi possível carregar a biblioteca online. Verifique sua internet.'); return; }
  show('online');
};
$('#btn-local').onclick = () => show('local');
document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => show(b.dataset.back); });

$('#btn-local-2p').onclick = () => startLocal('2p');
document.querySelectorAll('[data-diff]').forEach((b) => { b.onclick = () => startLocal('ai', b.dataset.diff); });

$('#btn-create').onclick = createRoom;
$('#btn-join').onclick = joinRoom;
$('#room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('#room-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

$('#lobby-pts').onchange = (e) => {
  if (net.role !== 'host') return;
  net.pts = +e.target.value;
  broadcastLobby();
};
$('#btn-start').onclick = () => { if (net.role === 'host') startOnline(); };
$('#btn-leave').onclick = leaveToMenu;

$('#btn-copy-code').onclick = () => copyText(net.code, 'Código copiado!');
$('#btn-copy-link').onclick = async () => {
  const link = `${location.origin}${location.pathname}?sala=${net.code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Air Hockey', text: `Entre na minha sala de Air Hockey! Código: ${net.code}`, url: link });
      return;
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyText(link, 'Link copiado!');
};

$('#btn-exit').onclick = leaveGame;
$('#btn-menu').onclick = leaveGame;
$('#btn-again').onclick = () => {
  if (mode === 'online') {
    if (net.role === 'host') startOnline();
  } else {
    startGame(lastCfg, mode);
  }
};
$('#btn-mute').onclick = () => {
  muted = !muted;
  $('#btn-mute').textContent = muted ? 'Som: OFF' : 'Som: ON';
};

const fsBtn = $('#btn-full');
if (!document.documentElement.requestFullscreen) {
  fsBtn.style.display = 'none';
} else {
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast('Tela cheia indisponível neste aparelho.'));
  };
}

/* nome salvo + link de convite (?sala=CODIGO) */
try { $('#player-name').value = localStorage.getItem('ah-name') || ''; } catch (e) { /* ok */ }
const urlCode = new URLSearchParams(location.search).get('sala');
if (urlCode) {
  $('#room-code').value = urlCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  show('online');
}

requestAnimationFrame(frame);
})();
