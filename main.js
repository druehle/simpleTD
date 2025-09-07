"use strict";

// Geometry TD (simplified) — single tower type + upgrades
(function () {
  // Canvas setup
  const CANVAS_W = 960;
  const CANVAS_H = 540;

  // UI elements
  const moneyEl = document.getElementById("money");
  const livesEl = document.getElementById("lives");
  const waveEl = document.getElementById("wave");
  const btnStart = document.getElementById("start-wave");
  const btnBasic = document.getElementById("select-basic");
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  // Upgrade panel
  const upPanel = document.getElementById("upgrade-panel");
  const upBtn = document.getElementById("upgrade-tower");
  const upLevel = document.getElementById("tower-level");
  const upDmg = document.getElementById("tower-dmg");
  const upRate = document.getElementById("tower-rate");
  const upRange = document.getElementById("tower-range");
  const upCostEl = document.getElementById("upgrade-cost");

  // Game state
  const state = {
    money: 120,
    lives: 20,
    waveIndex: 0,
    inWave: false,
    time: 0,
    lastTs: 0,
    path: null,
    towers: [],
    enemies: [],
    projectiles: [],
    spawnQueue: [],
    spawnInterval: 0,
    spawnElapsed: 0,
    mouse: { x: 0, y: 0, inside: false },
    selectedTool: "none", // or "place"
    selectedTowerId: null,
    drag: { active: false, type: null, overCanvas: false },
  };

  // Single basic tower definition + upgrade scaling
  const BASIC_TOWER = {
    name: "Basic",
    baseCost: 50,
    color: "#3a86ff",
    baseRange: 140,
    baseDamage: 12,
    baseRate: 1.6, // shots/sec
    projectileSpeed: 500,
    perLevel: { range: 12, damage: 6, rate: 0.18 },
    maxLevel: 6,
    upgradeCost(level) { // cost to go from current level -> next
      return Math.round(60 * Math.pow(1.6, level - 1));
    }
  };

  function towerStats(t) {
    const lvl = t.level || 1;
    return {
      range: BASIC_TOWER.baseRange + BASIC_TOWER.perLevel.range * (lvl - 1),
      damage: BASIC_TOWER.baseDamage + BASIC_TOWER.perLevel.damage * (lvl - 1),
      rate: BASIC_TOWER.baseRate + BASIC_TOWER.perLevel.rate * (lvl - 1),
      projectileSpeed: BASIC_TOWER.projectileSpeed
    };
  }

  // Utility
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Distance from point p to segment ab
  function pointSegDist(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const vv = vx * vx + vy * vy;
    const t = vv > 0 ? clamp((wx * vx + wy * vy) / vv, 0, 1) : 0;
    const cx = ax + t * vx, cy = ay + t * vy;
    const dx = px - cx, dy = py - cy;
    return Math.hypot(dx, dy);
  }

  class Path {
    constructor(points) {
      this.points = points;
      this.segs = [];
      this.length = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        this.segs.push({ a, b, len, acc: this.length });
        this.length += len;
      }
    }
    posAt(s) {
      if (s <= 0) return { ...this.points[0] };
      if (s >= this.length) return { ...this.points[this.points.length - 1] };
      for (let i = 0; i < this.segs.length; i++) {
        const seg = this.segs[i];
        if (s <= seg.acc + seg.len) {
          const t = (s - seg.acc) / seg.len;
          return { x: lerp(seg.a.x, seg.b.x, t), y: lerp(seg.a.y, seg.b.y, t) };
        }
      }
      return { ...this.points[this.points.length - 1] };
    }
    minDistTo(x, y) {
      let d = Infinity;
      for (const seg of this.segs) d = Math.min(d, pointSegDist(x, y, seg.a.x, seg.a.y, seg.b.x, seg.b.y));
      return d;
    }
  }

  function createDefaultPath() {
    // Snake-like path: back-and-forth horizontal runs with two loops
    const P = [];
    const top = 80;
    const bottom = CANVAS_H - 80;
    const leftOut = -80;
    const rightOut = CANVAS_W + 80;
    const left = 80;
    const right = CANVAS_W - 80;

    // Enter from left
    P.push({ x: leftOut, y: top });
    // First run to right
    P.push({ x: right, y: top });
    // Down a lane
    P.push({ x: right, y: top + 120 });
    // Back to left (loop 1)
    P.push({ x: left, y: top + 120 });
    // Down again
    P.push({ x: left, y: top + 240 });
    // To right (loop 2)
    P.push({ x: right, y: top + 240 });
    // Down near bottom
    P.push({ x: right, y: bottom });
    // Exit to right
    P.push({ x: rightOut, y: bottom });
    return new Path(P);
  }

  // --- Hex helpers ---
  const HEX_R = 22; // hex tile radius for background grid
  const SQRT3 = Math.sqrt(3);
  function hexPath(x, y, r, flatTop = true) {
    const p = new Path2D();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i + (flatTop ? Math.PI / 6 : 0);
      const px = x + r * Math.cos(angle);
      const py = y + r * Math.sin(angle);
      if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
    }
    p.closePath();
    return p;
  }

  function drawHex(x, y, r, fillStyle, strokeStyle = "#0a0c12", lineWidth = 2) {
    const p = hexPath(x, y, r, true);
    if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(p); }
    if (strokeStyle && lineWidth > 0) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(p); }
  }

  function drawHexGrid() {
    // flat-top hex grid covering the canvas
    ctx.save();
    const r = HEX_R;
    const w = 2 * r;
    const h = SQRT3 * r;
    const dx = 1.5 * r; // horizontal center spacing
    const dy = h;       // vertical center spacing
    for (let row = -1, y = -h; y < CANVAS_H + h; row++, y += dy) {
      const offset = (row % 2 !== 0) ? dx : 0;
      for (let x = -w + offset; x < CANVAS_W + w; x += 3 * r) {
        const p = hexPath(x, y, r, true);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#111827";
        ctx.stroke(p);
      }
    }
    ctx.restore();
  }

  // Infinite wave scaling function
  function waveFor(index) {
    const base = { count: 12, hp: 24, speed: 70, gap: 0.7 };
    const n = index + 1; // 1-based
    const hp = Math.round(base.hp * Math.pow(1.22, n - 1));
    const count = Math.round(base.count + Math.min(40, (n - 1) * 2.5));
    const speed = Math.min(140, base.speed + (n - 1) * 2.0);
    const gap = Math.max(0.33, base.gap - (n - 1) * 0.02);
    return { count, hp, speed, gap };
  }

  // Drawing helpers
  function drawBackground() {
    // hex grid background
    drawHexGrid();
  }

  function drawPath() {
    const pts = state.path.points;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 28;
    ctx.strokeStyle = "#2b3447";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#3a4660";
    ctx.stroke();
    ctx.restore();
  }

  function drawSquare(x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.strokeStyle = "#0a0c12";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const s = size / 2;
    ctx.rect(-s, -s, size, size);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawEnemies() {
    ctx.save();
    for (const e of state.enemies) {
      if (!e.alive) continue;
      const p = state.path.posAt(e.s);
      // body as hex, color encodes hardness
      drawHex(p.x, p.y, e.r, e.color, "#0a0c12", 2);
      // HP text centered on unit
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const hpText = String(Math.max(0, Math.ceil(e.hp)));
      ctx.lineWidth = 3; ctx.strokeStyle = "#0a0c12";
      ctx.fillStyle = "#ffffff";
      ctx.strokeText(hpText, p.x, p.y + 1);
      ctx.fillText(hpText, p.x, p.y + 1);
    }
    ctx.restore();
  }

  function drawProjectiles() {
    ctx.save();
    ctx.fillStyle = "#e0f2ff";
    for (const p of state.projectiles) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawTowers() {
    for (const t of state.towers) {
      const s = towerStats(t);
      const selected = (t.id === state.selectedTowerId);
      ctx.save();
      // subtle range disc
      ctx.globalAlpha = 0.07;
      ctx.beginPath(); ctx.arc(t.x, t.y, s.range, 0, Math.PI * 2); ctx.fillStyle = BASIC_TOWER.color; ctx.fill();
      ctx.globalAlpha = 1;
      // body
      drawSquare(t.x, t.y, 24, BASIC_TOWER.color);
      // level pips
      ctx.fillStyle = "#a0b8ff";
      for (let i = 0; i < t.level; i++) {
        ctx.beginPath(); ctx.arc(t.x - 10 + i * 5, t.y + 12, 2, 0, Math.PI * 2); ctx.fill();
      }
      // selection ring
      if (selected) {
        ctx.strokeStyle = "#8bd9a3"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(t.x, t.y, 18, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawPlacementPreview() {
    const show = (state.selectedTool === "place") || state.drag.active;
    if (!(state.mouse.inside || state.drag.overCanvas)) return;
    if (!show) return;
    const pos = state.mouse;
    const ok = canPlaceTower(pos);
    const s = towerStats({ level: 1 });
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, s.range, 0, Math.PI * 2); ctx.fillStyle = ok ? BASIC_TOWER.color : "#ef4444"; ctx.fill();
    ctx.globalAlpha = 1;
    const c = ok ? BASIC_TOWER.color : "#ef4444";
    drawSquare(pos.x, pos.y, 24, c);
    ctx.restore();
  }

  // Enemy factory
  function colorForHardness(hp) {
    if (hp < 50) return "#8bd9a3";       // easy - green
    if (hp < 110) return "#ffd166";      // normal - yellow
    if (hp < 180) return "#f4a261";      // tough - orange
    if (hp < 280) return "#ef4444";      // hard - red
    return "#8b5cf6";                    // elite - purple
  }
  function spawnEnemy(hp, speed) {
    const color = colorForHardness(hp);
    state.enemies.push({ s: 0, hp, maxHp: hp, speed, r: 14, alive: true, color });
  }

  function startWave() {
    if (state.inWave) return;
    const w = waveFor(state.waveIndex);
    state.spawnQueue = Array.from({ length: w.count }, () => ({ hp: w.hp, speed: w.speed }));
    state.spawnInterval = w.gap;
    state.spawnElapsed = 0;
    state.inWave = true;
    btnStart.disabled = true;
  }

  // Tower targeting: prefer enemy furthest along within range
  function acquireTarget(tower) {
    let best = null;
    let bestS = -1;
    const s = towerStats(tower);
    for (const e of state.enemies) {
      if (!e.alive) continue;
      const p = state.path.posAt(e.s);
      const d = Math.hypot(tower.x - p.x, tower.y - p.y);
      if (d <= s.range && e.s > bestS) {
        best = e; bestS = e.s;
      }
    }
    return best;
  }

  function shoot(tower, target) {
    const stats = towerStats(tower);
    const origin = { x: tower.x, y: tower.y };
    const tp = state.path.posAt(target.s);
    const angle = Math.atan2(tp.y - origin.y, tp.x - origin.x);
    const speed = stats.projectileSpeed;
    state.projectiles.push({ x: origin.x, y: origin.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, speed, dmg: stats.damage, target });
  }

  // Update loop
  function update(dt) {
    state.time += dt;
    // spawning
    if (state.inWave) {
      state.spawnElapsed += dt;
      const interval = state.spawnInterval;
      while (state.spawnQueue.length > 0 && state.spawnElapsed >= interval) {
        state.spawnElapsed -= interval;
        const next = state.spawnQueue.shift();
        spawnEnemy(next.hp, next.speed);
      }
      if (state.spawnQueue.length === 0 && state.enemies.every(e => !e.alive)) {
        // wave completed
        state.inWave = false;
        btnStart.disabled = false;
        state.waveIndex++;
        state.money += 50; // reward
        updateHUD();
      }
    }

    // enemies along path
    for (const e of state.enemies) {
      if (!e.alive) continue;
      e.s += e.speed * dt;
      if (e.s >= state.path.length) {
        e.alive = false;
        state.lives--;
        updateHUD();
      }
    }
    state.enemies = state.enemies.filter(e => e.alive || e.s < state.path.length + 40);

    // towers fire
    for (const t of state.towers) {
      const stats = towerStats(t);
      t.cooldown -= dt;
      if (t.cooldown <= 0) {
        const target = acquireTarget(t);
        if (target) {
          shoot(t, target);
          t.cooldown = 1 / stats.rate;
        }
      }
    }

    // projectiles (homing toward current target position)
    for (const p of state.projectiles) {
      const tgt = p.target;
      if (tgt && tgt.alive) {
        const tp = state.path.posAt(tgt.s);
        const dx = tp.x - p.x, dy = tp.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d <= 10) {
          tgt.hp -= p.dmg;
          p.dead = true;
          if (tgt.hp <= 0) {
            tgt.alive = false;
            state.money += 5;
            updateHUD();
          }
        } else {
          const v = p.speed || 420;
          const ux = dx / (d || 1), uy = dy / (d || 1);
          p.vx = ux * v; p.vy = uy * v;
          p.x += p.vx * dt; p.y += p.vy * dt;
        }
      } else {
        // lost target, fade out
        p.dead = true;
      }
      // offscreen cleanup
      if (p.x < -20 || p.x > CANVAS_W + 20 || p.y < -20 || p.y > CANVAS_H + 20) p.dead = true;
    }
    state.projectiles = state.projectiles.filter(p => !p.dead);
  }

  function render() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawBackground();
    drawPath();
    drawTowers();
    drawProjectiles();
    drawEnemies();
    drawPlacementPreview();
  }

  function updateHUD() {
    moneyEl.textContent = String(state.money);
    livesEl.textContent = String(state.lives);
    waveEl.textContent = String(state.waveIndex + 1);
    const t = state.towers.find(x => x.id === state.selectedTowerId) || null;
    if (!t) {
      upPanel.style.opacity = 0.6;
      upLevel.textContent = upDmg.textContent = upRate.textContent = upRange.textContent = "-";
      upCostEl.textContent = "-";
      upBtn.disabled = true;
    } else {
      const s = towerStats(t);
      upPanel.style.opacity = 1;
      upLevel.textContent = String(t.level);
      upDmg.textContent = String(Math.round(s.damage));
      upRate.textContent = String(s.rate.toFixed(2));
      upRange.textContent = String(Math.round(s.range));
      if (t.level >= BASIC_TOWER.maxLevel) {
        upCostEl.textContent = "MAX";
        upBtn.disabled = true;
      } else {
        const cost = BASIC_TOWER.upgradeCost(t.level);
        upCostEl.textContent = String(cost);
        upBtn.disabled = state.money < cost;
      }
    }
  }

  function worldFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }

  function canPlaceTower(pos) {
    const minPath = 28; // cannot place within 28px of path
    const minTower = 30; // spacing from other towers
    if (pos.x < 20 || pos.x > CANVAS_W - 20 || pos.y < 20 || pos.y > CANVAS_H - 20) return false;
    const dPath = state.path.minDistTo(pos.x, pos.y);
    if (dPath < minPath) return false;
    for (const t of state.towers) if (dist(pos, t) < minTower) return false;
    return state.money >= BASIC_TOWER.baseCost;
  }

  let nextTowerId = 1;
  function addTower(pos) {
    if (!canPlaceTower(pos)) return false;
    state.money -= BASIC_TOWER.baseCost;
    state.towers.push({ id: nextTowerId++, x: pos.x, y: pos.y, level: 1, cooldown: 0 });
    updateHUD();
    return true;
  }

  function setPlacementActive(active) {
    state.selectedTool = active ? "place" : "none";
    btnBasic.classList.toggle("active", active);
  }

  function attachEvents() {
    canvas.addEventListener("mouseenter", () => state.mouse.inside = true);
    canvas.addEventListener("mouseleave", () => { state.mouse.inside = false; state.drag.overCanvas = false; });
    canvas.addEventListener("mousemove", (e) => {
      const p = worldFromEvent(e); state.mouse.x = p.x; state.mouse.y = p.y;
      if (state.drag.active) state.drag.overCanvas = true;
    });
    canvas.addEventListener("click", (e) => {
      const pos = worldFromEvent(e);
      // First: try selecting a tower
      const hit = state.towers.find(t => Math.hypot(t.x - pos.x, t.y - pos.y) <= 18);
      if (hit) {
        state.selectedTowerId = hit.id;
        updateHUD();
        return;
      }
      // clear selection when clicking empty
      state.selectedTowerId = null;
      updateHUD();
    });
    btnStart.addEventListener("click", startWave);
    // Drag-to-place from top button
    const beginDrag = (clientX, clientY) => {
      state.drag.active = true;
      state.drag.type = "basic";
      state.drag.overCanvas = false;
      const rect = canvas.getBoundingClientRect();
      state.mouse.x = (clientX - rect.left) * (canvas.width / rect.width);
      state.mouse.y = (clientY - rect.top) * (canvas.height / rect.height);
    };
    const endDrag = () => {
      if (!state.drag.active) return;
      if (state.drag.overCanvas) {
        const pos = { x: state.mouse.x, y: state.mouse.y };
        if (canPlaceTower(pos)) addTower(pos);
      }
      state.drag.active = false;
      state.drag.type = null;
      state.drag.overCanvas = false;
    };
    btnBasic.addEventListener("mousedown", (e) => { e.preventDefault(); beginDrag(e.clientX, e.clientY); });
    btnBasic.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (!t) return; e.preventDefault(); beginDrag(t.clientX, t.clientY); }, { passive: false });
    document.addEventListener("mouseup", endDrag);
    document.addEventListener("touchend", endDrag);
    document.addEventListener("mousemove", (e) => {
      if (!state.drag.active) return;
      const rect = canvas.getBoundingClientRect();
      state.mouse.x = (e.clientX - rect.left) * (canvas.width / rect.width);
      state.mouse.y = (e.clientY - rect.top) * (canvas.height / rect.height);
      state.drag.overCanvas = (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom);
    });
    document.addEventListener("touchmove", (e) => {
      if (!state.drag.active) return;
      const t = e.touches[0]; if (!t) return; e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      state.mouse.x = (t.clientX - rect.left) * (canvas.width / rect.width);
      state.mouse.y = (t.clientY - rect.top) * (canvas.height / rect.height);
      state.drag.overCanvas = (t.clientX >= rect.left && t.clientX <= rect.right && t.clientY >= rect.top && t.clientY <= rect.bottom);
    }, { passive: false });
    upBtn.addEventListener("click", () => {
      const t = state.towers.find(x => x.id === state.selectedTowerId);
      if (!t) return;
      if (t.level >= BASIC_TOWER.maxLevel) return;
      const cost = BASIC_TOWER.upgradeCost(t.level);
      if (state.money < cost) return;
      state.money -= cost;
      t.level += 1;
      updateHUD();
    });
  }

  function loop(ts) {
    if (!state.lastTs) state.lastTs = ts;
    let dt = (ts - state.lastTs) / 1000;
    dt = Math.min(dt, 0.05); // clamp dt to avoid huge steps
    state.lastTs = ts;
    update(dt);
    render();
    if (state.lives > 0) requestAnimationFrame(loop);
  }

  function init() {
    canvas.width = CANVAS_W; canvas.height = CANVAS_H;
    state.path = createDefaultPath();
    setPlacementActive(false);
    updateHUD();
    attachEvents();
    requestAnimationFrame(loop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
