// 后台调度仿真引擎（与渲染完全解耦，可无头运行）
// 负责：路径规划、卡车状态机、电铲装载、破碎站/排土场卸车、能源站换电与充电排队、能耗、指标

import { CONFIG, heightAt } from '../world.js?v=world23';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round1 = (v) => Math.round(v * 10) / 10;

const STATE_LABEL = {
  idle: '待命',
  to_shovel: '驶向装车点',
  queue_shovel: '装车排队',
  loading: '装车中',
  to_dump: '重载运输',
  queue_dump: '卸车排队',
  dumping: '卸车中',
  to_energy: '驶向能源站',
  queue_energy: '能源站排队',
  swapping: '换电中',
  charging: '补电中',
  stranded: '动力受限',
  manual: '人工驾驶',
};

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v, p) {
    const a = this.a;
    a.push({ v, p });
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j].p <= a[i].p) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].p < a[m].p) m = l;
        if (r < a.length && a[r].p < a[m].p) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class SimEngine {
  constructor(world) {
    this.world = world;
    this.cfg = CONFIG;
    this.nodes = world.nodes;
    // 地面高程索引：人工驾驶需按「路面节点高程 → 路肩过渡 → 自然地形」取地面高度。
    // 若直接用地形函数，会在削平后的路面外侧取到高于路面的自然地面，坡度过大把车卡死
    this.groundCell = 96;
    this.groundGrid = new Map();
    for (const n of this.nodes) {
      const k = `${Math.floor(n.x / this.groundCell)},${Math.floor(n.z / this.groundCell)}`;
      let arr = this.groundGrid.get(k);
      if (!arr) { arr = []; this.groundGrid.set(k, arr); }
      arr.push(n);
    }
    this.edgeMap = new Map();
    this.adj = this.nodes.map(() => []);
    for (const e of world.edges) {
      const k = this.key(e.a, e.b);
      this.edgeMap.set(k, e);
      // 按道路定义的方向建有向邻接：坡道是单向走廊（东下西上），
      // 双向邻接会让车辆把坡道当捷径，产生对头车流并卡死
      const dir = e.dir || 0;
      if (dir >= 0) this.adj[e.a].push({ to: e.b, e });
      if (dir <= 0) this.adj[e.b].push({ to: e.a, e });
    }

    this.time = this.cfg.site.shiftStart;
    this.elapsed = 0;
    this.speed = 1;
    this.paused = false;
    this.weather = 'clear';
    this.mode = this.cfg.dispatch.mode;
    this.logAll = [];
    this.pendingLogs = [];
    this.logSeq = 0;
    this.spCache = new Map();
    this.stationKwhCache = new Map();
    this.dispatchTimer = 0;
    this.autoSeq = 0;

    // 车辙磨损台账：键「有向路段 > 横向轨位」→ { w: 碾压次数, t: 记录时刻 }
    // 规划路线时按近期磨损挑最轻的轨位，避免同一条车辙被反复碾压压坏路面
    this.rut = new Map();
    this.rutPruneAt = 0;

    this.totalTonnes = 0;
    this.oreTonnes = 0;
    this.wasteTonnes = 0;
    this.trips = 0;
    this.swaps = 0;
    this.energyTruck = 0;
    this.energyGrid = 0;
    this.queueWaitSum = 0;
    this.cycleSum = 0;
    this.cycleCount = 0;
    this.prodEvents = [];
    this.shiftTarget = 68000;

    this.shovels = world.faces.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      level: f.level,
      node: f.padNode,
      pad: f,
      x: f.shovel.x,
      y: f.shovel.y,
      z: f.shovel.z,
      state: 'idle',
      busyTruck: null,
      timer: 0,
      queue: [],
      loadDuration: (this.cfg.truck.payload / this.cfg.truck.loadRate) * 3600,
      extracted: 0,
      cut: 0,
      advance: 0,
      loads: 0,
    }));

    this.stations = world.stations.map((s) => ({
      ...s,
      queue: [],
      bay: null,
      stalls: new Array(s.chargeStalls).fill(null),
      packs: Array.from({ length: s.packs }, (_, i) => ({
        id: `${s.id}-P${i + 1}`,
        soc: clamp(0.94 - i * 0.02, 0.8, 1),
        state: 'ready',
      })),
      served: 0,
      waitSum: 0,
      waitCount: 0,
      energyDelivered: 0,
    }));

    // 卸载点：北破碎站 / 东破碎站（矿石）+ 西排土场（废岩），
    // 重载车按「运距 + 预计排队」分流，避免全部挤在同一破碎站
    this.dumps = world.dumps.list.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      node: d.node,
      bay: d.bay,
      x: d.x,
      z: d.z,
      y: d.y,
      queueSlots: d.queueSlots,
      queue: [],
      busy: null,
      timer: 0,
      state: 'idle',
      dumpTime: d.type === 'waste' ? this.cfg.truck.wasteDumpTime : this.cfg.truck.dumpTime,
    }));
    this.dumpMap = new Map(this.dumps.map((d) => [d.id, d]));

    this.trucks = [];
    this.initTrucks();
    this.log('system', 'YCC 矿山调度模拟引擎已接入（虚拟仿真）：40 台 100t 级电动矿卡 / 6 台电铲 / 4 座换电站 / 3 个卸载点', 'ok');
    this.log('system', '调度策略：时间成本最小化（运距 + 预计等待 + 匹配系数 + 矿种优先级），2s 滚动重调度', 'info');
    this.log('system', '路径规划：道路图 Dijkstra；装/卸/换电均按 FCFS 排队，换电站单工位作业', 'info');
  }

  key(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }

  // 人工驾驶取地面高度：在 96m 网格的 3×3 邻居里找最近路网节点，
  // 18m 内按该节点高程（路面），18~40m 与自然地形平滑混合（路肩），更远直接用自然地形
  groundY(x, z) {
    const cell = this.groundCell;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = null;
    let bd = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const arr = this.groundGrid.get(`${cx + i},${cz + j}`);
        if (!arr) continue;
        for (const n of arr) {
          const dx = n.x - x;
          const dz = n.z - z;
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = n; }
        }
      }
    }
    const base = heightAt(x, z, this.cfg.pit);
    if (!best) return base;
    const d = Math.sqrt(bd);
    if (d < 18) return best.y;
    if (d < 40) {
      const w = 1 - (d - 18) / 22;
      return base * (1 - w) + best.y * w;
    }
    return base;
  }

  truck(id) { return this.trucks.find((t) => t.id === id); }

  clock() {
    const total = Math.floor(this.time) % 86400;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  log(tag, text, level = 'info') {
    this.logSeq++;
    const rec = { seq: this.logSeq, t: this.time, clock: this.clock(), tag, text, level };
    this.logAll.push(rec);
    if (this.logAll.length > 400) this.logAll.shift();
    this.pendingLogs.push(rec);
    if (this.pendingLogs.length > 80) this.pendingLogs.shift();
    return rec;
  }

  // ---------- 图与路径 ----------
  shortest(source) {
    if (this.spCache.has(source)) return this.spCache.get(source);
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    dist[source] = 0;
    const heap = new MinHeap();
    heap.push(source, 0);
    while (heap.size) {
      const cur = heap.pop();
      if (!cur) break;
      const u = cur.v;
      if (cur.p > dist[u] + 1e-9) continue;
      for (const { to, e } of this.adj[u]) {
        const w = e.len / e.speed;
        const nd = cur.p + w;
        if (nd < dist[to] - 1e-9) {
          dist[to] = nd;
          prev[to] = u;
          heap.push(to, nd);
        }
      }
    }
    const res = { dist, prev };
    this.spCache.set(source, res);
    if (this.spCache.size > 600) {
      const first = this.spCache.keys().next().value;
      this.spCache.delete(first);
    }
    return res;
  }

  pathTo(a, b) {
    if (a === b) {
      const n = this.nodes[a];
      return { nodes: [a], pts: [{ x: n.x, y: n.y, z: n.z, cum: 0 }], length: 0, time: 0, speeds: [], dys: [] };
    }
    const { prev } = this.shortest(a);
    if (prev[b] === -1) return null;
    const list = [];
    let cur = b;
    while (cur !== -1 && cur !== a) { list.push(cur); cur = prev[cur]; }
    if (cur !== a) return null;
    list.push(a);
    list.reverse();
    return this.buildPath(list);
  }

  buildPath(list) {
    // 原始折线（记录每条有向段的限速与坡度，缺边时补默认值避免索引错位）
    const raw = [];
    const segSpeed = [];
    const segDy = [];
    let tm = 0;
    for (let i = 0; i < list.length; i++) {
      const n = this.nodes[list[i]];
      if (i > 0) {
        const e = this.edgeMap.get(this.key(list[i - 1], list[i]));
        if (e) {
          tm += e.len / e.speed;
          segSpeed.push(e.speed);
          segDy.push(e.dy);
        } else {
          segSpeed.push(7);
          segDy.push(0);
        }
      }
      raw.push({ x: n.x, y: n.y, z: n.z, seg: Math.max(0, i - 1) });
    }
    // 路径圆角化：露天矿运输道不存在折角，所有转角一律做二次贝塞尔切弧。
    // 否则车辆严格沿折线行驶时会在节点处瞬时折向，渲染层表现为漂移、旋转、瞬移
    const CUT = (12 * Math.PI) / 180;
    const smoothPts = [];
    for (let i = 0; i < raw.length; i++) {
      const P = raw[i];
      if (i === 0 || i === raw.length - 1) { smoothPts.push(P); continue; }
      const A = raw[i - 1], B = raw[i + 1];
      const inX = P.x - A.x, inZ = P.z - A.z;
      const outX = B.x - P.x, outZ = B.z - P.z;
      const inL = Math.hypot(inX, inZ), outL = Math.hypot(outX, outZ);
      if (inL < 1e-3 || outL < 1e-3) { smoothPts.push(P); continue; }
      const cosA = clamp((inX * outX + inZ * outZ) / (inL * outL), -1, 1);
      if (Math.acos(cosA) < CUT) { smoothPts.push(P); continue; }
      // 切点距拐点 d：不超过相邻两段长度的 44%，保证相邻圆角互不重叠
      const d = Math.min(30, 0.44 * inL, 0.44 * outL);
      const f1 = d / inL, f2 = d / outL;
      const P1 = { x: P.x - inX * f1, y: P.y - (P.y - A.y) * f1, z: P.z - inZ * f1, seg: i - 1 };
      const P2 = { x: P.x + outX * f2, y: P.y + (B.y - P.y) * f2, z: P.z + outZ * f2, seg: i };
      smoothPts.push(P1);
      for (let s = 1; s < 7; s++) {
        const u = s / 7;
        const w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
        smoothPts.push({
          x: w0 * P1.x + w1 * P.x + w2 * P2.x,
          y: w0 * P1.y + w1 * P.y + w2 * P2.y,
          z: w0 * P1.z + w1 * P.z + w2 * P2.z,
          seg: u < 0.5 ? i - 1 : i,
        });
      }
      smoothPts.push(P2);
    }
    const pts = [];
    const speeds = [];
    const dys = [];
    let cum = 0;
    for (let j = 0; j < smoothPts.length; j++) {
      const p = smoothPts[j];
      if (j > 0) {
        const q = smoothPts[j - 1];
        cum += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
        const src = clamp(q.seg, 0, segSpeed.length - 1);
        speeds.push(segSpeed[src]);
        dys.push(segDy[src]);
      }
      pts.push({ x: p.x, y: p.y, z: p.z, cum });
    }
    return { nodes: list, pts, length: cum, time: tm, speeds, dys };
  }

  nearestNode(x, z) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  samplePath(path, d) {
    if (!path) return null;
    const pts = path.pts;
    if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, z: pts[0].z, heading: 0 };
    let i = 0;
    while (i < pts.length - 2 && d > pts[i + 1].cum) i++;
    const a = pts[i], b = pts[i + 1];
    const len = Math.max(1e-6, b.cum - a.cum);
    const f = clamp((d - a.cum) / len, 0, 1);
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      heading: Math.atan2(b.x - a.x, b.z - a.z),
    };
  }

  // ---------- 能耗预判 ----------
  // 路径牵引能耗（含坡度与天气）。用于在「电量还够」时就近改正路线，
  // 避免车辆一路开到断电、停在窄路中央把整条运输道堵死
  pathKwh(path, payload, fromCum = 0) {
    if (!path || !path.pts || path.pts.length < 2) return 0;
    const c = this.cfg.truck;
    const base = payload > 0 ? c.consLoaded : c.consEmpty;
    let kwh = 0;
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i - 1];
      const b = path.pts[i];
      if (b.cum <= fromCum) continue;
      const ds = b.cum - Math.max(a.cum, fromCum);
      if (ds <= 0.01) continue;
      const grade = (b.y - a.y) / Math.max(0.5, ds);
      let cons = base;
      if (grade > 0) cons *= 1 + grade * (payload > 0 ? 9 : 3);
      else if (grade < 0) cons *= 1 + grade * 2;
      kwh += (ds / 1000) * cons * this.weatherCons();
    }
    return kwh;
  }

  // 从某个节点到最近能源站的空载能耗（结果缓存，避免每帧重复最短路）
  stationKwhFrom(node) {
    if (this.stationKwhCache.has(node)) return this.stationKwhCache.get(node);
    let best = Infinity;
    for (const st of this.stations) {
      const p = this.pathTo(node, st.node);
      if (!p) continue;
      const k = this.pathKwh(p, 0);
      if (k < best) best = k;
    }
    const v = Number.isFinite(best) ? best : Infinity;
    this.stationKwhCache.set(node, v);
    return v;
  }

  // 电量守卫：每一小段时间校核一次「跑到目的地 + 之后再开到能源站」的电量余量
  guardEnergy(t) {
    if (t.state !== 'to_shovel' && t.state !== 'to_dump') return;
    if (!t.path || t.path.pts.length < 2) return;
    const c = this.cfg.truck;
    const batt = c.batteryKwh;
    const dest = t.path.nodes[t.path.nodes.length - 1];
    const need = this.pathKwh(t.path, t.payload, t.progress);
    const after = this.stationKwhFrom(dest);
    const margin = batt * 0.05 + (c.auxKw * 600) / 3600;
    if (t.soc * batt >= need * 1.08 + after + margin) return;
    const st = this.pickStation(t);
    if (!st) return;
    this.log(
      'energy',
      `${t.id} 电量 ${Math.round(t.soc * 100)}%，不足以完成当前行程（需 ${round1(need + after)}kWh），提前改道补能`,
      'warn'
    );
    this.sendToEnergy(t, '电量预检');
    t.energyCheckAt = 0;
  }

  // 重载/空载能否安全抵达目标节点（含到站后的续航余量）
  canReach(t, node, payload) {
    const path = this.pathTo(t.lastNode, node);
    if (!path) return false;
    const batt = this.cfg.truck.batteryKwh;
    const need = this.pathKwh(path, payload);
    return t.soc * batt >= need + this.stationKwhFrom(node) + batt * 0.06;
  }

  // 兜底救援：万一真的断电，把车辆拖离运输道并送到最近能源站，
  // 不让它长时间停在窄路中间形成路障
  rescueTruck(t) {
    let st = this.stations[0];
    let bd = Infinity;
    for (const s of this.stations) {
      const n = this.nodes[s.node];
      const d = Math.hypot(n.x - t.x, n.z - t.z);
      if (d < bd) { bd = d; st = s; }
    }
    this.releaseJob(t);
    const n = this.nodes[st.node];
    t.x = n.x; t.y = n.y; t.z = n.z;
    t.v = 0;
    t.path = null;
    t.progress = 0;
    t.seg = 0;
    t.parkTarget = null;
    t.soc = Math.max(t.soc, 0.06);
    t.state = 'idle';
    t.dispatchAt = 0;
    t.lastNode = st.node;
    this.log('alert', `${t.id} 已由救援拖车拖离运输道，拖至 ${st.name} 补能`, 'warn');
    this.dispatchTruck(t);
  }

  // ---------- 初始化 ----------
  initTrucks() {
    const c = this.cfg.truck;
    for (let i = 0; i < c.count; i++) {
      const sp = this.world.spawnPoints[i];
      const node = sp.node;
      const socs = [0.92, 0.8, 0.68, 0.56, 0.44, 0.24, 0.88, 0.76, 0.63, 0.51, 0.31, 0.72, 0.9, 0.58, 0.28, 0.82];
      this.trucks.push({
        id: `T-${101 + i}`,
        idx: i,
        x: this.nodes[node].x,
        y: this.nodes[node].y,
        z: this.nodes[node].z,
        heading: 0,
        v: 0,
        state: 'idle',
        payload: 0,
        soc: socs[i % socs.length],
        targetId: null,
        targetName: '',
        targetKind: null,
        lastNode: node,
        path: null,
        progress: 0,
        seg: 0,
        queueEnterAt: 0,
        loadStartAt: 0,
        queueWait: 0,
        tripQueue: 0,
        cycleStart: 0,
        lastCycle: 0,
        trips: 0,
        tonnes: 0,
        energy: 0,
        movingTime: 0,
        dispatchAt: 0,
        loadType: null,
        alert: '',
        lane: i % 2,        // 0=内车道 9m，1=外车道 20m（右行制），出发时按路线冲突重排
      });
    }
    // 初始派工
    for (const t of this.trucks) this.dispatchTruck(t, true);
  }

  // ---------- 调度 ----------
  // 天气对车速与能耗的影响（纯电动矿卡，无尾气）
  weatherSpeed() {
    switch (this.weather) {
      case 'dust': return 0.88;
      case 'rain': return 0.76;
      case 'snow': return 0.66;
      case 'wind': return 0.92;
      case 'sandstorm': return 0.58;
      default: return 1;
    }
  }

  weatherCons() {
    switch (this.weather) {
      case 'dust': return 1.03;
      case 'rain': return 1.06;
      case 'snow': return 1.12;
      case 'wind': return 1.04;
      case 'sandstorm': return 1.15;
      default: return 1;
    }
  }

  activeShovels() {
    return this.shovels.filter((s) => s.state !== 'down');
  }

  assignedCount(shovelId) {
    let n = 0;
    for (const t of this.trucks) {
      if (t.targetId === shovelId && (t.state === 'to_shovel' || t.state === 'queue_shovel' || t.state === 'loading')) n++;
    }
    return n;
  }

  pickShovel(t) {
    const active = this.activeShovels();
    if (!active.length) return null;
    let best = null;
    for (const s of active) {
      // 硬容量：一台电铲最多接收「泊位 + 排队车位」数量的车辆，
      // 超出的车辆不再派往此处，避免排队溢出叠成一团把台段路堵死
      const cap = s.pad.queueSlots.length + 1;
      const assigned = this.assignedCount(s.id);
      if (assigned >= cap) continue;
      const path = this.pathTo(t.lastNode, s.node);
      if (!path) continue;
      const wait = (s.queue.length + (s.busyTruck ? 1 : 0)) * s.loadDuration;
      let score = path.time + wait * 1.05;
      score += Math.max(0, assigned - 4) * 170;
      if (this.mode === 'production') score += s.type === 'waste' ? 110 : -40;
      if (this.mode === 'energy') score += 30;
      if (t.soc < 0.4 && s.type === 'waste') score += 20;
      if (!best || score < best.score) best = { s, path, score, assigned, wait };
    }
    return best;
  }

  assignShovel(t, best) {
    if (!best) return false;
    const s = best.s;
    t.targetId = s.id;
    t.targetKind = 'shovel';
    t.targetName = s.name;
    t.state = 'to_shovel';
    this.startRoute(t, s.node);
    this.log(
      'dispatch',
      `${t.id} → ${s.id}｜运距 ${round1(best.path.length / 1000)}km，预计等待 ${round1(best.wait / 60)}min，当前该铲在途 ${best.assigned} 台`,
      'dispatch'
    );
    return true;
  }

  pickStation(t) {
    let best = null;
    const batt = this.cfg.truck.batteryKwh;
    for (const st of this.stations) {
      const path = this.pathTo(t.lastNode, st.node);
      if (!path) continue;
      const ready = st.packs.filter((p) => p.state === 'ready' && p.soc >= 0.78).length;
      const load = st.queue.length + (st.bay ? 1 : 0);
      const wait = st.queue.length * st.swapTime + (st.bay ? st.swapTime : 0) + (ready ? 0 : 420);
      const travelKwh = this.pathKwh(path, t.payload);
      const feasible = t.soc * batt - travelKwh > batt * 0.04;
      let score = path.time + wait * 0.95;
      if (!feasible) score += 100000;
      score += Math.max(0, load - st.queueSlots.length) * 90;
      if (!best || score < best.score) best = { st, path, score, wait, feasible };
    }
    return best;
  }

  sendToEnergy(t, reason = 'SOC') {
    const best = this.pickStation(t);
    if (!best) {
      this.log('alert', `${t.id} 电量 ${Math.round(t.soc * 100)}%，但没有可达能源站`, 'critical');
      return false;
    }
    t.targetId = best.st.id;
    t.targetKind = 'station';
    t.targetName = best.st.name;
    t.state = 'to_energy';
    this.startRoute(t, best.st.node);
    this.log(
      'energy',
      `${t.id} 电量 ${Math.round(t.soc * 100)}% 触发${reason}，指派 ${best.st.id}｜运距 ${round1(best.path.length / 1000)}km，预计排队 ${round1(best.wait / 60)}min`,
      t.soc < 0.22 ? 'warn' : 'dispatch'
    );
    return true;
  }

  dispatchTruck(t, initial = false) {
    if (t.state !== 'idle') return;
    if (!initial && this.time < t.dispatchAt) return;
    t.dispatchAt = this.time + 4;
    if (t.soc <= this.cfg.truck.socSwap) {
      if (this.sendToEnergy(t, '换电阈值')) return;
    }
    const best = this.pickShovel(t);
    if (best) {
      this.assignShovel(t, best);
      return;
    }
    const st = this.pickStation(t);
    if (st) {
      t.targetId = st.st.id;
      t.targetKind = 'station';
      t.targetName = st.st.name;
      t.state = 'to_energy';
      this.startRoute(t, st.st.node);
      return;
    }
    if (this.time - (t.idleLogAt || 0) > 180) {
      t.idleLogAt = this.time;
      this.log('alert', `${t.id} 无可用装载点或能源站（容量已满），保持待命`, 'warn');
    }
  }

  // 补能结束后的去向：带着载荷的车必须继续去卸载点，
  // 不能被当成空车重新派去装车（否则载荷永远卸不掉，还会反复挤占充电位）
  routeAfterEnergy(t) {
    if (t.payload > 0) {
      const pick = this.pickDump(t, t.loadType || 'ore');
      if (pick) {
        t.targetId = pick.d.id;
        t.targetKind = 'dump';
        t.targetName = pick.d.name;
        t.state = 'to_dump';
        if (this.startRoute(t, pick.d.node)) return;
      }
    }
    t.state = 'idle';
    this.dispatchTruck(t);
  }

  startRoute(t, targetNode) {
    const path = this.pathTo(t.lastNode, targetNode);
    if (!path) {
      this.log('alert', `${t.id} 路径不可达：${t.lastNode} → ${targetNode}`, 'warn');
      t.state = 'idle';
      return false;
    }
    t.path = path;
    t.progress = 0;
    t.seg = 0;
    t.v = 0;
    t.parkTarget = null;
    // 单车道右行：所有车辆在同一条走廊里保持同一横向偏移。
    // 原先把车辆分散到 9m / 20m 两条车道「并行」，两车最终会在窄坡道里并排挤住，
    // 正是用户看到的「对向两车并排过不去」。取消双车道后，对向车流天然相隔 24m。
    t.lane = 0;
    // 车道内再按车辙磨损挑轨位，并把「车道 + 轨位」偏移烘焙进路径点：
    // 2D/3D 的引导线与实际行驶轨迹因此不再全部叠在道路中心线上
    t.track = this.pickTrack(t, path);
    this.applyTrackOffset(path, t.track);
    const p = path.pts[0];
    t.x = p.x; t.y = p.y; t.z = p.z;
    if (path.pts.length > 1) t.heading = Math.atan2(path.pts[1].x - p.x, path.pts[1].z - p.z);
    return true;
  }

  // 排队/泊位停靠：不直接改写车辆坐标，而是设置停靠目标，
  // 由 updateTrucks 逐帧平滑滑入，避免“瞬移到车位、撞上前车再弹回”的异常视觉
  parkTo(t, x, y, z, heading) {
    t.parkTarget = { x, y, z, heading };
  }

  // 车位取用：超出预置车位时沿队列方向继续向后延伸，
  // 绝不把所有车辆都叠在最后一个车位上（那是整车场堵死的直接原因）
  slotAt(slots, i) {
    if (!slots || !slots.length) return null;
    if (i < slots.length) return slots[i];
    const last = slots[slots.length - 1];
    const prev = slots.length > 1 ? slots[slots.length - 2] : null;
    let dx, dz;
    if (prev) {
      dx = last.x - prev.x;
      dz = last.z - prev.z;
    } else {
      dx = -Math.sin(last.heading) * 55;
      dz = -Math.cos(last.heading) * 55;
    }
    const len = Math.hypot(dx, dz) || 1;
    const k = i - slots.length + 1;
    return {
      x: last.x + (dx / len) * 55 * k,
      y: last.y,
      z: last.z + (dz / len) * 55 * k,
      heading: last.heading,
    };
  }

  // 目标设施当前占用的车位深度（米）：队尾距泊位的预留距离。
  // 行驶路径终点是泊位中心，若前方已有车辆排队，应在队尾处提前入列，
  // 而不是一路开到泊位与正在作业的车辆重叠
  queueHoldback(t) {
    let n = 0;
    if (t.state === 'to_shovel') {
      const s = this.shovels.find((x) => x.id === t.targetId);
      if (!s) return null;
      n = s.queue.length + (s.busyTruck ? 1 : 0);
    } else if (t.state === 'to_dump') {
      const d = this.dumpMap.get(t.targetId);
      if (!d) return null;
      n = d.queue.length + (d.busy ? 1 : 0);
    } else if (t.state === 'to_energy') {
      const st = this.stations.find((x) => x.id === t.targetId);
      if (!st) return null;
      n = st.queue.length + (st.bay ? 1 : 0);
    } else return null;
    if (n <= 0) return null;
    return n * 56 + 18;
  }

  updateParking(t, dt) {
    const p = t.parkTarget;
    if (!p) return;
    const k = Math.min(1, dt * 2.0); // 低速滑入，约 1~2 秒到位
    const dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z;
    if (Math.hypot(dx, dy, dz) < 0.05) {
      t.x = p.x; t.y = p.y; t.z = p.z;
    } else {
      t.x += dx * k; t.y += dy * k; t.z += dz * k;
    }
    let dh = p.heading - (t.heading || 0);
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    t.heading = (t.heading || 0) + dh * k;
  }

  // ---------- 主循环 ----------
  tick(dt) {
    if (this.paused || dt <= 0) return;
    this.elapsed += dt;
    this.time += dt;

    this.updateStations(dt);
    this.updateShovels(dt);
    this.updateDumps(dt);
    this.updateTrucks(dt);

    this.dispatchTimer += dt;
    if (this.dispatchTimer >= this.cfg.dispatch.tick) {
      this.dispatchTimer = 0;
      for (const t of this.trucks) if (t.state === 'idle') this.dispatchTruck(t);
    }

    this.pruneProduction();
  }

  updateTrucks(dt) {
    for (const t of this.trucks) {
      // 附件功耗
      const aux = (this.cfg.truck.auxKw * dt) / 3600;
      t.soc = clamp(t.soc - aux / this.cfg.truck.batteryKwh, 0, 1);
      t.energy += aux;
      this.energyTruck += aux;

      if (t.state === 'manual') {
        this.driveManual(t, dt);
      } else if (t.state === 'to_shovel' || t.state === 'to_dump' || t.state === 'to_energy') {
        this.moveTruck(t, dt);
        t.movingTime += dt;
        // 每 6s 校核一次电量：发现在抵达目的地后无法再开到能源站就立即改道
        t.energyCheckAt = (t.energyCheckAt || 0) + dt;
        if (t.energyCheckAt >= 6) { t.energyCheckAt = 0; this.guardEnergy(t); }
      } else if (t.state === 'idle') {
        this.dispatchTruck(t);
      } else {
        // 排队/装载/卸车/换电/补电：如有停靠目标则平滑滑入车位
        this.updateParking(t, dt);
      }

      // 静止计时：用于识别「双方互等」的循环死锁，超时后按编号放行一方
      if (t.state !== 'stranded' && t.v < 0.05) t.stopSince = t.stopSince || this.time;
      else t.stopSince = 0;

      if (t.soc <= 0.001 && t.state !== 'stranded') {
        t.state = 'stranded';
        t.v = 0;
        t.rescueAt = this.time + 45;
        this.log('alert', `${t.id} 电量耗尽，已请求现场救援（45s 内拖离运输道）`, 'critical');
      }
      if (t.state === 'stranded' && this.time >= (t.rescueAt || 0)) this.rescueTruck(t);
      const waiting = ['queue_shovel', 'queue_dump', 'queue_energy'].includes(t.state)
        && this.time - (t.queueEnterAt || this.time) > 900;
      t.alert = t.soc < this.cfg.truck.socCritical ? '电量临界' : waiting ? '等待超时' : '';
    }
  }

  moveTruck(t, dt) {
    if (!t.path) { this.arrive(t); return; }
    const path = t.path;
    const pts = path.pts;
    if (pts.length < 2) { t.progress = 0; this.arrive(t); return; }

    let seg = t.seg;
    while (seg < pts.length - 2 && t.progress > pts[seg + 1].cum) seg++;
    t.seg = seg;
    const a = pts[seg], b = pts[seg + 1];
    const segLen = Math.max(1e-6, b.cum - a.cum);
    const grade = (path.dys[seg] || 0) / segLen;

    const segSpeed = (path.speeds[seg] || 10) * this.weatherSpeed();
    const maxV = Math.min(segSpeed, t.payload > 0 ? this.cfg.truck.vLoaded : this.cfg.truck.vEmpty);
    let target = maxV;
    target = Math.min(target, this.leaderCap(t));
    target = Math.min(target, this.proximityCap(t));

    if (target > t.v) t.v += Math.min(this.cfg.truck.accel * dt, target - t.v);
    else t.v -= Math.min(this.cfg.truck.decel * 1.25 * dt, t.v - target);
    t.v = clamp(t.v, 0, maxV);

    const ds = t.v * dt;
    t.progress += ds;

    // 能耗
    let cons = t.payload > 0 ? this.cfg.truck.consLoaded : this.cfg.truck.consEmpty;
    if (grade > 0) cons *= 1 + grade * (t.payload > 0 ? 9 : 3);
    else if (grade < 0) cons *= 1 + grade * 2;
    cons *= this.weatherCons();
    const kwh = (ds / 1000) * cons;
    t.soc = clamp(t.soc - kwh / this.cfg.truck.batteryKwh, 0, 1);
    t.energy += kwh;
    this.energyTruck += kwh;

    // 位置
    const f = clamp((t.progress - a.cum) / segLen, 0, 1);
    t.x = a.x + (b.x - a.x) * f;
    t.y = a.y + (b.y - a.y) * f;
    t.z = a.z + (b.z - a.z) * f;

    // 预瞄转向（pure pursuit）：取前方 30~55m 的目标点计算曲率并限制横摆角速度，
    // 让车辆提前在弯道前平滑打方向，而不是直行到节点后突然折角转弯
    const aim = this.samplePath(path, Math.min(path.length, t.progress + 30 + t.v * 2.4));
    if (aim) {
      const ax = aim.x - t.x;
      const az = aim.z - t.z;
      const ad = Math.max(1, Math.hypot(ax, az));
      let alpha = Math.atan2(ax, az) - (t.heading || 0);
      while (alpha > Math.PI) alpha -= Math.PI * 2;
      while (alpha < -Math.PI) alpha += Math.PI * 2;
      const kappa = (2 * Math.sin(alpha)) / ad;
      const yaw = clamp(kappa * t.v, -0.75, 0.75);
      t.heading = (t.heading || 0) + yaw * dt;
    }

    // 队尾提前入列：目标设施已有车辆排队/作业时，在距泊位 n 个车位深处停车入列，
    // 由 parkTarget 平滑滑入队尾车位，避免冲到泊位中心与前车重叠后再弹回
    const remain = path.length - t.progress;
    if (remain < 400) {
      const hold = this.queueHoldback(t);
      if (hold != null && remain <= hold) {
        this.arrive(t);
        return;
      }
    }

    if (t.progress >= path.length - 0.5) {
      t.progress = path.length;
      const end = pts[pts.length - 1];
      t.x = end.x; t.y = end.y; t.z = end.z;
      this.arrive(t);
    }
  }

  // 人工驾驶：由驾驶模式面板的键盘输入直接积分车辆运动，
  // 不再走路径跟踪状态机，车辆位置与朝向以人工操作为准
  driveManual(t, dt) {
    const cfg = this.cfg.truck;
    const inp = t.drive || {};
    // Shift 提速：前进 18m/s、倒车 9m/s；常规 11.5 / 5 m/s
    const maxF = inp.shift ? 18 : 11.5;
    const maxR = inp.shift ? 9 : 5;
    let target = 0;
    if (!inp.brake) {
      if (inp.w) target = maxF;
      else if (inp.s) target = -maxR;
    }
    const rate = inp.brake ? cfg.decel * 2.4 : target === 0 ? cfg.decel * 1.2 : cfg.accel * (inp.shift ? 3.2 : 2.2);
    if (t.v < target) t.v = Math.min(target, t.v + rate * dt);
    else t.v = Math.max(target, t.v - rate * dt);

    // 转向：转向角速度随车速建立，倒车时方向相反（与真实车辆一致）
    // A 左转 / D 右转（驾驶视角与地图左右一致）
    const steer = (inp.a ? 1 : 0) - (inp.d ? 1 : 0);
    if (steer && Math.abs(t.v) > 0.15) {
      const grip = Math.min(1, Math.abs(t.v) / 3.5);
      t.heading += steer * 0.95 * grip * Math.sign(t.v) * dt;
    }

    // 位置积分：贴合地形高程；台段边坡坡度过大车辆无法攀爬，被挡停
    const ds = t.v * dt;
    if (Math.abs(ds) > 1e-5) {
      const nx = clamp(t.x + Math.sin(t.heading) * ds, -1950, 1950);
      const nz = clamp(t.z + Math.cos(t.heading) * ds, -1950, 1950);
      const ny = this.groundY(nx, nz);
      const slope = Math.abs(ny - t.y) / Math.max(0.2, Math.abs(ds));
      if (slope > 0.75) t.v = 0; // 台段边坡、坑帮坡度过大，车辆无法攀爬
      else {
        t.x = nx; t.z = nz;
        // 路面高程平滑贴合，避免小台阶造成车身跳动
        t.y += (ny - t.y) * Math.min(1, dt * 8);
        if (Math.abs(ny - t.y) < 0.15) t.y = ny;
      }
    }

    // 牵引能耗（人工驾驶同样计入吨矿电耗）
    const cons = t.payload > 0 ? cfg.consLoaded : cfg.consEmpty;
    const kwh = (Math.abs(ds) / 1000) * cons * this.weatherCons();
    t.soc = clamp(t.soc - kwh / cfg.batteryKwh, 0, 1);
    t.energy += kwh;
    this.energyTruck += kwh;
    if (Math.abs(t.v) > 0.2) t.movingTime += dt;
  }

  // 进入/退出人工驾驶：进入时释放自动作业占用（排队、工位、路径），
  // 退出时交回调度系统重新派工
  setManual(truckId, on) {
    const t = this.truck(truckId);
    if (!t) return false;
    if (on) {
      if (t.state === 'manual') return true;
      this.releaseJob(t);
      t.state = 'manual';
      t.manual = true;
      t.v = 0;
      t.path = null;
      t.progress = 0;
      t.seg = 0;
      t.parkTarget = null;
      t.targetId = null;
      t.targetName = '';
      t.targetKind = null;
      t.lastNode = this.nearestNode(t.x, t.z);
      t.drive = { w: false, s: false, a: false, d: false, shift: false, brake: false };
      this.log('system', `${t.id} 切换为人工驾驶，自动驾驶任务已挂起（W/S 前进后退 · A/D 转向 · Shift 加速 · Space 制动）`, 'warn');
      return true;
    }
    if (t.state !== 'manual') return true;
    t.manual = false;
    t.drive = null;
    t.state = 'idle';
    t.v = 0;
    t.lastNode = this.nearestNode(t.x, t.z);
    this.log('system', `${t.id} 退出人工驾驶，交回调度系统`, 'ok');
    this.dispatchTruck(t);
    return true;
  }

  // 驾驶输入：仅接受人工驾驶状态下的车辆，避免与自动车辆状态机互相干扰
  setDrive(truckId, keys) {
    const t = this.truck(truckId);
    if (!t || t.state !== 'manual') return;
    t.drive = {
      w: !!keys.w, s: !!keys.s, a: !!keys.a, d: !!keys.d,
      shift: !!keys.shift, brake: !!keys.brake,
    };
  }

  // 释放车辆占用的所有自动作业资源（排队位、电铲/卸载点/能源站工位）
  releaseJob(t) {
    const id = t.id;
    for (const s of this.shovels) {
      s.queue = s.queue.filter((x) => x !== id);
      if (s.busyTruck === id) { s.busyTruck = null; s.timer = 0; s.state = 'idle'; }
    }
    for (const d of this.dumps) {
      d.queue = d.queue.filter((x) => x !== id);
      if (d.busy === id) { d.busy = null; d.timer = 0; d.state = 'idle'; }
    }
    for (const st of this.stations) {
      st.queue = st.queue.filter((x) => x !== id);
      if (st.bay && st.bay.truck === id) {
        if (st.bay.pack) st.bay.pack.state = 'waiting';
        st.bay = null;
      }
      st.stalls = st.stalls.map((rec) => (rec && rec.truck === id ? null : rec));
    }
    for (const s of this.shovels) this.refreshShovelQueue(s);
    for (const d of this.dumps) this.refreshDumpQueue(d);
    for (const st of this.stations) this.refreshStationQueue(st);
  }

  leaderCap(t) {
    // 沿本车剩余路径把其他车辆投影过来，判断「前方同走廊车辆」。
    // 关键：不能用航向点积做同向过滤。折返坡道的半圆掉头弯里，前车航向可与本车相差
    // 90° 以上，点积 < 0.5 会被误判成对向来车而被忽略；后车于是直接顶上去，
    // 两车叠到 1~10m 内，再互相被对方判成「正前方的停驶障碍」，永久死锁。
    if (!t.path || !t.path.pts || t.path.pts.length < 2) return Infinity;
    const pts = t.path.pts;
    const start = Math.max(0, (t.seg || 0) - 1);
    let cap = Infinity;
    const frozenT = this.time - (t.stopSince || this.time) > 120;
    for (const o of this.trucks) {
      if (o === t) continue;
      // 断电车辆按静止障碍处理：后车必须在其后方停车等待救援，
      // 而不是直接穿模开过去（穿模会让拥堵在视觉上变成一团重叠的车）
      const stuck = o.state === 'stranded';
      if (!stuck) {
        if (!o.path) continue;
        if (o.state !== 'to_shovel' && o.state !== 'to_dump' && o.state !== 'to_energy') continue;
      }
      if (Math.abs(o.x - t.x) > 180 || Math.abs(o.z - t.z) > 180) continue;
      let bd = Infinity;
      let bcum = 0;
      for (let i = start; i < pts.length; i++) {
        const d = (pts[i].x - o.x) ** 2 + (pts[i].z - o.z) ** 2;
        if (d < bd) { bd = d; bcum = pts[i].cum; }
      }
      if (bd > 196) continue; // 侧向偏离超过 14m，不在同一走廊（对向车流相隔 24m，不会被误判）
      const ahead = bcum - t.progress;
      if (ahead <= 0.5 || ahead > 130) continue;
      // 死锁兜底：双方都已静止超过 2 分钟且互为前方障碍时，按编号只让一方强行通过，
      // 避免「你等我、我等你」的循环等待（正常跟车不会进入该分支）
      if (frozenT && this.time - (o.stopSince || this.time) > 120 && o.id > t.id) continue;
      const limit = stuck
        ? Math.max(0, (ahead - 30) * 0.6)
        : Math.max(0, o.v + (ahead - this.cfg.truck.minGap) * 0.55);
      if (limit < cap) cap = limit;
    }
    return cap;
  }

  // 右行制：所有车辆统一靠自身航向右侧 12m 行驶（单车道）。
  // 因为偏移方向跟随各自航向，对向车流在世界上天然相隔 24m（远大于矿卡外廓 10.5m），
  // 双向道路上会车与「并排挤住」的问题从几何上消失。
  laneOffsetMeters() {
    return 12;
  }

  // 车道内可选轨位（相对车道中心，米）：-1.5 / 0 / +1.5。
  // 单车道净宽约 11m、矿卡外廓约 9m，±1.5m 既可错开车辙又留足安全余量
  trackSlots() {
    return [-1.5, 0, 1.5];
  }

  rutKey(a, b, off) { return `${a}>${b}|${off.toFixed(1)}`; }

  // 读取某路段某轨位的近期碾压强度（15min 半衰期：久未碾压的路面会自动“恢复”）
  rutWeight(a, b, off) {
    const r = this.rut.get(this.rutKey(a, b, off));
    if (!r) return 0;
    return r.w * Math.pow(0.5, Math.max(0, this.time - r.t) / 900);
  }

  // 整条路线的轨位磨损：按路段长度加权，长路段压得更狠
  rutScore(path, off) {
    let s = 0;
    const nodes = path.nodes;
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const e = this.edgeMap.get(this.key(a, b));
      s += this.rutWeight(a, b, off) * (e ? e.len : 32);
    }
    return s;
  }

  // 规划轨位：在本车道可选轨位里挑磨损最轻的一条，并记账本次碾压
  pickTrack(t, path) {
    const base = this.laneOffsetMeters(t);
    let best = base;
    let bs = Infinity;
    for (const slot of this.trackSlots()) {
      const off = base + slot;
      const sc = this.rutScore(path, off);
      if (sc < bs - 1e-6) { bs = sc; best = off; }
    }
    const nodes = path.nodes;
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      this.rut.set(this.rutKey(a, b, best), { w: this.rutWeight(a, b, best) + 1, t: this.time });
    }
    this.pruneRut();
    return best;
  }

  // 只保留 1 小时内的磨损记录，避免长班次里 Map 无限增长
  pruneRut() {
    if (this.time - this.rutPruneAt < 600) return;
    this.rutPruneAt = this.time;
    for (const [k, r] of this.rut) {
      if (this.time - r.t > 3600) this.rut.delete(k);
    }
  }

  // 把横向偏移烘焙进路径点：沿前进方向右手法向平移，前 45m 权重 0→1 渐变，
  // 保证起点仍落在当前节点上（不瞬移），同时整条路线都走在新车辙上。
  // 关键约束：弯道处允许的偏移不得超过局部曲率半径（收窄到 0.62R），
  // 否则偏移后的曲线会自交、出现小圈，车辆的预瞄点会跑到车后，表现为转弯处原地拼命打转
  applyTrackOffset(path, off) {
    if (!off) return;
    const pts = path.pts;
    const n = pts.length;
    if (n < 2) return;
    const absOff = Math.abs(off);

    // 每点前进方向（用前后邻点差分）
    const dirs = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      let l = Math.hypot(dx, dz);
      if (l < 1e-6) {
        const q = pts[i === 0 ? 1 : i - 1];
        dx = pts[i].x - q.x; dz = pts[i].z - q.z;
        l = Math.hypot(dx, dz) || 1;
      }
      dirs.push([dx / l, dz / l]);
    }

    // 逐点允许偏移：三点外接圆半径即局部曲率半径
    const allow = new Array(n);
    for (let i = 0; i < n; i++) {
      allow[i] = absOff;
      if (i === 0 || i === n - 1) continue;
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const bcx = c.x - b.x, bcz = c.z - b.z;
      const cax = c.x - a.x, caz = c.z - a.z;
      const la = Math.hypot(abx, abz), lb = Math.hypot(bcx, bcz), lc = Math.hypot(cax, caz);
      if (la < 1e-6 || lb < 1e-6 || lc < 1e-6) continue;
      // 叉积的符号：右转时为负；偏移方向指向曲率中心时才需要收窄
      const crossY = abx * bcz - abz * bcx;
      const inward = (off > 0) === (crossY < 0);
      if (!inward) continue;
      const r = (la * lb * lc) / Math.max(1e-6, 2 * Math.abs(crossY));
      allow[i] = Math.min(allow[i], 0.62 * r);
    }

    // 先取窗口最小值（防止相邻点突变造成折角），再滑动平均（让变道段平缓）
    const minWin = 6, avgWin = 8;
    const minArr = new Array(n);
    for (let i = 0; i < n; i++) {
      let m = allow[i];
      for (let j = Math.max(0, i - minWin); j <= Math.min(n - 1, i + minWin); j++) {
        if (allow[j] < m) m = allow[j];
      }
      minArr[i] = m;
    }
    const amount = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - avgWin); j <= Math.min(n - 1, i + avgWin); j++) { s += minArr[j]; c++; }
      amount[i] = Math.min(minArr[i], s / c);
    }

    for (let i = 0; i < n; i++) {
      const p = pts[i], [dx, dz] = dirs[i];
      const w = Math.min(1, p.cum / 45) * (amount[i] / absOff);
      if (w <= 0) continue;
      p.x += dz * off * w;    // 右手法向 = (dz, -dx)
      p.z += -dx * off * w;
    }
  }

  // 计算两车实际平面距离：路径点已把车道与轨位偏移烘焙进坐标，
  // 这里直接按真实位置计算；若再叠加 laneOffsetMeters 会重复计算，侧向间距被高估
  lateralSeparation(t, o) {
    const hx = Math.sin(t.heading || 0), hz = Math.cos(t.heading || 0);
    // t 相对自身航向的右向法向量
    const tRx = hz, tRz = -hx;
    // 把 o 投影到 t 的坐标系中，计算横向（侧向）距离
    const dx = o.x - t.x;
    const dz = o.z - t.z;
    const fwd = dx * hx + dz * hz;
    const lat = dx * tRx + dz * tRz;
    return { fwd, lat, dist: Math.hypot(fwd, lat) };
  }

  proximityCap(t) {
    const SAFE = 52;
    const STOP = 30;
    const MOVING = new Set(['to_shovel', 'to_dump', 'to_energy', 'manual', 'stranded']);
    let cap = Infinity;
    const frozenT = this.time - (t.stopSince || this.time) > 120;
    for (const o of this.trucks) {
      if (o === t) continue;
      if (!MOVING.has(o.state)) continue;
      const { fwd, lat, dist } = this.lateralSeparation(t, o);
      if (dist > SAFE || dist < 0.01) continue;
      // 只用实际侧向距离判断是否同一走廊，不看航向点积：掉头弯里两车航向差可达 90°+，
      // 点积会把正前方的前车判成对向车而忽略，导致后车顶上去叠车
      if (Math.abs(lat) <= 9) {
        if (fwd < 0.2) continue; // 正后方不影响
        if (frozenT && this.time - (o.stopSince || this.time) > 120 && o.id > t.id) continue;
        const limit = Math.max(0, (dist - STOP) * 0.75);
        if (limit < cap) cap = limit;
      } else if (dist < 22) {
        // 横向贴近（并排、擦碰）：降到低速留出横向净空，但绝不完全停死，
        // 否则两车会在窄路上互相卡住
        const limit = Math.max(1.5, (dist - 10) * 0.6);
        if (limit < cap) cap = limit;
      }
    }
    return cap;
  }

  arrive(t) {
    const path = t.path;
    if (!path) { t.state = 'idle'; return; }
    t.lastNode = path.nodes[path.nodes.length - 1];
    t.v = 0;

    if (t.state === 'to_shovel') {
      const s = this.shovels.find((x) => x.id === t.targetId);
      if (!s) { t.state = 'idle'; t.path = null; return; }
      t.state = 'queue_shovel';
      t.queueEnterAt = this.time;
      s.queue.push(t.id);
      this.log('load', `${t.id} 到达 ${s.id} 装车点，前方排队 ${Math.max(0, s.queue.length - 1)} 台`, 'trace');
      if (!s.busyTruck) this.startLoading(s);
      else this.refreshShovelQueue(s);
      return;
    }

    if (t.state === 'to_dump') {
      const d = this.dumpMap.get(t.targetId);
      if (!d) { t.state = 'idle'; t.path = null; return; }
      t.state = 'queue_dump';
      t.queueEnterAt = this.time;
      d.queue.push(t.id);
      this.log('dump', `${t.id} 抵达${d.name}，前方 ${Math.max(0, d.queue.length - 1)} 台待卸`, 'trace');
      if (!d.busy) this.startDump(d);
      else this.refreshDumpQueue(d);
      return;
    }

    if (t.state === 'to_energy') {
      const st = this.stations.find((x) => x.id === t.targetId);
      if (!st) { t.state = 'idle'; t.path = null; return; }
      t.state = 'queue_energy';
      t.queueEnterAt = this.time;
      st.queue.push(t.id);
      this.log('energy', `${t.id} 抵达 ${st.name}，排队 ${st.queue.length} 台`, 'trace');
      this.refreshStationQueue(st);
      this.serveStation(st);
      return;
    }
  }

  // ---------- 电铲 ----------
  updateShovels(dt) {
    for (const s of this.shovels) {
      if (s.state === 'down') continue;
      if (s.busyTruck) {
        s.timer -= dt;
        if (s.timer <= 0) this.finishLoading(s);
      } else if (s.queue.length) {
        this.startLoading(s);
      } else {
        s.state = 'idle';
      }
    }
  }

  startLoading(s) {
    if (s.busyTruck || !s.queue.length) return;
    const id = s.queue.shift();
    const t = this.truck(id);
    if (!t) return;
    s.busyTruck = id;
    s.timer = s.loadDuration;
    s.state = 'loading';
    t.state = 'loading';
    t.v = 0;
    t.path = null;
    t.progress = 0;
    this.parkTo(t, s.pad.spot.x, s.pad.spot.y, s.pad.spot.z, s.pad.bay.heading);
    const loadWait = Math.max(0, this.time - (t.queueEnterAt || this.time));
    t.queueWait += loadWait;
    t.tripQueue += loadWait;
    if (t.lastCycleStart) {
      const c = this.time - t.lastCycleStart;
      t.lastCycle = c;
      this.cycleSum += c;
      this.cycleCount++;
    }
    t.lastCycleStart = this.time;
    t.loadStartAt = this.time;
    this.refreshShovelQueue(s);
  }

  finishLoading(s) {
    const t = this.truck(s.busyTruck);
    if (!t) { s.busyTruck = null; return; }
    t.payload = this.cfg.truck.payload;
    t.loadType = s.type;
    s.loads++;
    s.extracted += t.payload;
    const prevCut = s.cut;
    s.cut = (s.extracted % 3000) / 3000;
    if (s.cut < prevCut) {
      s.advance++;
      this.log('system', `${s.id} 采掘带推进，新增清理场地 ${(0.4).toFixed(1)}ha，原矿岩区转为可行驶道路`, 'ok');
    }
    s.busyTruck = null;
    s.state = 'idle';
    const pick = this.pickDump(t, s.type);
    const dest = pick ? pick.d : this.dumps.find((d) => d.type === s.type);
    if (!dest) { t.state = 'idle'; this.dispatchTruck(t); return; }
    // 重载上坡能耗高：先确认电量够跑到卸载点、且卸完还够开到能源站，
    // 不够就先带着载荷去补能（载荷保留），避免半路断电堵住坡道
    if (!this.canReach(t, dest.node, t.payload)) {
      this.sendToEnergy(t, '重载续航不足');
      return;
    }
    t.targetId = dest.id;
    t.targetKind = 'dump';
    t.targetName = dest.name;
    t.state = 'to_dump';
    this.startRoute(t, dest.node);
    this.log('load', `${s.id} → ${t.id} 装载完成：${s.type === 'ore' ? '矿石' : '废岩'} ${t.payload}t，Soc ${Math.round(t.soc * 100)}%`, 'ok');
    if (s.queue.length) this.startLoading(s);
  }

  // 排队车辆滑入台段上的固定停车位，避免多车叠在装车点
  refreshShovelQueue(s) {
    const slots = s.pad.queueSlots;
    s.queue.forEach((id, i) => {
      const t = this.truck(id);
      if (!t) return;
      const slot = this.slotAt(slots, i);
      if (!slot) return;
      this.parkTo(t, slot.x, slot.y, slot.z, slot.heading);
      t.v = 0;
    });
  }

  // ---------- 卸载 ----------
  // 矿种匹配的卸载点里挑「运距 + 预计排队」最小的一个：
  // 两个破碎站并行作业时，只看运距会把车流全部压到近端，必须把队列时间计入；
  // 队列超过预置车位的部分按溢出惩罚拉开，避免几十台车全挤在同一条支路
  pickDump(t, type) {
    let best = null;
    for (const d of this.dumps) {
      if (d.type !== type) continue;
      const path = this.pathTo(t.lastNode, d.node);
      if (!path) continue;
      const assigned = this.trucks.filter((x) => x.state === 'to_dump' && x.targetId === d.id).length;
      const load = d.queue.length + (d.busy ? 1 : 0) + assigned;
      const wait = (d.queue.length + (d.busy ? 1 : 0)) * d.dumpTime;
      const score = path.time + wait * 1.05 + Math.max(0, load - d.queueSlots.length) * 130;
      if (!best || score < best.score) best = { d, path, score };
    }
    return best;
  }

  updateDumps(dt) {
    for (const d of this.dumps) {
      if (d.busy) {
        d.timer -= dt;
        if (d.timer <= 0) this.finishDump(d);
      } else if (d.queue.length) {
        this.startDump(d);
      } else {
        d.state = 'idle';
      }
    }
  }

  startDump(d) {
    if (d.busy || !d.queue.length) return;
    const id = d.queue.shift();
    const t = this.truck(id);
    if (!t) return;
    const wait = Math.max(0, this.time - (t.queueEnterAt || this.time));
    t.queueWait += wait;
    t.tripQueue += wait;
    const n = this.nodes[d.node];
    d.busy = id;
    d.timer = d.dumpTime;
    d.state = 'dumping';
    t.state = 'dumping';
    t.v = 0;
    t.path = null;
    t.progress = 0;
    this.parkTo(t, d.bay.x, n.y, d.bay.z, d.bay.heading);
    this.refreshDumpQueue(d);
  }

  finishDump(d) {
    const t = this.truck(d.busy);
    if (!t) { d.busy = null; return; }
    const tonnes = t.payload;
    t.payload = 0;
    t.trips++;
    this.trips++;
    this.totalTonnes += tonnes;
    if (t.loadType === 'ore') this.oreTonnes += tonnes;
    else this.wasteTonnes += tonnes;
    this.prodEvents.push({ t: this.time, tonnes });
    this.queueWaitSum += t.tripQueue;
    t.tripQueue = 0;
    t.queueWait = 0;
    t.queueEnterAt = this.time;
    d.busy = null;
    d.state = 'idle';
    this.log('dump', `${t.id} 在${d.name}完成卸车 ${tonnes}t，累计 ${t.trips} 趟`, 'info');
    if (d.queue.length) this.startDump(d);
    t.state = 'idle';
    this.dispatchTruck(t);
  }

  refreshDumpQueue(d) {
    const slots = d.queueSlots;
    d.queue.forEach((id, i) => {
      const t = this.truck(id);
      if (!t) return;
      const slot = this.slotAt(slots, i);
      if (!slot) return;
      this.parkTo(t, slot.x, d.y, slot.z, slot.heading);
      t.v = 0;
      t.path = null;
    });
  }

  applyQueueOffset(t, back) {
    if (!t.path) return;
    const d = Math.max(0, t.path.length - back);
    const p = this.samplePath(t.path, d);
    if (!p) return;
    t.x = p.x; t.y = p.y; t.z = p.z; t.heading = p.heading;
    t.progress = d;
    const pts = t.path.pts;
    let s = 0;
    while (s < pts.length - 2 && d > pts[s + 1].cum) s++;
    t.seg = s;
  }

  // ---------- 能源站 ----------
  updateStations(dt) {
    for (const st of this.stations) {
      // 电池包充电
      let charging = 0;
      for (const p of st.packs) {
        if (p.state === 'charging') {
          charging++;
          const kwh = (st.chargerKw * dt) / 3600;
          p.soc = clamp(p.soc + kwh / st.packKwh, 0, 1);
          st.energyDelivered += kwh;
          this.energyGrid += kwh;
          if (p.soc >= 0.97) { p.soc = 1; p.state = 'ready'; }
        }
      }
      // 旧包排队上充电位
      let free = st.chargers - charging;
      for (const p of st.packs) {
        if (free <= 0) break;
        if (p.state === 'waiting') { p.state = 'charging'; free--; charging++; }
      }

      // 换电工位
      if (st.bay) {
        st.bay.timer -= dt;
        if (st.bay.timer <= 0) this.finishSwap(st);
      }
      // 直充工位
      for (let i = 0; i < st.stalls.length; i++) {
        const rec = st.stalls[i];
        if (!rec) continue;
        rec.timer -= dt;
        const kwh = (st.directKw * dt) / 3600;
        st.energyDelivered += kwh;
        this.energyGrid += kwh;
        if (rec.timer <= 0) this.finishDirectCharge(st, i);
      }
      this.serveStation(st);
    }
  }

  serveStation(st) {
    if (!st.queue.length) return;
    const readyCount = st.packs.filter((p) => p.state === 'ready' && p.soc >= 0.78).length;
    const recordWait = (t) => {
      const wait = Math.max(0, this.time - (t.queueEnterAt || this.time));
      t.queueWait += wait;
      st.waitSum += wait;
      st.waitCount++;
      t.queueEnterAt = this.time;
    };
    // 换电优先：工位空闲且有满电电池包
    if (!st.bay && readyCount > 0) {
      const head = this.truck(st.queue[0]);
      if (head && head.state === 'queue_energy') {
        const pack = st.packs.find((p) => p.state === 'ready' && p.soc >= 0.78);
        if (pack) {
          st.queue.shift();
          pack.state = 'swap';
          st.bay = { truck: head.id, timer: st.swapTime, pack };
          head.state = 'swapping';
          head.v = 0;
          head.path = null;
          this.parkTo(head, st.bayPos.x, 0, st.bayPos.z, st.bayPos.heading);
          recordWait(head);
          this.log('energy', `${head.id} 进入 ${st.id} 换电工位，使用电池包 ${pack.id}（${Math.round(pack.soc * 100)}%），预计 ${round1(st.swapTime / 60)}min`, 'ok');
          this.refreshStationQueue(st);
        }
      }
    }
    // 没有满电电池包时，空余直充位给排队车辆补电
    if (st.queue.length && readyCount === 0) {
      const stall = st.stalls.findIndex((x) => !x);
      if (stall >= 0) {
        const head = this.truck(st.queue[0]);
        if (head && head.state === 'queue_energy') {
          st.queue.shift();
          const need = Math.max(0, st.directTarget - head.soc);
          const dur = Math.max(180, (need * st.packKwh * 3600) / st.directKw);
          st.stalls[stall] = { truck: head.id, timer: dur };
          head.state = 'charging';
          head.v = 0;
          head.path = null;
          this.parkTo(head, st.stallPos[stall].x, 0, st.stallPos[stall].z, st.stallPos[stall].heading);
          recordWait(head);
          this.log('energy', `${head.id} 在 ${st.id} 直充至 ${Math.round(st.directTarget * 100)}%，预计 ${round1(dur / 60)}min`, 'info');
          this.refreshStationQueue(st);
        }
      }
    }
  }

  finishSwap(st) {
    const rec = st.bay;
    if (!rec) return;
    const t = this.truck(rec.truck);
    const pack = rec.pack;
    if (t) {
      const old = t.soc;
      t.soc = pack.soc;
      pack.soc = old;
      pack.state = 'waiting';
      t.state = 'idle';
      t.v = 0;
      t.queueEnterAt = this.time;
      st.served++;
      this.swaps++;
      this.log('energy', `${t.id} 换电完成：${Math.round(old * 100)}% → ${Math.round(t.soc * 100)}%，旧包转入充电位`, 'ok');
      this.routeAfterEnergy(t);
    } else {
      pack.state = 'waiting';
    }
    st.bay = null;
    this.refreshStationQueue(st);
  }

  finishDirectCharge(st, idx) {
    const rec = st.stalls[idx];
    if (!rec) return;
    const t = this.truck(rec.truck);
    st.stalls[idx] = null;
    if (t) {
      t.soc = st.directTarget;
      t.state = 'idle';
      t.v = 0;
      t.queueEnterAt = this.time;
      st.served++;
      this.log('energy', `${t.id} 补电完成，Soc ${Math.round(t.soc * 100)}%`, 'ok');
      this.routeAfterEnergy(t);
    }
  }

  refreshStationQueue(st) {
    const slots = st.queueSlots;
    st.queue.forEach((id, i) => {
      const t = this.truck(id);
      if (!t) return;
      const slot = this.slotAt(slots, i);
      if (!slot) return;
      this.parkTo(t, slot.x, 0, slot.z, slot.heading);
      t.v = 0;
    });
  }

  // ---------- 指标 ----------
  pruneProduction() {
    const cut = this.time - 1800;
    while (this.prodEvents.length && this.prodEvents[0].t < cut) this.prodEvents.shift();
  }

  productionRate() {
    const win = Math.min(600, Math.max(30, this.elapsed || 30));
    const from = this.time - win;
    let tonnes = 0;
    for (const e of this.prodEvents) if (e.t >= from) tonnes += e.tonnes;
    return (tonnes / win) * 3600;
  }

  avgCycleMin() {
    const active = this.trucks.filter((t) => t.lastCycle > 0);
    if (!active.length) return 0;
    return active.reduce((a, t) => a + t.lastCycle, 0) / active.length / 60;
  }

  matchFactor() {
    const active = this.activeShovels();
    const cyc = this.avgCycleMin() * 60;
    if (!active.length || !cyc) return 0;
    let sum = 0;
    for (const s of active) {
      const n = this.trucks.filter((t) => t.targetId === s.id).length;
      sum += n * (this.shovels[0].loadDuration / cyc);
    }
    return sum / active.length;
  }

  snapshot() {
    const tcfg = this.cfg.truck;
    const activeShovels = this.activeShovels().length;
    const utilization = this.elapsed > 0
      ? this.trucks.reduce((a, t) => a + t.movingTime, 0) / (this.elapsed * this.trucks.length) * 100
      : 0;

    const trucks = this.trucks.map((t) => ({
      id: t.id,
      x: round1(t.x),
      y: round1(t.y),
      z: round1(t.z),
      heading: round1(t.heading * 100) / 100,
      v: round1(t.v),
      state: t.state,
      stateLabel: STATE_LABEL[t.state] || t.state,
      payload: t.payload,
      payloadPct: t.payload / tcfg.payload,
      soc: Math.round(t.soc * 1000) / 1000,
      targetId: t.targetId,
      targetName: t.targetName,
      loadType: t.loadType,
      pathPts: t.path ? t.path.pts.map((p) => [round1(p.x), round1(p.y), round1(p.z)]) : null,
      seg: t.seg || 0,
      lane: t.lane || 0,
      manual: !!t.manual,
      queueWait: round1(t.queueWait),
      cycle: round1(t.lastCycle / 60),
      trips: t.trips,
      energy: round1(t.energy),
      alert: t.alert,
    }));

    const shovels = this.shovels.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      level: s.level,
      state: s.state,
      stateLabel: s.state === 'loading' ? '装载中' : s.state === 'idle' ? '等车' : s.state,
      queue: s.queue.length,
      busyTruck: s.busyTruck,
      extracted: Math.round(s.extracted),
      cut: s.cut,
      advance: s.advance,
      rate: s.state === 'loading' ? tcfg.loadRate : 0,
      x: round1(s.x),
      y: round1(s.y),
      z: round1(s.z),
      spot: s.pad.spot,
      angle: s.pad.angle,
      cutDir: s.pad.cutDir,
    }));

    const stations = this.stations.map((st) => {
      const ready = st.packs.filter((p) => p.state === 'ready' && p.soc >= 0.78).length;
      return {
        id: st.id,
        name: st.name,
        queue: st.queue.length,
        bay: st.bay ? { truck: st.bay.truck, remaining: round1(st.bay.timer), mode: 'swap' } : null,
        stalls: st.stalls.map((x) => (x ? { truck: x.truck, remaining: round1(x.timer) } : null)),
        packs: st.packs.map((p) => ({ id: p.id, soc: Math.round(p.soc * 100), state: p.state })),
        ready,
        served: st.served,
        avgWait: st.waitCount ? round1(st.waitSum / st.waitCount / 60) : 0,
        energy: Math.round(st.energyDelivered),
        swapTime: st.swapTime,
        chargers: st.chargers,
        chargerKw: st.chargerKw,
        packKwh: st.packKwh,
      };
    });

    const alerts = [];
    for (const t of this.trucks) {
      if (t.soc < tcfg.socCritical) {
        alerts.push({ level: 'critical', text: `${t.id} 电量 ${Math.round(t.soc * 100)}%，低于安全阈值` });
      } else if (['queue_shovel', 'queue_dump', 'queue_energy'].includes(t.state)) {
        const waited = this.time - (t.queueEnterAt || this.time);
        if (waited > 900) alerts.push({ level: 'warn', text: `${t.id} 当前排队 ${round1(waited / 60)}min，超过 15min` });
      }
    }
    for (const st of this.stations) if (st.queue.length >= 3) alerts.push({ level: 'warn', text: `${st.name} 排队 ${st.queue.length} 台，换电能力趋紧` });
    for (const s of this.shovels) if (s.queue.length >= 4) alerts.push({ level: 'warn', text: `${s.id} 装车排队 ${s.queue.length} 台，匹配系数偏高` });
    for (const d of this.dumps) if (d.queue.length >= 3) alerts.push({ level: 'warn', text: `${d.name}卸车排队 ${d.queue.length} 台` });

    // ---------- 系统健康度评估（产能 / 排队 / 设备利用率 / 补能 / 告警）----------
    const targetHourly = this.shiftTarget / 12;
    const prodScore = clamp(this.productionRate() / targetHourly * 100, 0, 100);
    const activeTrucks = this.trucks.filter((t) => !['idle', 'stranded'].includes(t.state)).length;
    const truckUtil = utilization;
    const shovelBusy = this.shovels.reduce((a, s) => a + (s.busyTruck ? 1 : 0), 0);
    const shovelUtil = this.shovels.length ? (shovelBusy / this.shovels.length) * 100 : 0;
    const energyBusy = this.stations.reduce((a, st) => a + (st.bay ? 1 : 0) + st.stalls.filter(Boolean).length, 0);
    const energySlots = this.stations.reduce((a, st) => a + 1 + st.stalls.length, 0);
    const energyUtil = energySlots ? (energyBusy / energySlots) * 100 : 0;
    const avgQueueNow = this.trips ? round1(this.queueWaitSum / this.trips / 60) : round1(this.trucks.reduce((a, t) => a + t.queueWait, 0) / this.trucks.length / 60);
    const queuePenalty = Math.min(60, avgQueueNow * 6);
    const alertPenalty = Math.min(40, alerts.length * 8);
    const queueScore = clamp(100 - queuePenalty, 0, 100);
    const alertScore = clamp(100 - alertPenalty, 0, 100);
    const healthScore = Math.round(
      prodScore * 0.28 + truckUtil * 0.22 + shovelUtil * 0.18 +
      energyUtil * 0.12 + queueScore * 0.12 + alertScore * 0.08
    );
    const health = {
      score: healthScore,
      grade: healthScore >= 85 ? '优' : healthScore >= 70 ? '良' : healthScore >= 55 ? '中' : healthScore >= 40 ? '差' : '危急',
      dims: {
        production: Math.round(prodScore),
        truck: Math.round(truckUtil),
        shovel: Math.round(shovelUtil),
        energy: Math.round(energyUtil),
        queue: Math.round(queueScore),
        alert: Math.round(alertScore),
      },
      activeTrucks,
    };

    return {
      clock: this.clock(),
      time: this.time,
      elapsed: this.elapsed,
      speed: this.speed,
      paused: this.paused,
      weather: this.weather,
      mode: this.mode,
      shiftProgress: clamp(this.elapsed / this.cfg.site.shiftSeconds, 0, 1),
      kpis: {
        productionRate: Math.round(this.productionRate()),
        shiftTarget: this.shiftTarget,
        totalTonnes: Math.round(this.totalTonnes),
        oreTonnes: Math.round(this.oreTonnes),
        wasteTonnes: Math.round(this.wasteTonnes),
        matchFactor: Math.round(this.matchFactor() * 100) / 100,
        avgCycle: round1(this.avgCycleMin()),
        avgQueue: this.trips ? round1(this.queueWaitSum / this.trips / 60) : round1(this.trucks.reduce((a, t) => a + t.queueWait, 0) / this.trucks.length / 60),
        utilization: Math.round(utilization),
        energyPerTonne: this.totalTonnes ? Math.round((this.energyTruck / this.totalTonnes) * 100) / 100 : 0,
        swaps: this.swaps,
        trips: this.trips,
        activeTrucks: this.trucks.filter((t) => ['to_shovel', 'to_dump', 'to_energy', 'queue_shovel', 'queue_dump', 'queue_energy', 'loading', 'dumping', 'swapping', 'charging'].includes(t.state)).length,
        activeShovels,
      },
      trucks,
      shovels,
      stations,
      dumps: this.dumps.map((d) => ({
        id: d.id, name: d.name, type: d.type, x: round1(d.x), z: round1(d.z),
        queue: d.queue.length, busy: d.busy, state: d.state,
      })),
      faces: this.shovels.map((s) => ({ id: s.id, extracted: Math.round(s.extracted), cut: s.cut, advance: s.advance })),
      alerts: alerts.slice(0, 6),
      health,
    };
  }

  drainLogs() {
    const out = this.pendingLogs.slice();
    this.pendingLogs.length = 0;
    return out;
  }

  setSpeed(v) { this.speed = clamp(v, 0.5, 32); }
  setPaused(v) { this.paused = !!v; }
  setWeather(w) {
    const names = { clear: '晴', dust: '扬尘', rain: '降雨', snow: '降雪', wind: '大风', sandstorm: '风沙' };
    this.weather = w;
    this.log('system', `天气工况切换为${names[w] || w}，道路限速与能耗系数已更新`, 'info');
  }
  setMode(m) { this.mode = m; this.log('system', `调度策略切换：${m === 'production' ? '产量优先' : m === 'energy' ? '能耗优先' : '均衡'}`, 'info'); }
  setSocReserve(v) { this.cfg.truck.socSwap = clamp(v, 0.18, 0.5); }

  manualAssign(truckId, targetId) {
    const t = this.truck(truckId);
    if (!t) return false;
    if (['loading', 'dumping', 'swapping', 'charging'].includes(t.state)) {
      this.log('alert', `${truckId} 正在作业，拒绝改派`, 'warn');
      return false;
    }
    // 清理排队引用
    for (const s of this.shovels) s.queue = s.queue.filter((id) => id !== truckId);
    for (const d of this.dumps) d.queue = d.queue.filter((id) => id !== truckId);
    for (const st of this.stations) st.queue = st.queue.filter((id) => id !== truckId);
    for (const s of this.shovels) this.refreshShovelQueue(s);
    for (const s of this.stations) this.refreshStationQueue(s);
    const node = this.nearestNode(t.x, t.z);
    t.lastNode = node;
    t.path = null;
    t.progress = 0;
    t.v = 0;
    t.x = this.nodes[node].x; t.y = this.nodes[node].y; t.z = this.nodes[node].z;
    const shovel = this.shovels.find((s) => s.id === targetId);
    if (shovel) {
      t.targetId = shovel.id;
      t.targetKind = 'shovel';
      t.targetName = shovel.name;
      t.state = 'to_shovel';
      this.startRoute(t, shovel.node);
      this.log('dispatch', `人工指令：${truckId} → ${shovel.id}`, 'warn');
      return true;
    }
    const st = this.stations.find((s) => s.id === targetId);
    if (st) {
      t.targetId = st.id;
      t.targetKind = 'station';
      t.targetName = st.name;
      t.state = 'to_energy';
      this.startRoute(t, st.node);
      this.log('dispatch', `人工指令：${truckId} → ${st.name} 换电`, 'warn');
      return true;
    }
    const dump = this.dumpMap.get(targetId) || null;
    if (dump) {
      t.targetId = dump.id;
      t.targetKind = 'dump';
      t.targetName = dump.name;
      t.state = 'to_dump';
      this.startRoute(t, dump.node);
      this.log('dispatch', `人工指令：${truckId} → ${dump.name}`, 'warn');
      return true;
    }
    this.log('alert', `未知调度目标 ${targetId}`, 'warn');
    return false;
  }
}
