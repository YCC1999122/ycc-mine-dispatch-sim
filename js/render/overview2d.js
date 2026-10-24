// 2D 总视角：纯 Canvas 平面态势图
// 只消费仿真快照与路网数据，不依赖 Three.js：路网 / 车辆 / 蓝色引导线 / 行驶轨迹 / 站点信息 / 电量血条
import { rimRadius, levelRadius } from '../world.js?v=world23';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;

const TONE = {
  move: '#5fd8ff', work: '#4ee6a2', queue: '#ffc25e',
  energy: '#a99cff', idle: '#7d8f98', drive: '#4ee6a2', alert: '#ff6b6b',
};

function toneOf(t) {
  if (t.state === 'stranded') return TONE.alert;
  if (t.manual) return TONE.drive;
  if (['to_shovel', 'to_dump', 'to_energy'].includes(t.state)) return TONE.move;
  if (t.state === 'loading' || t.state === 'dumping') return TONE.work;
  if (t.state.startsWith('queue_')) return TONE.queue;
  if (t.state === 'swapping' || t.state === 'charging') return TONE.energy;
  return TONE.idle;
}

// 每台车独立色相（黄金角散列）：放大后同车道并行的多条路线可区分
function routeColor(id, alpha = 0.9) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10) || 0;
  return `hsla(${Math.round((n * 137.508) % 360)}, 88%, 62%, ${alpha})`;
}

