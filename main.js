"use strict";

// Geometry TD (simplified) — single tower type + upgrades
(function () {
  // Canvas setup
  const CANVAS_W = 960;
  const CANVAS_H = 500;

  // UI elements
  const moneyEl = document.getElementById("money");
  const livesEl = document.getElementById("lives");
  const waveEl = document.getElementById("wave");
  const btnStart = document.getElementById("start-wave");
  const autoWaveCb = document.getElementById("auto-wave");
  const turboCb = document.getElementById("turbo");
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
    particles: [],
    spawnQueue: [],
    spawnInterval: 0,
    spawnElapsed: 0,
    mouse: { x: 0, y: 0, inside: false },
    selectedTool: "none", // or "place"
    selectedTowerId: null,
    drag: { active: false, type: null, overCanvas: false },
    autoWave: false,
    nextWaveTimer: 0,
    overlay: { visible: false, earned: 0, completedWave: 0 },
    turbo: false,
  };

  // Tower definitions + upgrade scaling
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

  const BOMBER_TOWER = {
    name: "Bomber",
    baseCost: 80,
    color: "#f97316",
    baseRange: 120,
    baseDamage: 18,
    baseRate: 0.9, // shots/sec
    projectileSpeed: 420,
    baseSplash: 20, // starts adjacent-only feel
    perLevel: { range: 10, damage: 6, rate: 0.12, splash: 10 },
    maxLevel: 6,
    upgradeCost(level) {
      return Math.round(80 * Math.pow(1.55, level - 1));
    }
  };

  function getTowerCfg(type) { return type === "bomber" ? BOMBER_TOWER : BASIC_TOWER; }

  function towerStats(t) {
    const cfg = getTowerCfg(t.type);
    const lvl = t.level || 1;
    const s = {
      range: cfg.baseRange + (cfg.perLevel.range || 0) * (lvl - 1),
      damage: cfg.baseDamage + (cfg.perLevel.damage || 0) * (lvl - 1),
      rate: cfg.baseRate + (cfg.perLevel.rate || 0) * (lvl - 1),
      projectileSpeed: cfg.projectileSpeed,
    };
    s.splash = (cfg.baseSplash || 0) + ((cfg.perLevel.splash || 0) * (lvl - 1));
    return s;
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
    // Snake-like path with dynamic lanes to fit current height
    const P = [];
    const top = 80;
    const bottom = CANVAS_H - 80;
    const leftOut = -80;
    const rightOut = CANVAS_W + 80;
    const left = 80;
    const right = CANVAS_W - 80;
    const span = Math.max(60, bottom - top);
    const lane = Math.min(120, Math.max(40, Math.floor(span / 3)));

    // Enter from left
    P.push({ x: leftOut, y: top });
    // First run to right
    P.push({ x: right, y: top });
    // Down a lane
    P.push({ x: right, y: top + lane });
    // Back to left (loop 1)
    P.push({ x: left, y: top + lane });
    // Down again
    P.push({ x: left, y: top + lane * 2 });
    // To right (loop 2)
    P.push({ x: right, y: top + lane * 2 });
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

  // Reward for completing a wave (not kill money)
  function completionReward(index) { // index is 0-based
    return 50; // flat reward; adjust if desired
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

  // Explosion particles
  function spawnParticles(x, y, color, count = 14) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 120 + Math.random() * 140;
      state.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + Math.random() * 0.4, color });
    }
  }

  function updateParticles(dt) {
    const g = 600; // quick gravity to settle pixels fast
    for (const p of state.particles) {
      p.life -= dt;
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    state.particles = state.particles.filter(p => p.life > 0 && p.y < CANVAS_H + 10);
  }

  function drawParticles() {
    if (state.particles.length === 0) return;
    ctx.save();
    for (const p of state.particles) {
      const alpha = Math.max(0, Math.min(1, p.life / 0.9));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color || "#ffd166";
      ctx.fillRect(p.x, p.y, 2, 2);
    }
    ctx.restore();
  }

  function explodeAt(x, y, splashDmg, radius, exclude) {
    if (radius <= 0 || splashDmg <= 0) return;
    spawnParticles(x, y, "#fbbf24");
    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (exclude && e === exclude) continue;
      const ep = state.path.posAt(e.s);
      const d = Math.hypot(ep.x - x, ep.y - y);
      if (d <= radius) {
        e.hp -= splashDmg;
        if (e.hp <= 0) { e.alive = false; state.money += 5; updateHUD(); }
      }
    }
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
      const cfg = getTowerCfg(t.type);
      const selected = (t.id === state.selectedTowerId);
      ctx.save();
      // subtle range disc
      ctx.globalAlpha = 0.07;
      ctx.beginPath(); ctx.arc(t.x, t.y, s.range, 0, Math.PI * 2); ctx.fillStyle = cfg.color; ctx.fill();
      ctx.globalAlpha = 1;
      // body
      drawSquare(t.x, t.y, 24, cfg.color);
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

  function drawOverlay() {
    if (!state.overlay.visible) return;
    ctx.save();
    // dim background
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // center panel
    const panelW = Math.min(520, CANVAS_W - 40);
    const panelH = 120;
    const px = (CANVAS_W - panelW) / 2;
    const py = (CANVAS_H - panelH) / 2;

    ctx.fillStyle = "#151a22";
    ctx.strokeStyle = "#202737";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(px, py, panelW, panelH);
    ctx.fill(); ctx.stroke();

    // text
    ctx.fillStyle = "#e6edf3";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const centerX = px + panelW / 2;
    const line1 = `Wave ${state.overlay.completedWave} Complete`;
    const line2 = `Completion reward: +$${state.overlay.earned}`;
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText(line1, centerX, py + 36);
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText(line2, centerX, py + 64);

    if (state.autoWave) {
      const secs = Math.max(0, state.nextWaveTimer);
      const line3 = `Next wave in ${secs.toFixed(1)}s`;
      ctx.fillStyle = "#9aa4b2";
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText(line3, centerX, py + 90);
    } else {
      ctx.fillStyle = "#9aa4b2";
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText("Click Start Wave when ready", centerX, py + 90);
    }

    ctx.restore();
  }

  function drawPlacementPreview() {
    const show = (state.selectedTool === "place") || state.drag.active;
    if (!(state.mouse.inside || state.drag.overCanvas)) return;
    if (!show) return;
    const pos = state.mouse;
    const ok = canPlaceTower(pos);
    const tempType = pendingTowerType();
    const s = towerStats({ level: 1, type: tempType });
    const cfg = getTowerCfg(tempType);
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, s.range, 0, Math.PI * 2); ctx.fillStyle = ok ? cfg.color : "#ef4444"; ctx.fill();
    ctx.globalAlpha = 1;
    const c = ok ? cfg.color : "#ef4444";
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
    state.nextWaveTimer = 0;
    state.overlay.visible = false;
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
    const kind = (tower.type === "bomber") ? "explosive" : "normal";
    const splash = stats.splash || 0;
    state.projectiles.push({ x: origin.x, y: origin.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, speed, dmg: stats.damage, target, kind, splash });
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
        const completedWave = state.waveIndex + 1; // 1-based number of the wave just finished
        const reward = completionReward(state.waveIndex);
        state.money += reward; // completion reward only
        // show overlay summary
        state.overlay.visible = true;
        state.overlay.earned = reward;
        state.overlay.completedWave = completedWave;
        if (state.autoWave) {
          state.nextWaveTimer = 5; // seconds until next wave
        } else {
          state.nextWaveTimer = 0;
        }
        // advance to next wave index for upcoming start
        state.waveIndex++;
        updateHUD();
      }
    }

    // enemies along path
    const speedMul = state.turbo ? 2 : 1;
    for (const e of state.enemies) {
      if (!e.alive) continue;
      e.s += e.speed * speedMul * dt;
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
          // impact
          tgt.hp -= p.dmg;
          p.dead = true;
          if (p.kind === "explosive") {
            explodeAt(tp.x, tp.y, Math.round(p.dmg * 0.6), p.splash, tgt);
          }
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

    // particles
    updateParticles(dt);

    // auto wave countdown when idle
    if (!state.inWave && state.autoWave) {
      const idle = state.spawnQueue.length === 0 && state.enemies.every(e => !e.alive);
      if (idle && state.nextWaveTimer > 0) {
        state.nextWaveTimer -= dt;
        if (state.nextWaveTimer <= 0) startWave();
      }
    }
  }

  function render() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawBackground();
    drawPath();
    drawTowers();
    drawProjectiles();
    drawParticles();
    drawEnemies();
    drawPlacementPreview();
    drawOverlay();
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
      const cfg = getTowerCfg(t.type);
      upPanel.style.opacity = 1;
      upLevel.textContent = String(t.level);
      upDmg.textContent = String(Math.round(s.damage));
      upRate.textContent = String(s.rate.toFixed(2));
      upRange.textContent = String(Math.round(s.range));
      if (t.level >= cfg.maxLevel) {
        upCostEl.textContent = "MAX";
        upBtn.disabled = true;
      } else {
        const cost = cfg.upgradeCost(t.level);
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

  function pendingTowerType() {
    if (state.drag.active && state.drag.type) return state.drag.type;
    if (state.selectedTool === "place") return "basic";
    return "basic";
  }

  function canPlaceTower(pos) {
    const minPath = 28; // cannot place within 28px of path
    const minTower = 30; // spacing from other towers
    if (pos.x < 20 || pos.x > CANVAS_W - 20 || pos.y < 20 || pos.y > CANVAS_H - 20) return false;
    const dPath = state.path.minDistTo(pos.x, pos.y);
    if (dPath < minPath) return false;
    for (const t of state.towers) if (dist(pos, t) < minTower) return false;
    const cfg = getTowerCfg(pendingTowerType());
    return state.money >= cfg.baseCost;
  }

  let nextTowerId = 1;
  function addTower(pos) {
    if (!canPlaceTower(pos)) return false;
    const type = pendingTowerType();
    const cfg = getTowerCfg(type);
    state.money -= cfg.baseCost;
    state.towers.push({ id: nextTowerId++, type, x: pos.x, y: pos.y, level: 1, cooldown: 0 });
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
    // Auto wave toggle
    autoWaveCb.addEventListener("change", () => {
      state.autoWave = !!autoWaveCb.checked;
      if (!state.autoWave) {
        state.nextWaveTimer = 0;
      } else {
        // If idle right now, start a countdown
        if (!state.inWave && state.spawnQueue.length === 0 && state.enemies.every(e => !e.alive)) {
          state.nextWaveTimer = 5;
        }
      }
    });
    // TURBO toggle
    if (turboCb) {
      turboCb.addEventListener("change", () => {
        state.turbo = !!turboCb.checked;
      });
    }
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
    const beginDragType = (clientX, clientY, type) => {
      state.drag.active = true;
      state.drag.type = type;
      state.drag.overCanvas = false;
      const rect = canvas.getBoundingClientRect();
      state.mouse.x = (clientX - rect.left) * (canvas.width / rect.width);
      state.mouse.y = (clientY - rect.top) * (canvas.height / rect.height);
    };
    btnBasic.addEventListener("mousedown", (e) => { e.preventDefault(); beginDragType(e.clientX, e.clientY, "basic"); });
    btnBasic.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (!t) return; e.preventDefault(); beginDragType(t.clientX, t.clientY, "basic"); }, { passive: false });
    const btnBomber = document.getElementById("select-bomber");
    if (btnBomber) {
      btnBomber.addEventListener("mousedown", (e) => { e.preventDefault(); beginDragType(e.clientX, e.clientY, "bomber"); });
      btnBomber.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (!t) return; e.preventDefault(); beginDragType(t.clientX, t.clientY, "bomber"); }, { passive: false });
    }
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
      const cfg = getTowerCfg(t.type);
      if (t.level >= cfg.maxLevel) return;
      const cost = cfg.upgradeCost(t.level);
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
    // initialize auto wave based on checkbox
    state.autoWave = !!(autoWaveCb && autoWaveCb.checked);
    state.turbo = !!(turboCb && turboCb.checked);
    requestAnimationFrame(loop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
