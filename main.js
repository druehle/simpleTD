"use strict";

// Geometry TD - minimal HTML5 Canvas tower defense with geometric theme

(function () {
  // Canvas setup
  const CANVAS_W = 960;
  const CANVAS_H = 540;

  // UI elements
  const moneyEl = document.getElementById("money");
  const livesEl = document.getElementById("lives");
  const waveEl = document.getElementById("wave");
  const btnStart = document.getElementById("start-wave");
  const btnSquare = document.getElementById("select-square");
  const btnTriangle = document.getElementById("select-triangle");
  const btnHex = document.getElementById("select-hex");
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

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
    selectedType: "square",
  };

  const TOWER_TYPES = {
    square: {
      name: "Square",
      cost: 50,
      range: 120,
      damage: 15,
      rate: 1.1, // shots/sec
      color: "#3a86ff",
      shape: "square",
    },
    triangle: {
      name: "Triangle",
      cost: 60,
      range: 140,
      damage: 8,
      rate: 2.0,
      color: "#ff006e",
      shape: "triangle",
    },
    hex: {
      name: "Hexagon",
      cost: 80,
      range: 170,
      damage: 5,
      rate: 3.0,
      color: "#00bbf9",
      shape: "hex",
    },
  };

  const WAVES = [
    { count: 12, hp: 24, speed: 70, gap: 0.7 },
    { count: 16, hp: 34, speed: 75, gap: 0.65 },
    { count: 20, hp: 48, speed: 80, gap: 0.6 },
    { count: 24, hp: 65, speed: 90, gap: 0.55 },
    { count: 28, hp: 90, speed: 95, gap: 0.5 },
  ];

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
      // binary or linear search over segs; seg count is tiny, linear is fine
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
      for (const seg of this.segs) {
        d = Math.min(d, pointSegDist(x, y, seg.a.x, seg.a.y, seg.b.x, seg.b.y));
      }
      return d;
    }
  }

  function createDefaultPath() {
    // Define a simple zig-zag path across the canvas
    const P = [];
    const margin = 60;
    const leftOut = -40, rightOut = CANVAS_W + 40;
    P.push({ x: leftOut, y: margin });
    P.push({ x: 220, y: margin });
    P.push({ x: 220, y: 260 });
    P.push({ x: 520, y: 260 });
    P.push({ x: 520, y: 120 });
    P.push({ x: CANVAS_W - 140, y: 120 });
    P.push({ x: CANVAS_W - 140, y: CANVAS_H - margin });
    P.push({ x: rightOut, y: CANVAS_H - margin });
    return new Path(P);
  }

  function updateHUD() {
    moneyEl.textContent = String(state.money);
    livesEl.textContent = String(state.lives);
    waveEl.textContent = String(state.waveIndex + 1);
  }

  function worldFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }

  function canPlaceTower(pos, typeKey) {
    const type = TOWER_TYPES[typeKey];
    // Keep away from path and other towers
    const minPath = 28; // cannot place within 28px of path
    const minTower = 30; // spacing from other towers
    if (pos.x < 20 || pos.x > CANVAS_W - 20 || pos.y < 20 || pos.y > CANVAS_H - 20) return false;
    const dPath = state.path.minDistTo(pos.x, pos.y);
    if (dPath < minPath) return false;
    for (const t of state.towers) if (dist(pos, t) < minTower) return false;
    return state.money >= type.cost;
  }

  function addTower(pos, typeKey) {
    const type = TOWER_TYPES[typeKey];
    if (!canPlaceTower(pos, typeKey)) return false;
    state.money -= type.cost;
    state.towers.push({ x: pos.x, y: pos.y, type: typeKey, cooldown: 0 });
    updateHUD();
    return true;
  }

  // Enemy factory
  function spawnEnemy(hp, speed) {
    state.enemies.push({ s: 0, hp, speed, r: 12, alive: true, color: "#ffd166" });
  }

  function startWave() {
    if (state.inWave) return;
    const w = WAVES[Math.min(state.waveIndex, WAVES.length - 1)];
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
    const type = TOWER_TYPES[tower.type];
    for (const e of state.enemies) {
      if (!e.alive) continue;
      const p = state.path.posAt(e.s);
      const d = Math.hypot(tower.x - p.x, tower.y - p.y);
      if (d <= type.range && e.s > bestS) {
        best = e; bestS = e.s;
      }
    }
    return best;
  }

  function shoot(tower, target) {
    const type = TOWER_TYPES[tower.type];
    const origin = { x: tower.x, y: tower.y };
    const tp = state.path.posAt(target.s);
    const angle = Math.atan2(tp.y - origin.y, tp.x - origin.x);
    const speed = 420;
    // Store speed so we can re-aim (home) each frame toward the target
    state.projectiles.push({ x: origin.x, y: origin.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, speed, dmg: type.damage, target });
  }

  // Rendering helpers
  function drawBackground() {
    // grid
    ctx.save();
    ctx.lineWidth = 1;
    const step = 30;
    ctx.strokeStyle = "#111827";
    for (let x = 0; x <= CANVAS_W; x += step) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(CANVAS_W, y + 0.5); ctx.stroke();
    }
    ctx.restore();
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
  function drawTriangle(x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.strokeStyle = "#0a0c12";
    ctx.lineWidth = 2;
    const r = size / 2;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * (2 * Math.PI / 3);
      const vx = Math.cos(a) * r, vy = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawHex(x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.strokeStyle = "#0a0c12";
    ctx.lineWidth = 2;
    const r = size / 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * (2 * Math.PI / 6);
      const vx = Math.cos(a) * r, vy = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawTowers() {
    for (const t of state.towers) {
      const type = TOWER_TYPES[t.type];
      ctx.save();
      // subtle base
      ctx.globalAlpha = 0.07;
      ctx.beginPath(); ctx.arc(t.x, t.y, type.range, 0, Math.PI * 2); ctx.fillStyle = type.color; ctx.fill();
      ctx.globalAlpha = 1;
      switch (type.shape) {
        case "square": drawSquare(t.x, t.y, 24, type.color); break;
        case "triangle": drawTriangle(t.x, t.y, 28, type.color); break;
        case "hex": drawHex(t.x, t.y, 30, type.color); break;
      }
      ctx.restore();
    }
  }

  function drawEnemies() {
    ctx.save();
    for (const e of state.enemies) {
      if (!e.alive) continue;
      const p = state.path.posAt(e.s);
      // body
      const grd = ctx.createRadialGradient(p.x - 4, p.y - 4, 2, p.x, p.y, e.r + 3);
      grd.addColorStop(0, "#ffe29a");
      grd.addColorStop(1, e.color);
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(p.x, p.y, e.r, 0, Math.PI * 2); ctx.fill();
      // tiny health arc
      const hpRatio = clamp(e.hp / 100, 0, 1);
      ctx.strokeStyle = "#222a3a"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(p.x, p.y, e.r + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "#8bd9a3"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(p.x, p.y, e.r + 6, -Math.PI/2, -Math.PI/2 + hpRatio * Math.PI * 2); ctx.stroke();
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

  function drawPlacementPreview() {
    if (!state.mouse.inside) return;
    const pos = state.mouse;
    const ok = canPlaceTower(pos, state.selectedType);
    const type = TOWER_TYPES[state.selectedType];
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, type.range, 0, Math.PI * 2); ctx.fillStyle = ok ? type.color : "#ef4444"; ctx.fill();
    ctx.globalAlpha = 1;
    const c = ok ? type.color : "#ef4444";
    switch (type.shape) {
      case "square": drawSquare(pos.x, pos.y, 24, c); break;
      case "triangle": drawTriangle(pos.x, pos.y, 28, c); break;
      case "hex": drawHex(pos.x, pos.y, 30, c); break;
    }
    ctx.restore();
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
      const type = TOWER_TYPES[t.type];
      t.cooldown -= dt;
      if (t.cooldown <= 0) {
        const target = acquireTarget(t);
        if (target) {
          shoot(t, target);
          t.cooldown = 1 / type.rate;
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

  function loop(ts) {
    if (!state.lastTs) state.lastTs = ts;
    let dt = (ts - state.lastTs) / 1000;
    // clamp dt to avoid huge steps if tab was suspended
    dt = Math.min(dt, 0.05);
    state.lastTs = ts;
    update(dt);
    render();
    if (state.lives > 0) requestAnimationFrame(loop);
  }

  function setSelected(type) {
    state.selectedType = type;
    btnSquare.classList.toggle("active", type === "square");
    btnTriangle.classList.toggle("active", type === "triangle");
    btnHex.classList.toggle("active", type === "hex");
  }

  function attachEvents() {
    canvas.addEventListener("mouseenter", () => state.mouse.inside = true);
    canvas.addEventListener("mouseleave", () => state.mouse.inside = false);
    canvas.addEventListener("mousemove", (e) => {
      const p = worldFromEvent(e); state.mouse.x = p.x; state.mouse.y = p.y;
    });
    canvas.addEventListener("click", (e) => {
      const pos = worldFromEvent(e);
      addTower(pos, state.selectedType);
    });
    btnStart.addEventListener("click", startWave);
    btnSquare.addEventListener("click", () => setSelected("square"));
    btnTriangle.addEventListener("click", () => setSelected("triangle"));
    btnHex.addEventListener("click", () => setSelected("hex"));
  }

  function init() {
    // Fixed-size canvas: ensure backing store matches attributes
    canvas.width = CANVAS_W; canvas.height = CANVAS_H;
    state.path = createDefaultPath();
    setSelected("square");
    updateHUD();
    attachEvents();
    requestAnimationFrame(loop);
  }

  // Initialize after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