const socColor = (v) => (v > 0.6 ? '#4ee6a2' : v > 0.35 ? '#ffc25e' : '#ff6b6b');

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, str, x, y, color, size = 10, weight = 500) {
  ctx.font = `${weight} ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = 'rgba(4, 10, 14, 0.8)';
  ctx.fillText(str, x + 0.9, y + 0.9);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

export class Overview2D {
  constructor(canvas, world, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.onSelect = opts.onSelect || (() => {});
    this.active = false;
    this.snap = null;
    this.byId = new Map();
    this.dpr = 1;
    this.W = 0;
    this.H = 0;
    this.range = 2950;
    this.fitScale = 0.3;   // 适配全图的基准比例
    this.scale = 0.3;
    this.zoom = 1;         // 缩放倍数（1 = 全图）
    this.ox = 0;           // 世界原点在画布上的位置（含平移）
    this.oy = 0;
    this.panX = 0;         // 平移量（画布像素）
    this.panY = 0;
    this.pos = new Map();       // 车辆平滑位置：id → { x, z, h }
    this.trails = new Map();    // 行驶轨迹：id → [[x, z], ...]
    this.selectedId = null;
    this.hoverId = null;
    this.mx = 0;
    this.my = 0;
    this.lastT = 0;
    this.drag = null;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointer(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => { this.hoverId = null; this.drag = null; });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => this.resetView());
    window.addEventListener('resize', () => { if (this.active) this.resize(); });
  }

  px(x) { return this.ox + x * this.scale; }
  py(z) { return this.oy - z * this.scale; }

  setActive(on) {
    this.active = on;
    if (on) {
      this.zoom = 1;
      this.resize();
      this.lastT = 0;
    }
  }

  setSelected(id) { this.selectedId = id; }

  setSnapshot(s) {
    this.snap = s;
    this.byId = new Map(s.trucks.map((t) => [t.id, t]));
  }

  reset() {
    this.pos.clear();
    this.trails.clear();
    this.snap = null;
    this.byId.clear();
  }

  // ---------------- 尺寸与视图变换 ----------------
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = r.width;
    this.H = r.height;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    const pad = 52;
    this.fitScale = Math.min((this.W - pad * 2) / (this.range * 2), (this.H - pad * 2) / (this.range * 2));
    this.applyView();
  }

  // 缩放 + 平移：世界原点固定在画布中心并叠加平移量
  applyView() {
    this.scale = this.fitScale * this.zoom;
    this.ox = this.W / 2 + this.panX;
    this.oy = this.H / 2 + this.panY;
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyView();
  }

  // 静态底图：采坑、台段、路网（每帧按当前视图变换重绘，缩放后依然清晰）
  drawBase(g) {
    // 底色
    const bg = g.createRadialGradient(this.W / 2, this.H / 2, 40, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.75);
    bg.addColorStop(0, '#0a1925');
    bg.addColorStop(1, '#050c12');
    g.fillStyle = bg;
    g.fillRect(0, 0, this.W, this.H);

    // 500m 网格
    g.strokeStyle = 'rgba(96, 168, 196, 0.07)';
    g.lineWidth = 1;
    for (let v = -3000; v <= 3000; v += 500) {
      g.beginPath();
      g.moveTo(this.px(v), this.py(-2950));
      g.lineTo(this.px(v), this.py(2950));
      g.stroke();
      g.beginPath();
      g.moveTo(this.px(-2950), this.py(v));
      g.lineTo(this.px(2950), this.py(v));
      g.stroke();
    }

    const ring = (rFn) => {
      g.beginPath();
      for (let i = 0; i <= 96; i++) {
        const th = (i / 96) * Math.PI * 2;
        const r = rFn(th);
        const x = this.px(Math.cos(th) * r);
        const y = this.py(Math.sin(th) * r);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.closePath();
    };

    // 采坑轮廓与台段等高线
    ring((th) => rimRadius(th));
    g.fillStyle = 'rgba(16, 40, 54, 0.92)';
    g.fill();
    g.strokeStyle = 'rgba(95, 216, 255, 0.5)';
    g.lineWidth = 1.4;
    g.stroke();
    for (let l = 1; l < this.world.config.pit.levels; l++) {
      ring((th) => levelRadius(th, l));
      g.strokeStyle = `rgba(95, 216, 255, ${0.2 - l * 0.028})`;
      g.lineWidth = 1;
      g.stroke();
    }

    // 路网：深色路面 + 淡蓝中心线
    for (const rd of this.world.roads) {
      const pts = rd.pts.map((i) => this.world.nodes[i]).filter(Boolean);
      if (pts.length < 2) continue;
      g.beginPath();
      pts.forEach((n, i) => {
        const x = this.px(n.x);
        const y = this.py(n.z);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.lineWidth = Math.max(1.6, rd.width * this.scale);
      g.strokeStyle = rd.kind === 'ramp' ? 'rgba(44, 72, 88, 0.95)' : 'rgba(31, 54, 68, 0.95)';
      g.stroke();
      g.lineWidth = 0.9;
      g.strokeStyle = 'rgba(125, 200, 228, 0.16)';
      g.stroke();
    }

    // 远景能源设施：火电厂 / 光伏电站 / 风电场 + 高压输电走廊
    for (const f of this.world.facilities || []) {
      const x = this.px(f.x);
      const y = this.py(f.z);
      if (f.kind === 'thermal') {
        g.fillStyle = 'rgba(176, 71, 47, 0.82)';
        g.fillRect(x - 15, y - 10, 30, 20);
        g.strokeStyle = 'rgba(240, 150, 120, 0.75)';
        g.lineWidth = 1;
        g.strokeRect(x - 15, y - 10, 30, 20);
        g.fillStyle = '#e8b6a4';
        g.beginPath(); g.arc(x - 7, y - 4, 3.4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(x + 5, y - 4, 3.4, 0, Math.PI * 2); g.fill();
        text(g, '南岭火电厂', x + 20, y - 4, '#e8b6a4', 9.5, 600);
        text(g, '燃煤 · 高压送矿', x + 20, y + 8, 'rgba(210, 180, 170, 0.8)', 8.5, 400);
      } else if (f.kind === 'solar') {
        g.strokeStyle = '#6fa8d8';
        g.lineWidth = 0.9;
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 5; c++) {
            g.fillStyle = 'rgba(58, 96, 156, 0.75)';
            g.fillRect(x - 16 + c * 7, y - 12 + r * 6, 5.4, 3.4);
          }
        }
        text(g, '东北光伏电站', x + 22, y - 3, '#9fc6e6', 9.5, 600);
        text(g, '成排光伏板 · 并网', x + 22, y + 9, 'rgba(170, 200, 220, 0.8)', 8.5, 400);
      } else if (f.kind === 'wind') {
        g.strokeStyle = '#b8d6de';
        g.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
          const wx = x - 14 + i * 11;
          const wy = y + (i % 2 ? -5 : 4);
          g.beginPath(); g.arc(wx, wy, 1.8, 0, Math.PI * 2); g.fillStyle = '#b8d6de'; g.fill();
          for (let k = 0; k < 3; k++) {
            const a = (k * Math.PI * 2) / 3 + i * 0.5;
            g.beginPath(); g.moveTo(wx, wy);
            g.lineTo(wx + Math.cos(a) * 6.5, wy + Math.sin(a) * 6.5);
            g.stroke();
          }
        }
        text(g, '西岭风电场', x - 40, y + 20, '#b8d6de', 9.5, 600);
      }
    }
    if (this.world.hvLine && this.world.hvLine.pts.length > 1) {
      const p = this.world.hvLine.pts;
      g.beginPath();
      p.forEach((q, i) => {
        const x = this.px(q.x);
        const y = this.py(q.z);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.setLineDash([4, 3]);
      g.strokeStyle = 'rgba(240, 170, 120, 0.6)';
      g.lineWidth = 1.1;
      g.stroke();
      g.setLineDash([]);
      for (const q of p) {
        g.beginPath();
        g.arc(this.px(q.x), this.py(q.z), 1.8, 0, Math.PI * 2);
        g.fillStyle = 'rgba(240, 170, 120, 0.9)';
        g.fill();
      }
    }
  }

  // ---------------- 每帧推进 ----------------
  frame(now) {
    if (!this.active) return;
    if (!this.W || !this.H) this.resize();
    if (!this.W || !this.H) return;
    const dt = this.lastT ? Math.min(0.12, (now - this.lastT) / 1000) : 0.016;
    this.lastT = now;
    this.step(dt);
    this.render();
  }

  step(dt) {
    if (!this.snap) return;
    const k = Math.min(1, dt * 9);
    for (const t of this.snap.trucks) {
      let p = this.pos.get(t.id);
      if (!p) {
        p = { x: t.x, z: t.z, h: t.heading || 0 };
        this.pos.set(t.id, p);
      }
      p.x = lerp(p.x, t.x, k);
      p.z = lerp(p.z, t.z, k);
      let dh = (t.heading || 0) - p.h;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      p.h += dh * k;

      let tr = this.trails.get(t.id);
      if (!tr) { tr = []; this.trails.set(t.id, tr); }
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last[0] - t.x, last[1] - t.z) > 9) {
        tr.push([t.x, t.z]);
        if (tr.length > 150) tr.shift();
      }
    }
  }

  // ---------------- 绘制 ----------------
  render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBase(ctx);

    if (this.snap) {
      this.drawRoutes(ctx);
      this.drawTrails(ctx);
      this.drawFacilities(ctx);
      this.drawTrucks(ctx);
      this.drawTitle(ctx);
      if (this.hoverId) this.drawHover(ctx);
      if (this.selectedId) this.drawSelected(ctx);
    }
    this.drawLegend(ctx);
    this.drawScale(ctx);
  }

  // 蓝色引导线：车辆剩余规划路线（从当前所在段开始，避免把已走过的路段倒着连回去）
  drawRoutes(ctx) {
    ctx.save();
    ctx.lineWidth = 1.8;
    ctx.setLineDash([7, 6]);
    for (const t of this.snap.trucks) {
      if (!t.pathPts || t.pathPts.length < 2 || t.manual) continue;
      const p = this.pos.get(t.id) || t;
      const pts = t.pathPts;
      // 快照里的 seg 是当前所在的路径段：只画剩余部分，否则会出现横穿场景的直线
      const seg = Math.max(0, Math.min(pts.length - 1, t.seg || 0));
      const color = routeColor(t.id, 0.92);
      ctx.strokeStyle = color;
      ctx.shadowColor = routeColor(t.id, 0.5);
      ctx.shadowBlur = t.id === this.selectedId ? 9 : 4;
      ctx.beginPath();
      ctx.moveTo(this.px(p.x), this.py(p.z));
      for (let i = seg + 1; i < pts.length; i++) {
        ctx.lineTo(this.px(pts[i][0]), this.py(pts[i][2]));
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // 行驶轨迹：车辆走过的位置尾迹
  drawTrails(ctx) {
    ctx.save();
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    for (const [id, tr] of this.trails) {
      if (tr.length < 2) continue;
      ctx.beginPath();
      tr.forEach((q, i) => {
        const x = this.px(q[0]);
        const y = this.py(q[1]);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.strokeStyle = routeColor(id, 0.34);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawFacilities(ctx) {
    const s = this.snap;
    ctx.save();
    ctx.textBaseline = 'middle';

    // 电铲（橙菱）
    for (const sv of s.shovels) {
      const x = this.px(sv.x);
      const y = this.py(sv.z);
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 7, y);
      ctx.lineTo(x, y + 7);
      ctx.lineTo(x - 7, y);
      ctx.closePath();
      ctx.fillStyle = '#dfa53c';
      ctx.fill();
      ctx.strokeStyle = '#ffd999';
      ctx.lineWidth = 1;
      ctx.stroke();
      text(ctx, `${sv.id} · ${sv.stateLabel} · 排队 ${sv.queue}`, x + 11, y - 2, '#e8c17a', 9.5);
      text(ctx, `${Math.round(sv.extracted)} t`, x + 11, y + 9, 'rgba(190, 205, 214, 0.8)', 9);
    }

    // 能源站（绿圆）
    for (const st of s.stations) {
      const w = this.world.stations.find((k) => k.id === st.id);
      if (!w) continue;
      const x = this.px(w.x);
      const y = this.py(w.z);
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = '#2fa87a';
      ctx.fill();
      ctx.strokeStyle = '#7df0c4';
      ctx.lineWidth = 1;
      ctx.stroke();
      text(ctx, `${st.name} · 待用包 ${st.ready} · 排队 ${st.queue}`, x + 11, y - 2, '#7df0c4', 9.5);
      const busy = st.bay ? 1 : 0;
      text(ctx, `换电工位 ${busy ? '占用' : '空闲'} · 已服务 ${st.served}`, x + 11, y + 9, 'rgba(190, 205, 214, 0.8)', 9);
    }

    // 破碎站 / 排土场（按世界模型的卸载点列表绘制）
    for (const d of this.world.dumps.list) {
      const st = s.dumps.find((k) => k.id === d.id);
      const x = this.px(d.x);
      const y = this.py(d.z);
      if (d.type === 'waste') {
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x + 7, y + 5);
        ctx.lineTo(x - 7, y + 5);
        ctx.closePath();
        ctx.fillStyle = '#8a7250';
        ctx.fill();
        ctx.strokeStyle = '#d7bd8e';
        ctx.stroke();
        text(ctx, `${d.name} · 卸车排队 ${st ? st.queue : 0}`, x + 11, y, '#d7bd8e', 9.5);
      } else {
        ctx.fillStyle = '#6f7c85';
        ctx.fillRect(x - 6, y - 6, 12, 12);
        ctx.strokeStyle = '#c3d2da';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 6, y - 6, 12, 12);
        text(ctx, `${d.name} · 卸车排队 ${st ? st.queue : 0}`, x + 11, y, '#c3d2da', 9.5);
      }
    }

    ctx.restore();
  }

  drawTrucks(ctx) {
    ctx.save();
    ctx.textBaseline = 'middle';
    for (const t of this.snap.trucks) {
      const p = this.pos.get(t.id) || t;
      const x = this.px(p.x);
      const y = this.py(p.z);
      const tone = toneOf(t);
      const sel = t.id === this.selectedId;

      // 车体（朝向 = 航向）
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.h);
      rr(ctx, -5.4, -10, 10.8, 20, 3);
      ctx.fillStyle = tone;
      ctx.shadowColor = tone;
      ctx.shadowBlur = sel ? 14 : 5;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(4, 12, 18, 0.75)';
      ctx.fillRect(-3.6, -8.6, 7.2, 6);
      ctx.restore();

      // 电量血条
      const soc = clamp(t.soc, 0, 1);
      ctx.fillStyle = 'rgba(5, 14, 20, 0.9)';
      ctx.fillRect(x - 13, y + 12.5, 26, 4);
      ctx.fillStyle = socColor(soc);
      ctx.fillRect(x - 13, y + 12.5, 26 * soc, 4);

      if (sel || this.hoverId === t.id) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, 17, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawTitle(ctx) {
    const s = this.snap;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    text(ctx, '总视角 · 二维实时态势', this.W / 2, 24, 'rgba(210, 240, 250, 0.9)', 14, 600);
    const weather = { clear: '晴', dust: '扬尘', rain: '降雨', snow: '降雪', wind: '大风', sandstorm: '风沙' }[s.weather] || '晴';
    text(ctx, `${s.clock} · ${weather} · ${s.paused ? '已暂停' : `${s.speed}× 运行`}`, this.W / 2, 42, 'rgba(140, 180, 198, 0.85)', 10.5, 400);
    ctx.restore();
  }

  drawLegend(ctx) {
    const items = [
      ['#5fd8ff', '行驶'], ['#4ee6a2', '装卸/人工'], ['#ffc25e', '排队'],
      ['#a99cff', '换电'], ['#7d8f98', '待命'], ['#48beff', '各车路线'],
    ];
    const w = 360;
    const h = 44;
    const x = 14;
    const y = this.H - h - 14;
    ctx.save();
    rr(ctx, x, y, w, h, 7);
    ctx.fillStyle = 'rgba(6, 16, 22, 0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 213, 240, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    let cx = x + 14;
    for (const [color, label] of items) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, y + 15, 3.6, 0, Math.PI * 2);
      ctx.fill();
      text(ctx, label, cx + 7, y + 15.5, 'rgba(200, 222, 232, 0.9)', 9.5, 400);
      cx += 20 + ctx.measureText(label).width;
    }
    text(ctx, `滚轮缩放 ${this.zoom.toFixed(1)}× · 拖拽平移 · 双击复位`, x + 14, y + 33, 'rgba(140, 180, 198, 0.9)', 9, 400);
    ctx.restore();
  }

  drawScale(ctx) {
    const len = 500 * this.scale;
    const x = this.W - 14 - len;
    const y = this.H - 24;
    ctx.save();
    ctx.strokeStyle = 'rgba(180, 220, 236, 0.75)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + len, y - 4);
    ctx.lineTo(x + len, y + 4);
    ctx.stroke();
    text(ctx, '500 m', x + len / 2 - 13, y - 10, 'rgba(170, 205, 220, 0.9)', 9.5, 400);
    ctx.restore();
  }

  drawHover(ctx) {
    const t = this.byId.get(this.hoverId);
    if (!t) return;
    const p = this.pos.get(t.id) || t;
    const x = this.px(p.x);
    const y = this.py(p.z);
    const str = `${t.id} · ${t.manual ? '人工驾驶' : t.stateLabel} · 电量 ${Math.round(t.soc * 100)}% · 载重 ${Math.round(t.payload)} t`;
    ctx.save();
    ctx.font = '500 10px "Segoe UI", "Microsoft YaHei", sans-serif';
    const w = ctx.measureText(str).width + 16;
    const bx = clamp(x + 16, 8, this.W - w - 8);
    const by = clamp(y - 34, 8, this.H - 34);
    rr(ctx, bx, by, w, 22, 6);
    ctx.fillStyle = 'rgba(6, 16, 22, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 213, 240, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textBaseline = 'middle';
    text(ctx, str, bx + 8, by + 11.5, '#d8f0f8', 10, 500);
    ctx.restore();
  }

  drawSelected(ctx) {
    const t = this.byId.get(this.selectedId);
    if (!t) return;
    const p = this.pos.get(t.id) || t;
    const x = this.px(p.x);
    const y = this.py(p.z);
    const lines = [
      `${t.id} · ${t.manual ? '人工驾驶' : t.stateLabel}`,
      `电量 ${Math.round(t.soc * 100)}%　载重 ${Math.round(t.payload)} t`,
      `目标 ${t.targetName || '无'}　车速 ${(t.v * 3.6).toFixed(1)} km/h`,
    ];
    ctx.save();
    ctx.font = '500 10px "Segoe UI", "Microsoft YaHei", sans-serif';
    let w = 0;
    for (const s of lines) w = Math.max(w, ctx.measureText(s).width);
    w += 18;
    const h = 14 + lines.length * 14;
    const bx = clamp(x + 20, 8, this.W - w - 8);
    const by = clamp(y - h - 12, 8, this.H - h - 8);
    rr(ctx, bx, by, w, h, 7);
    ctx.fillStyle = 'rgba(6, 16, 22, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 213, 240, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 电量条
    ctx.fillStyle = 'rgba(5, 14, 20, 0.9)';
    ctx.fillRect(bx + 8, by + h - 5, w - 16, 2.4);
    ctx.fillStyle = socColor(clamp(t.soc, 0, 1));
    ctx.fillRect(bx + 8, by + h - 5, (w - 16) * clamp(t.soc, 0, 1), 2.4);
    ctx.textBaseline = 'middle';
    lines.forEach((s, i) => text(ctx, s, bx + 9, by + 12 + i * 14, i ? 'rgba(196, 220, 232, 0.9)' : '#d8f0f8', 10, i ? 400 : 600));
    ctx.restore();
  }

  // ---------------- 交互：缩放 / 平移 / 选中 ----------------
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    if (e.button !== 0) return;
    const p = this.local(e);
    this.drag = { x: p.x, y: p.y, px: this.panX, py: this.panY, moved: false };
    if (this.canvas.setPointerCapture) this.canvas.setPointerCapture(e.pointerId);
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved) { this.canvas.style.cursor = 'grab'; return; }
    // 未拖动才算点选，避免平移结束时误选车辆
    const id = this.pick(e);
    if (id) this.onSelect(id);
  }

  onPointer(e) {
    const p = this.local(e);
    this.mx = p.x;
    this.my = p.y;
    if (this.drag) {
      const dx = p.x - this.drag.x;
      const dy = p.y - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.panX = this.drag.px + dx;
        this.panY = this.drag.py + dy;
        this.clampPan();
        this.applyView();
        this.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    this.hoverId = this.pick(e);
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab';
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.local(e);
    const wx = (p.x - this.ox) / this.scale;
    const wz = (this.oy - p.y) / this.scale;
    const next = clamp(this.zoom * Math.exp(-e.deltaY * 0.0014), 1, 8);
    if (Math.abs(next - this.zoom) < 1e-4) return;
    this.zoom = next;
    // 以鼠标位置为锚点缩放：光标下的世界坐标在屏幕上保持不动
    this.panX = p.x - this.W / 2 - wx * this.fitScale * this.zoom;
    this.panY = p.y - this.H / 2 + wz * this.fitScale * this.zoom;
    this.clampPan();
    this.applyView();
  }

  clampPan() {
    const half = this.range * this.fitScale * this.zoom * 0.5;
    this.panX = clamp(this.panX, -half, half);
    this.panY = clamp(this.panY, -half, half);
  }

  pick(e) {
    const p = this.local(e);
    this.mx = p.x;
    this.my = p.y;
    if (!this.snap) return null;
    let best = null;
    let bd = 18 * 18;
    for (const t of this.snap.trucks) {
      const q = this.pos.get(t.id) || t;
      const dx = this.px(q.x) - p.x;
      const dy = this.py(q.z) - p.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = t; }
    }
    return best ? best.id : null;
  }
}
