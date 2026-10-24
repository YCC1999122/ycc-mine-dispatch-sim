// 北岭露天矿 · 静态世界模型
// 拉长型不规则采坑：环形运输道 + 东端折返坡道 + 三处工作面（含装车泊位与排队车位）
// 所有几何数据均可结构化克隆，供 Worker 仿真与 Three.js 渲染共用

export const CONFIG = {
  site: {
    name: 'YCC 模拟矿山',
    code: 'YCC-SIM',
    shiftStart: 6 * 3600,
    shiftSeconds: 12 * 3600,
    weather: 'clear',
  },
  pit: {
    a: 1500,               // 长轴半轴 m
    b: 780,                // 短轴半轴 m
    n: 3.2,                // 超椭圆指数（越大越接近矩形，形成拉长型采坑）
    benchH: 15,
    benchW: 108,           // 台段宽度需容纳双向运输道（路面净宽 + 两侧安全距离）
    levels: 5,
    floorY: -75,
    outerR: 1400,
  },
  truck: {
    count: 40,
    payload: 100,          // 额定载重 t
    emptyWeight: 68,       // 自重 t
    batteryKwh: 240,       // 可换电池包容量
    socSwap: 0.32,         // 低于该电量返回能源站
    socCritical: 0.16,
    socTarget: 0.86,
    consLoaded: 4.4,       // kWh/km（重载）
    consEmpty: 1.6,        // kWh/km（空载）
    auxKw: 6.0,            // 附件功耗 kW
    vLoaded: 11,           // m/s 约 40km/h
    vEmpty: 14,
    accel: 0.85,
    decel: 1.7,
    minGap: 75,
    loadRate: 2600,        // 电铲小时能力 t/h
    dumpTime: 55,          // 破碎站卸车 s
    wasteDumpTime: 42,
  },
  dispatch: {
    tick: 2.0,             // 调度周期 s
    maxQueue: 4,
    mode: 'balanced',      // balanced | production | energy
  },
};

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// 有符号最小角度差，返回 (-π, π]
const angDiff = (a, b) => {
  let d = (a - b + Math.PI) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d - Math.PI;
};
const PERT = [[2, 0.022, -0.35], [3, 0.035, 0.55], [5, 0.024, -1.15], [7, 0.015, 2.1]];

// 坑口轮廓（超椭圆 + 角向扰动，避免同心圆）
export function rimRadius(theta, pit = CONFIG.pit) {
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  const q = Math.pow(c / pit.a, pit.n) + Math.pow(s / pit.b, pit.n);
  let j = 0;
  for (const [k, amp, ph] of PERT) j += amp * Math.sin(k * theta + ph);
  return Math.pow(q, -1 / pit.n) * (1 + j);
}

export function levelRadius(theta, level, pit = CONFIG.pit) {
  return Math.max(10, rimRadius(theta, pit) - level * benchWidthAt(theta, pit));
}

// 台段宽度随方位变化：工作面侧宽、背帮侧窄，台阶线因此不平行，形成真实的不规则扩帮
// 下限必须大于双向运输道总宽（约 48m）+ 两侧安全距离，否则路面会压到台段坡面
export function benchWidthAt(theta, pit = CONFIG.pit) {
  const j =
    16 * Math.sin(theta + 0.55) +
    8 * Math.sin(3 * theta - 1.05) +
    5 * Math.sin(5 * theta + 2.2);
  return clamp(pit.benchW - j, 92, 124);
}

// 台段运输道中心半径：落在台面（外缘向内 0.8w 的平坦区）中线上，
// 保证路面完全贴合台面，不会压到外侧上帮或内侧坡面
export function benchRoadRadius(theta, level, pit = CONFIG.pit) {
  return levelRadius(theta, level, pit) - 0.4 * benchWidthAt(theta, pit);
}

// 台段表面高程（与渲染地形严格一致）
export function heightAt(x, z, pit = CONFIG.pit) {
  const th = Math.atan2(z, x);
  const r = Math.hypot(x, z);
  const rim = rimRadius(th, pit);
  const d = rim - r;
  let h;
  if (d > 0) {
    const t = d / benchWidthAt(th, pit);
    if (t >= pit.levels) {
      h = -pit.levels * pit.benchH;
    } else {
      const i = Math.floor(t);
      const f = t - i;
      h = -i * pit.benchH - smoothstep(0.8, 1.0, f) * pit.benchH;
    }
  } else {
    h = 0.7 + 1.7 * smoothstep(0, 170, -d) + Math.sin(x * 0.012) * Math.cos(z * 0.01) * 1.2;
  }
  return h;
}

function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function buildWorld() {
  const nodes = [];
  const edges = [];
  const roads = [];
  const edgeKeys = new Set();
  const pit = CONFIG.pit;
  let seq = 0;

  const addNode = (x, y, z, kind = 'road', level = null) => {
    const idx = nodes.length;
    nodes.push({ id: `n${seq++}`, idx, x, y, z, kind, level });
    return idx;
  };

  // dir: 0=双向、1=仅 a→b、-1=仅 b→a。
  // 坡道这类单车道走廊必须单向，否则对向车流会在 48m 窄路上迎头相遇互相卡死
  const link = (a, b, kind = 'road', width = 20, speed = 10, dir = 0) => {
    if (a === b) return;
    const A = nodes[a], B = nodes[b];
    const len = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    if (len < 0.01) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ a, b, len, dy: B.y - A.y, kind, width, speed, dir });
  };

  // 折线道路：自动按 32m 加密节点，保证车辆沿折线连续行驶
  const chain = (startIdx, pts, kind, width, speed, level = null) => {
    let prev = startIdx;
    const list = [startIdx];
    for (const p of pts) {
      const target = addNode(p.x, p.y == null ? 0 : p.y, p.z, p.kind || kind, level);
      const A = nodes[prev], B = nodes[target];
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      const steps = Math.max(1, Math.round(len / 32));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const mid = addNode(
          A.x + (B.x - A.x) * t,
          A.y + (B.y - A.y) * t,
          A.z + (B.z - A.z) * t,
          p.kind || kind,
          level
        );
        link(prev, mid, kind, width, speed);
        list.push(mid);
        prev = mid;
      }
      link(prev, target, kind, width, speed);
      list.push(target);
      prev = target;
    }
    roads.push({ id: `rd-${roads.length}`, kind, width, pts: list.slice() });
    return { list, end: prev };
  };

  // ---------- 1. 地表环形运输道（沿坑口外 130m 环绕，避让台段道路外缘） ----------
  const RING_OFFSET = 130;
  const ringPts = [];
  const RING_SEGS = 108;
  for (let i = 0; i < RING_SEGS; i++) {
    const th = (i / RING_SEGS) * Math.PI * 2;
    const r = rimRadius(th, pit) + RING_OFFSET;
    ringPts.push(addNode(Math.cos(th) * r, 0, Math.sin(th) * r, 'surface'));
  }
  for (let i = 0; i < RING_SEGS; i++) {
    link(ringPts[i], ringPts[(i + 1) % RING_SEGS], 'surface', 90, 13);
  }
  roads.push({ id: 'ring-road', kind: 'surface', width: 90, pts: ringPts.concat([ringPts[0]]) });
  const ringNodeNear = (th) => {
    const i = Math.round(((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * RING_SEGS) % RING_SEGS;
    return ringPts[i];
  };

  // ---------- 2. 折返坡道（东、西双入口；每层一段，±14° 往复下降；层间半圆回车场掉头） ----------
  // 两条坡道分列采坑东西两端，各自贯穿全部台段直至坑底，
  // 与台段南北两条环线拼成完整回环：重载可东下西上，空车可西下东上
  const RAMP_HALF = 14 * D2R;
  // 回车场参数：半径 33m（大于路面半幅 26.5m，保证路面带在弯内不自交），
  // 前后各留直线缓和段，车辆有充足转向空间，不再出现 V 形尖角折返
  const TURN_R = 33;
  const TURN_IN = 30;
  const TURN_OUT = 25;
  // 半圆掉头把运输走廊向坑心递送 TURN_D（直径）米，该横移由回车场永久承担：
  // 各层坡道起点半径整体内移 TURN_D，坡道自身只承担剩余的台段横移。
  // 否则出口段要斜切回主体走廊，正好从上一层坡道末段正下方穿过
  // （水平间距不足 48m 路宽、垂直仅 0~2m），俯视上两层路面相互重叠
  const TURN_D = 2 * TURN_R;

  // 单向坡道：东坡道只下行（空车下坑），西坡道只上行（重载出坑）。
  // 这样两条 48m 窄路各自只有单方向车流，从拓扑上根除迎头相遇。
  // dir 以节点生成顺序为准（生成顺序自上而下）：东=1 下行，西=-1 上行
  const rampDefs = [
    { id: 'east', base: 0, roadId: 'ramp-east', dir: 1 },
    { id: 'west', base: Math.PI, roadId: 'ramp-west', dir: -1 },
  ];

  const buildRamp = (def) => {
  const rampPts = [];
  const rampStart = [];
  const rampEnd = [];
  for (let i = 0; i < pit.levels; i++) {
    const sgn = i % 2 === 0 ? 1 : -1;
    const th0 = def.base + sgn * RAMP_HALF;
    const th1 = def.base - sgn * RAMP_HALF;
    const steps = 9;
    const first = i === 0;
    rampStart[i] = first ? rampPts.length : rampPts.length - 1;
    for (let s = first ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const th = th0 + (th1 - th0) * t;
      // 起点走廊内移 TURN_D（由上一层回车场递送），首层从地表环道进入不内移
      const r0 = benchRoadRadius(th, i, pit) - (i === 0 ? 0 : TURN_D);
      const r1 = benchRoadRadius(th, i + 1, pit);
      const r = r0 + (r1 - r0) * t;
      const y = -i * pit.benchH - pit.benchH * t;
      const idx = addNode(Math.cos(th) * r, y, Math.sin(th) * r, 'ramp', i);
      if (s > 0) link(rampPts[rampPts.length - 1], idx, 'ramp', 48, 9, def.dir);
      rampPts.push(idx);
    }
    rampEnd[i] = rampPts.length - 1;

    // 层间回车场：把原来的 V 形尖角折返替换为凸向坑心的半圆掉头弯。
    // 尖角折返会让渲染路面带在拐点处自叠、上下两层坡道在俯视上重叠，
    // 车辆也没有转向空间，只能在原地瞬时折向
    if (i < pit.levels - 1) {
      const E = nodes[rampPts[rampPts.length - 1]];
      const Ep = nodes[rampPts[rampPts.length - 2]];
      let ux = E.x - Ep.x;
      let uz = E.z - Ep.z;
      const ul = Math.hypot(ux, uz) || 1;
      ux /= ul; uz /= ul;
      // 法向取朝坑心一侧（回车场建在下一层台面上，凸出部分由地形断面自动填方托底）
      let nx = -uz;
      let nz = ux;
      const rl = Math.hypot(E.x, E.z) || 1;
      if (nx * (-E.x / rl) + nz * (-E.z / rl) < 0) { nx = -nx; nz = -nz; }
      const yTurn = -(i + 1) * pit.benchH;
      let prev = rampPts[rampPts.length - 1];
      // 进入直线缓和段（台面高度，水平）
      const A0 = { x: E.x + ux * TURN_IN, z: E.z + uz * TURN_IN };
      let idx = addNode(A0.x, yTurn, A0.z, 'ramp', i + 1);
      link(prev, idx, 'ramp', 48, 6, def.dir);
      rampPts.push(idx);
      prev = idx;
      // 半圆掉头：圆心 O = A0 + n·R，从 A0 扫 180°，车头由 u 平滑转回 -u
      const O = { x: A0.x + nx * TURN_R, z: A0.z + nz * TURN_R };
      const phi0 = Math.atan2(A0.z - O.z, A0.x - O.x);
      // 进入切向必须与 u 一致，据此选择扫描方向
      const cw = (nz * ux - nx * uz) > 0 ? 1 : -1;
      const ARC = 10;
      for (let k = 1; k <= ARC; k++) {
        const ph = phi0 + cw * Math.PI * (k / ARC);
        idx = addNode(O.x + TURN_R * Math.cos(ph), yTurn, O.z + TURN_R * Math.sin(ph), 'ramp', i + 1);
        link(prev, idx, 'ramp', 48, 6, def.dir);
        rampPts.push(idx);
        prev = idx;
      }
      // 驶出直线段（沿 -u 方向，接下一层坡道首段）
      idx = addNode(A0.x + nx * 2 * TURN_R - ux * TURN_OUT, yTurn, A0.z + nz * 2 * TURN_R - uz * TURN_OUT, 'ramp', i + 1);
      link(prev, idx, 'ramp', 48, 6, def.dir);
      rampPts.push(idx);
    }
  }
    roads.push({ id: def.roadId, kind: 'ramp', width: 48, pts: rampPts.slice() });

    // 坡道口与地表环道衔接（切开坑口边坡；东西两端各一处入口）
    const portal = rampPts[rampStart[0]];
    const thPortal = def.base + RAMP_HALF;
    {
      const r1 = rimRadius(thPortal, pit) + 24;
      const mid = addNode(Math.cos(thPortal) * r1, 0, Math.sin(thPortal) * r1, 'ramp');
      // 坡道口：东坡道只能进坑（环道→口），西坡道只能出坑（口→环道）
      link(portal, mid, 'ramp', 48, 9, -def.dir);
      link(mid, ringNodeNear(thPortal), 'surface', 90, 12);
      roads.push({ id: `portal-${def.id}`, kind: 'ramp', width: 48, pts: [portal, mid, ringNodeNear(thPortal)] });
    }

    // 每层坡道落点（最末再加一条坑底落点，供坑底环形道接入）
    const landings = [];
    for (let L = 0; L < pit.levels; L++) landings[L] = L === 0 ? rampPts[rampStart[0]] : rampPts[rampEnd[L - 1]];
    landings[pit.levels] = rampPts[rampEnd[pit.levels - 1]];
    return { id: def.id, base: def.base, pts: rampPts, start: rampStart, end: rampEnd, landings, portal };
  };

  const ramps = rampDefs.map(buildRamp);
  const rampById = {};
  for (const r of ramps) rampById[r.id] = r;

  // ---------- 3. 台段环形运输道（南北双弧） ----------
  // 每个台段（含坑底）绕坑分成北弧、南弧两段，东西两端各留一个缺口：
  // 坡道与回车场由上向下切穿台面，任何横跨该处的路面都会悬空。
  // 两条弧分别接入本层东西坡道落点，使两条坡道各自服务一条弧，
  // 整个路网由此形成「东坡道 → 一环 → 西坡道」的大回环
  const RING_GAP = 24 * D2R;
  const ARC_DEFS = [
    { id: 'north', a0: RING_GAP, a1: Math.PI - RING_GAP },
    { id: 'south', a0: Math.PI + RING_GAP, a1: Math.PI * 2 - RING_GAP },
  ];
  const benchRings = [];
  for (let L = 0; L <= pit.levels; L++) {
    const y = -L * pit.benchH;
    const arcs = ARC_DEFS.map((def) => {
      const pts = [];
      let a = def.a0;
      let guard = 0;
      while (a <= def.a1 + 1e-6 && guard++ < 400) {
        const r = benchRoadRadius(a, L, pit);
        pts.push(addNode(Math.cos(a) * r, y, Math.sin(a) * r, 'bench', L));
        a += Math.max((2 * Math.PI) / 400, 34 / Math.max(120, r));
      }
      for (let i = 0; i < pts.length - 1; i++) link(pts[i], pts[i + 1], 'bench', 48, 8);
      return { id: def.id, pts, head: pts[0], tail: pts[pts.length - 1] };
    });

    // 每条弧的两端都接入就近的坡道落点。
    // 台段路网本来就是「两条弧 + 两个落点」组成的闭环：若每条弧只接一个落点，
    // 另一端就是断头路，单向坡道会把整个坑内路网劈成互不相通的两半。
    // 接上两端后，车辆可以在本层直接绕到上行坡道，不必跑整圈。
    const angOf = (idx) => Math.atan2(nodes[idx].z, nodes[idx].x);
    const eastLand = rampById.east.landings[L];
    const westLand = rampById.west.landings[L];
    const nearestLand = (nodeIdx) => {
      const th = angOf(nodeIdx);
      return Math.abs(angDiff(th, angOf(eastLand))) <= Math.abs(angDiff(th, angOf(westLand)))
        ? eastLand : westLand;
    };
    arcs.forEach((arc) => {
      const used = new Set();
      for (const [endIdx, name] of [[arc.head, 'head'], [arc.tail, 'tail']]) {
        let land = nearestLand(endIdx);
        if (used.has(land)) land = land === eastLand ? westLand : eastLand;
        used.add(land);
        link(endIdx, land, 'bench', 48, 8);
        roads.push({
          id: `bench-link-${L}-${arc.id}-${name}`,
          kind: 'bench', width: 48, pts: [endIdx, land], level: L,
        });
      }
      roads.push({ id: `bench-arc-${L}-${arc.id}`, kind: 'bench', width: 48, pts: arc.pts, level: L });
    });

    benchRings[L] = { y, pts: arcs[0].pts.concat(arcs[1].pts), arcs };
  }

  // ---------- 4. 采掘工作面（含装车泊位 + 排队车位） ----------
  // 工作面挂在本层环形道上，取环线上角度最近的节点作为接入点。
  // 布局遵循「上堆土、下挖矿」：矿石工作面全部布置在采坑南侧（z<0）的中深部台段，
  // 废岩剥离面布置在北侧（z>0）的浅部台段，与南北两条环线的分工一致
  const faceDefs = [
    { id: 'EX-01', ore: true, level: 4, angle: 258 },
    { id: 'EX-02', ore: true, level: 4, angle: 296 },
    { id: 'EX-03', ore: true, level: 3, angle: 244 },
    { id: 'EX-04', ore: true, level: 3, angle: 322 },
    { id: 'EX-05', ore: false, level: 1, angle: 70 },
    { id: 'EX-06', ore: false, level: 2, angle: 118 },
  ];

  const faces = faceDefs.map((def) => {
    const level = Math.min(def.level, pit.levels - 1);
    const y = -level * pit.benchH;
    const th = def.angle * D2R;
    const ring = benchRings[level];

    const benchR = (t) => benchRoadRadius(t, level, pit);
    const anchorR = benchR(th);
    const ax = Math.cos(th) * anchorR;
    const az = Math.sin(th) * anchorR;
    const radial = { x: Math.cos(th), z: Math.sin(th) };
    const dir = 1;
    // radial：径向偏移（+ 为向坑帮外侧）。停车泊位必须让出运输道，
    // 否则整排排队车辆会骑在 48m 台段路中央，把对向车流堵死
    const contour = (t, off, radial = 0) => {
      const a = t + dir * (off / Math.max(60, levelRadius(t, level, pit)));
      const r = benchR(a) + radial;
      return {
        x: Math.cos(a) * r,
        y,
        z: Math.sin(a) * r,
        heading: Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir),
        angle: a,
      };
    };

    // 接入点：环线上与工作面方位最接近的节点
    let hook = ring.pts[0];
    let bd = Infinity;
    for (const idx of ring.pts) {
      const n = nodes[idx];
      const d = Math.abs(angDiff(Math.atan2(n.z, n.x), th));
      if (d < bd) { bd = d; hook = idx; }
    }

    const bay = contour(th, 10);
    const bayNode = addNode(bay.x, y, bay.z, 'face', level);
    link(hook, bayNode, 'bench', 48, 7);

    // 排队车位沿台面外缘一侧摆放（径向 +26m），完全让出运输道；
    // 8 个泊位足够覆盖「1 台装车 + 7 台排队」，不会出现车辆叠在同一车位
    const queueSlots = [];
    for (let k = 1; k <= 8; k++) queueSlots.push(contour(th, 10 - 54 * k, 26));

    roads.push({ id: `face-${def.id}`, kind: 'bench', width: 48, pts: [hook, bayNode], faceId: def.id });
    nodes[bayNode].kind = 'face';
    nodes[bayNode].faceId = def.id;

    const shovelPos = { x: ax + radial.x * 12, y, z: az + radial.z * 12 };
    return {
      id: def.id,
      name: `${def.id} 电铲`,
      type: def.ore ? 'ore' : 'waste',
      ore: def.ore,
      level,
      y,
      angle: th,
      radius: anchorR,
      padNode: bayNode,
      spot: { x: bay.x, y, z: bay.z },
      bay: { ...bay, node: bayNode },
      queueDir: { x: -Math.sin(th) * dir, z: Math.cos(th) * dir },
      queueSlots,
      shovel: {
        ...shovelPos,
        heading: Math.atan2(bay.x - shovelPos.x, bay.z - shovelPos.z),
      },
      cutDir: radial,
      queue: 0,
      extracted: 0,
      cut: 0,
    };
  });

  // ---------- 5. 破碎站 / 排土场 ----------
  const crusherRoad = chain(ringNodeNear(Math.PI / 2), [{ x: 0, z: 1120 }, { x: 0, z: 1560 }], 'surface', 90, 12);
  const crusherNode = crusherRoad.end;
  nodes[crusherNode].kind = 'crusher';

  // 东破碎站：从环道东南角向外引出，分流 4 个矿石工作面的重载车流
  const c2from = ringNodeNear(300 * D2R);
  const c2src = nodes[c2from];
  const c2len = Math.hypot(c2src.x, c2src.z) || 1;
  const c2u = { x: c2src.x / c2len, z: c2src.z / c2len };
  const c2x = c2src.x + c2u.x * 420;
  const c2z = c2src.z + c2u.z * 420;
  const c2Road = chain(c2from, [{ x: c2src.x + c2u.x * 210, z: c2src.z + c2u.z * 210 }, { x: c2x, z: c2z }], 'surface', 84, 11);
  const c2Node = c2Road.end;
  nodes[c2Node].kind = 'crusher';

  const wasteRoad = chain(ringNodeNear(180 * D2R), [{ x: -1500, z: 140 }, { x: -1720, z: 210 }], 'surface', 84, 11);
  const wasteNode = wasteRoad.end;
  nodes[wasteNode].kind = 'dump';

  // 卸载点排队车位统一向行车道右侧让出 22m，避免排队车辆压住进出通道
  const sideSlot = (x, z, heading, off = 22) => ({
    x: x + Math.cos(heading) * off,
    z: z - Math.sin(heading) * off,
    heading,
  });

  const c2bay = { x: c2x - c2u.x * 74, z: c2z - c2u.z * 74, heading: Math.atan2(c2u.x, c2u.z) };
  const c2Slots = Array.from({ length: 5 }, (_, k) => {
    const p = sideSlot(c2bay.x - c2u.x * (k + 1) * 55, c2bay.z - c2u.z * (k + 1) * 55, c2bay.heading);
    return { x: p.x, y: 0, z: p.z, heading: c2bay.heading };
  });

  // ---------- 6. 能源站（换电 + 直流补电） ----------
  const stationDefs = [
    { id: 'ES-N', name: '北能源站', x: 520, z: 1350, yaw: 195 * D2R, ringAngle: 62 },
    { id: 'ES-W', name: '西能源站', x: -1220, z: 820, yaw: 80 * D2R, ringAngle: 128 },
    { id: 'ES-S', name: '南能源站', x: 210, z: -1220, yaw: 0, ringAngle: 268 },
    { id: 'ES-E', name: '东能源站', ringAngle: 40, out: 470 },
  ];

  const stations = stationDefs.map((def) => {
    const from = ringNodeNear(def.ringAngle * D2R);
    if (def.x == null) {
      // 东能源站：沿环道节点径向向外布置，站口朝向坑心
      const n = nodes[from];
      const rl = Math.hypot(n.x, n.z) || 1;
      def.x = n.x + (n.x / rl) * def.out;
      def.z = n.z + (n.z / rl) * def.out;
      def.yaw = Math.atan2(-n.x / rl, -n.z / rl);
    }
    const road = chain(from, [{ x: (def.x * 0.55 + nodes[from].x * 0.45), z: (def.z * 0.55 + nodes[from].z * 0.45) }, { x: def.x, z: def.z }], 'station', 78, 10);
    const node = road.end;
    nodes[node].kind = 'station';
    const c = Math.cos(def.yaw), s = Math.sin(def.yaw);
    const loc = (lx, lz) => ({ x: def.x + c * lx + s * lz, z: def.z - s * lx + c * lz });
    const heading = def.yaw + Math.PI;   // 车头朝换电工位（站内 -z 方向）
    const bay = loc(0, 0);
    const stalls = [loc(-24, 4), loc(24, 4)];
    // 站内排队车位横向让出 20m（局部 -x 一侧），把站前通道留给进出车辆
    const queue = [];
    for (let k = 1; k <= 5; k++) {
      const p = loc(-20, 55 * k + 30);
      queue.push({ x: p.x, y: 0, z: p.z, heading });
    }
    return {
      id: def.id,
      name: def.name,
      node,
      x: def.x,
      z: def.z,
      yaw: def.yaw,
      bayPos: { x: bay.x, z: bay.z, heading },
      stallPos: stalls.map((p) => ({ x: p.x, z: p.z, heading })),
      queueSlots: queue,
      swapBays: 1, chargeStalls: 2, packs: 4, chargers: 2,
      packKwh: CONFIG.truck.batteryKwh, chargerKw: 200,
      swapTime: 540, directKw: 240, directTarget: 0.8,
    };
  });

  // 站牌节点位置即道路终点，泊位与直充位在站台内侧
  const spawnPoints = [];
  for (let i = 0; i < CONFIG.truck.count; i++) {
    const idx = ringPts[Math.floor((i / CONFIG.truck.count) * RING_SEGS)];
    const n = nodes[idx];
    spawnPoints.push({ x: n.x, z: n.z, y: 0, node: idx });
  }

  // ---------- 7. 能源设施（远景装饰，不参与路网与仿真） ----------
  // 南侧燃煤火电厂 + 高压输电走廊送入矿区；东北光伏电站；西侧风电场
  const groundY = (x, z) => (Math.abs(x) <= 1980 && Math.abs(z) <= 1780 ? heightAt(x, z, pit) : -1.6);
  const facilities = [
    {
      id: 'thermal', kind: 'thermal', name: '南岭火电厂',
      x: 330, z: -2360, y: -1.6, yaw: 0.32, radius: 210,
    },
    {
      id: 'solar', kind: 'solar', name: '东北光伏电站',
      x: 1860, z: 1960, y: -1.6, yaw: -0.58, radius: 190,
    },
    {
      id: 'wind', kind: 'wind', name: '西岭风电场',
      x: -2520, z: 320, y: -1.6, yaw: 1.38, count: 6, spacing: 330, radius: 240,
    },
  ];
  const hvLine = {
    id: 'hv-line', name: '高压输电走廊',
    pts: [
      { x: 420, z: -2140 }, { x: 320, z: -1760 }, { x: 220, z: -1420 },
      { x: 140, z: -1120 }, { x: 60, z: -900 },
    ].map((p) => ({ x: p.x, z: p.z, y: groundY(p.x, p.z) })),
  };

  return {
    config: CONFIG,
    nodes,
    edges,
    roads,
    faces,
    stations,
    dumps: {
      list: [
        {
          id: 'crusher', name: '北破碎站', type: 'ore',
          node: crusherNode, x: 0, z: 1560, y: 0,
          bay: { x: 0, z: 1486, heading: 0 }, queueDir: { x: 0, z: -1 },
          queueSlots: Array.from({ length: 5 }, (_, k) => ({
            x: 22, y: 0, z: 1486 - (k + 1) * 55, heading: 0,
          })),
        },
        {
          id: 'crusher2', name: '东破碎站', type: 'ore',
          node: c2Node, x: c2x, z: c2z, y: 0,
          bay: c2bay, queueDir: { x: -c2u.x, z: -c2u.z }, queueSlots: c2Slots,
        },
        {
          id: 'waste', name: '西排土场', type: 'waste',
          node: wasteNode, x: -1720, z: 210, y: 0,
          bay: { x: -1638, z: 210, heading: -Math.PI / 2 }, queueDir: { x: 1, z: 0 },
          queueSlots: Array.from({ length: 5 }, (_, k) => ({
            x: -1638 + (k + 1) * 55, y: 0, z: 232, heading: -Math.PI / 2,
          })),
        },
      ],
    },
    pit,
    ramps,
    portals: ramps.map((r) => ({ id: r.id, base: r.base, node: r.portal })),
    facilities,
    hvLine,
    spawnPoints,
  };
}
