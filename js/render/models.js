// 矿用设备三维模型（电动矿卡、电铲、能源站、破碎站、排土场、泊位标线）
import * as THREE from '../../vendor/three.module.min.js';

const MAT = {
  dark: new THREE.MeshStandardMaterial({ color: 0x232c33, roughness: 0.78, metalness: 0.35 }),
  black: new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 0.9, metalness: 0.2 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.96, metalness: 0.04 }),
  body: new THREE.MeshStandardMaterial({ color: 0xd8dfe2, roughness: 0.52, metalness: 0.22 }),
  bodyAlt: new THREE.MeshStandardMaterial({ color: 0xbfc9cd, roughness: 0.6, metalness: 0.18 }),
  bed: new THREE.MeshStandardMaterial({ color: 0xc2ccd0, roughness: 0.6, metalness: 0.22 }),
  teal: new THREE.MeshStandardMaterial({ color: 0x1a9dc4, roughness: 0.45, metalness: 0.3 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x10222a, roughness: 0.16, metalness: 0.7, emissive: 0x0a1a22, emissiveIntensity: 0.5 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x5c666d, roughness: 0.62, metalness: 0.55 }),
  steelLight: new THREE.MeshStandardMaterial({ color: 0x8b949a, roughness: 0.55, metalness: 0.5 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xdfa53c, roughness: 0.58, metalness: 0.22 }),
  yellowDark: new THREE.MeshStandardMaterial({ color: 0xa87a26, roughness: 0.7, metalness: 0.2 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x4d555a, roughness: 0.97, metalness: 0.03 }),
  concreteLight: new THREE.MeshStandardMaterial({ color: 0x70787c, roughness: 0.95, metalness: 0.03 }),
  ore: new THREE.MeshStandardMaterial({ color: 0x6b4a37, roughness: 1, flatShading: true }),
  waste: new THREE.MeshStandardMaterial({ color: 0x7b7363, roughness: 1, flatShading: true }),
  light: new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffd27a, emissiveIntensity: 3.2 }),
  beacon: new THREE.MeshStandardMaterial({ color: 0xffa23a, emissive: 0xff7a1a, emissiveIntensity: 2.6 }),
  pad: new THREE.MeshStandardMaterial({ color: 0x62676a, roughness: 0.94 }),
  mark: new THREE.MeshBasicMaterial({ color: 0xf0c14a, transparent: true, opacity: 0.9 }),
  markDim: new THREE.MeshBasicMaterial({ color: 0xc9d2d6, transparent: true, opacity: 0.45 }),
};

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  circle: new THREE.CircleGeometry(1, 24),
  sphere: new THREE.SphereGeometry(1, 14, 10),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
  wheel: (() => { const g = new THREE.CylinderGeometry(1.9, 1.9, 1, 18); g.rotateZ(Math.PI / 2); return g; })(),
  wheelWide: (() => { const g = new THREE.CylinderGeometry(1.9, 1.9, 1, 18); g.rotateZ(Math.PI / 2); return g; })(),
  hub: (() => { const g = new THREE.CylinderGeometry(0.62, 0.62, 1, 12); g.rotateZ(Math.PI / 2); return g; })(),
};

function box(mat, sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(G.box, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(mat, r, len, x, y, z, axis = 'y') {
  const m = new THREE.Mesh(G.cyl, mat);
  m.scale.set(r, len, r);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function makeLabel(text, accent = '#7fe6ff') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(14, 3.1, 1);
  sprite.renderOrder = 20;
  let last = '';
  const draw = (txt, sub = '') => {
    const key = `${txt}|${sub}`;
    if (key === last) return;
    last = key;
    ctx.clearRect(0, 0, 512, 112);
    ctx.fillStyle = 'rgba(6, 15, 21, 0.68)';
    ctx.strokeStyle = 'rgba(127, 230, 255, 0.45)';
    ctx.lineWidth = 2;
    roundRect(ctx, 6, 6, 500, 100, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.font = '700 42px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, 26, sub ? 40 : 56);
    if (sub) {
      ctx.fillStyle = 'rgba(215, 236, 245, 0.86)';
      ctx.font = '400 26px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(sub, 26, 78);
    }
    texture.needsUpdate = true;
  };
  draw(text);
  sprite.userData.draw = draw;
  return sprite;
}

// 车身编号贴纸
function idPlate(id, accent) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 80;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, 256, 80);
  ctx.fillStyle = '#0e1a20';
  ctx.fillRect(8, 10, 240, 60);
  ctx.fillStyle = accent;
  ctx.fillRect(8, 10, 10, 60);
  ctx.fillStyle = '#e9f4f7';
  ctx.font = '700 40px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(id, 32, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  return mat;
}

// 尾板统一涂装：YCC 标识（所有矿卡共用一张贴图与材质）
let yccMat = null;
function yccMaterial() {
  if (yccMat) return yccMat;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 160);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#eef6f8';
  ctx.font = '800 118px "Arial Black", "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('YCC', 256, 76);
  ctx.fillStyle = '#1a9dc4';
  ctx.fillRect(176, 138, 160, 9);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  yccMat = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, roughness: 0.62, metalness: 0.05,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  return yccMat;
}

// 地面泊位标线
export function bayMark(w, l, color = MAT.mark) {
  const g = new THREE.Group();
  const t = 0.34;
  const y = 0.045;
  g.add(box(color, w, 0.02, t, 0, y, -l / 2));
  g.add(box(color, w, 0.02, t, 0, y, l / 2));
  g.add(box(color, t, 0.02, l, -w / 2, y, 0));
  g.add(box(color, t, 0.02, l, w / 2, y, 0));
  for (let i = -2; i <= 2; i++) {
    const stripe = box(color, w - 1.2, 0.02, 0.16, 0, y, i * l / 5.6);
    stripe.rotation.y = 0.72;
    g.add(stripe);
  }
  return g;
}

export function createTruck(id, accentColor = 0x1a9dc4, variant = 0) {
  const group = new THREE.Group();
  const accent = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.42, metalness: 0.32 });
  const bedMat = variant % 2 ? MAT.bed : MAT.bodyAlt;

  // ---------- 车架 ----------
  group.add(box(MAT.dark, 0.62, 0.75, 10.6, -1.62, 2.1, 0.1));
  group.add(box(MAT.dark, 0.62, 0.75, 10.6, 1.62, 2.1, 0.1));
  group.add(box(MAT.steel, 5.2, 0.36, 10.2, 0, 2.42, 0.1));
  // 前后桥
  group.add(box(MAT.black, 6.4, 0.85, 1.1, 0, 1.75, 4.35));
  group.add(box(MAT.black, 6.9, 1.0, 1.6, 0, 1.75, -1.7));
  group.add(box(MAT.black, 6.9, 1.0, 1.6, 0, 1.75, -4.45));

  // ---------- 车轮 ----------
  const wheels = [];
  const axles = [
    { z: 4.35, w: 1.55, x: 3.05 },
    { z: -1.7, w: 2.0, x: 3.2 },
    { z: -4.45, w: 2.0, x: 3.2 },
  ];
  for (const a of axles) {
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(G.wheel, MAT.tire);
      w.scale.set(a.w, 1, 1);
      w.position.set(sx * a.x, 1.9, a.z);
      w.castShadow = true;
      group.add(w);
      wheels.push(w);
      const hub = new THREE.Mesh(G.hub, MAT.steelLight);
      hub.scale.set(a.w + 0.08, 1, 1);
      hub.position.set(sx * (a.x + a.w * 0.5 + 0.04), 1.9, a.z);
      group.add(hub);
      // 挡泥板
      group.add(box(MAT.dark, a.w + 0.5, 0.18, 3.0, sx * a.x, 3.8, a.z));
    }
  }

  // ---------- 货厢（以后轴为铰点，卸车时可倾翻） ----------
  const bed = new THREE.Group();
  bed.position.set(0, 3.0, -6.2);
  const B = (mat, sx, sy, sz, x, y, z) => {
    const m = box(mat, sx, sy, sz, x, y - 3.0, z + 6.2);
    bed.add(m);
    return m;
  };
  B(MAT.steel, 6.7, 0.3, 8.6, 0, 3.05, -1.9);
  const sideL = B(bedMat, 0.3, 2.7, 8.6, -3.4, 4.42, -1.9);
  sideL.rotation.z = -0.09;
  const sideR = B(bedMat, 0.3, 2.7, 8.6, 3.4, 4.42, -1.9);
  sideR.rotation.z = 0.09;
  B(bedMat, 6.6, 2.8, 0.34, 0, 4.45, 2.25);
  const tail = B(bedMat, 6.6, 2.35, 0.32, 0, 4.15, -6.0);
  tail.rotation.x = 0.1;
  // 尾板 YCC 标识：与尾板同倾角，沿法线外移 2cm 避免深度冲突
  // bed 局部坐标 = 尾板中心 (0,1.15,0.2) + 后表面 0.16 + 倾角偏移
  const ycc = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.31), yccMaterial());
  ycc.position.set(0, 1.168, 0.021);
  ycc.rotation.set(0.1, Math.PI, 0);
  bed.add(ycc);
  // 加强筋
  for (const z of [-5.2, -3.4, -1.6, 0.2, 1.6]) {
    B(MAT.steel, 7.0, 0.26, 0.22, 0, 5.62, z);
    B(MAT.steel, 0.22, 2.4, 0.2, -3.5, 4.4, z);
    B(MAT.steel, 0.22, 2.4, 0.2, 3.5, 4.4, z);
  }
  // 前护板 / 驾驶室雨棚
  B(MAT.steel, 6.9, 0.26, 3.2, 0, 6.32, 3.3);
  B(bedMat, 6.9, 0.3, 0.4, 0, 6.02, 4.8);
  // 载荷
  const loadMat = new THREE.MeshStandardMaterial({ color: 0x6b4a37, roughness: 1, flatShading: true });
  const load = B(loadMat, 5.9, 1.25, 7.1, 0, 3.5, -1.9);
  load.visible = false;
  load.castShadow = false;
  const heap = new THREE.Mesh(G.sphere, loadMat);
  heap.scale.set(2.9, 1.1, 3.6);
  heap.position.set(0, 0.9, -1.5);
  heap.castShadow = false;
  heap.visible = false;
  load.add(heap);
  bed.userData.load = load;
  group.add(bed);

  // ---------- 驾驶室 ----------
  group.add(box(MAT.body, 2.7, 2.6, 2.7, -2.15, 4.5, 4.3));
  group.add(box(MAT.glass, 2.35, 1.35, 0.1, -2.15, 5.15, 5.66));
  group.add(box(MAT.glass, 0.1, 1.2, 2.2, -3.5, 5.05, 4.3));
  group.add(box(MAT.glass, 2.1, 1.1, 0.1, -2.15, 5.05, 2.96));
  group.add(box(MAT.steel, 2.9, 0.18, 3.0, -2.15, 5.86, 4.25));
  group.add(box(MAT.beacon, 0.36, 0.3, 0.36, -2.15, 6.05, 3.1));
  // 后视镜
  group.add(box(MAT.steel, 0.08, 0.6, 0.08, -3.55, 5.2, 5.5));
  group.add(box(MAT.glass, 0.08, 0.5, 0.9, -3.9, 5.4, 5.5));

  // ---------- 前部 ----------
  group.add(box(MAT.bodyAlt, 4.6, 2.3, 0.6, 0, 3.5, 5.9));
  for (let i = 0; i < 6; i++) group.add(box(MAT.black, 4.0, 0.12, 0.12, 0, 2.7 + i * 0.32, 6.2));
  group.add(box(accent, 6.6, 0.55, 0.5, 0, 2.15, 6.25));
  group.add(box(MAT.steel, 2.0, 0.9, 0.5, 0, 2.5, 6.45));
  group.add(box(MAT.light, 0.75, 0.4, 0.18, 2.35, 2.9, 6.28));
  group.add(box(MAT.light, 0.75, 0.4, 0.18, -2.35, 2.9, 6.28));
  // 登车梯
  for (let i = 0; i < 4; i++) group.add(box(MAT.steelLight, 0.7, 0.1, 0.3, 3.05, 2.35 + i * 0.62, 4.4));
  group.add(box(MAT.steel, 0.12, 2.6, 1.1, 3.4, 3.6, 4.4));

  // ---------- 电动总成 ----------
  group.add(box(MAT.dark, 2.3, 1.35, 3.4, 0, 1.9, -0.8));
  group.add(box(accent, 2.2, 0.16, 3.2, 0, 2.62, -0.8));
  group.add(box(MAT.teal, 1.6, 0.5, 0.12, 0, 2.16, 1.02));
  // 散热风扇（电动轮驱动柜）
  for (const sx of [-1, 1]) {
    const fan = new THREE.Mesh(G.cyl, MAT.black);
    fan.scale.set(0.62, 0.1, 0.62);
    fan.rotation.z = Math.PI / 2;
    fan.position.set(sx * 2.35, 2.0, 0.2);
    group.add(fan);
    const ring = new THREE.Mesh(G.cyl, MAT.steel);
    ring.scale.set(0.72, 0.12, 0.72);
    ring.rotation.z = Math.PI / 2;
    ring.position.set(sx * 2.4, 2.0, 0.2);
    group.add(ring);
  }

  // ---------- 举升油缸 / 后悬挂 ----------
  for (const sx of [-1, 1]) {
    group.add(cyl(MAT.steelLight, 0.24, 2.0, sx * 1.85, 3.05, 2.35));
    group.add(cyl(MAT.steel, 0.11, 1.5, sx * 1.85, 4.55, 2.35));
    group.add(box(MAT.dark, 0.42, 0.42, 2.6, sx * 2.45, 1.55, -3.1));
    group.add(box(MAT.steel, 0.5, 0.22, 0.5, sx * 2.45, 1.55, -4.3));
  }

  // ---------- 侧电池箱 / 爬梯 / 挡泥板 ----------
  for (const sx of [-1, 1]) {
    const bx = sx * 3.25;
    group.add(box(MAT.bodyAlt, 0.5, 1.25, 3.4, bx, 2.9, -2.2));
    for (let i = 0; i < 4; i++) group.add(box(MAT.dark, 0.54, 0.1, 2.9, bx, 2.55 + i * 0.32, -2.2));
    group.add(box(accent, 0.06, 0.16, 3.0, sx * 3.52, 3.2, -2.2));
    group.add(box(MAT.black, 0.08, 1.0, 1.9, sx * 3.55, 2.35, -5.35));
    group.add(box(MAT.black, 0.08, 0.85, 1.2, sx * 3.3, 2.5, 5.0));
    // 货厢顶部护栏
    group.add(box(MAT.steelLight, 0.07, 0.07, 6.2, sx * 3.5, 5.9, -2.0));
    for (const z of [-4.6, -2.6, -0.6]) group.add(box(MAT.steelLight, 0.06, 0.5, 0.06, sx * 3.5, 5.65, z));
    // 货厢侧反光条
    group.add(box(accent, 0.05, 0.18, 7.4, sx * 3.57, 4.15, -1.9));
  }

  // ---------- 前拖钩 / 雨刮 / 顶部信标 ----------
  for (const sx of [-1, 1]) group.add(box(MAT.steel, 0.22, 0.26, 0.42, sx * 1.55, 2.05, 6.32));
  const wiper = box(MAT.black, 0.06, 0.06, 1.5, -1.55, 5.5, 5.74);
  wiper.rotation.x = 0.35;
  group.add(wiper);
  group.add(box(MAT.dark, 1.35, 0.14, 0.3, -2.15, 6.0, 3.2));
  group.add(box(MAT.beacon, 0.28, 0.18, 0.22, -2.6, 6.1, 3.2));
  group.add(box(MAT.beacon, 0.28, 0.18, 0.22, -1.7, 6.1, 3.2));
  for (const sx of [-0.35, 0.35]) {
    group.add(cyl(MAT.steelLight, 0.035, 1.25, -2.15 + sx, 6.95, 3.0));
    group.add(box(MAT.black, 0.1, 0.1, 0.1, -2.15 + sx, 7.55, 3.0));
  }

  // ---------- 侧编号 ----------
  const plate = idPlate(id, `#${accentColor.toString(16).padStart(6, '0')}`);
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.12), plate);
    p.position.set(sx * 3.58, 4.55, -1.6);
    p.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    group.add(p);
  }

  // ---------- 尾灯 / 牌照 ----------
  group.add(box(MAT.beacon, 0.6, 0.3, 0.12, -2.2, 2.5, -6.0));
  group.add(box(MAT.beacon, 0.6, 0.3, 0.12, 2.2, 2.5, -6.0));

  // ---------- 接地阴影 ----------
  const shadow = new THREE.Mesh(G.circle, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(5.4, 9.2, 1);
  shadow.position.y = 0.06;
  group.add(shadow);

  const label = makeLabel(id, '#9fe9ff');
  label.position.set(0, 10.6, 0);
  label.scale.set(12.5, 2.75, 1);
  group.add(label);

  group.userData.truckId = id;
  return { group, wheels, bed, load, heap, label, loadMat, accent };
}

export function createShovel(id) {
  const group = new THREE.Group();
  // 履带
  for (const sx of [-1, 1]) {
    group.add(box(MAT.dark, 2.4, 1.2, 10.4, sx * 3.5, 1.0, 0));
    group.add(box(MAT.steel, 2.2, 1.3, 9.8, sx * 3.5, 1.9, 0.1));
    for (let i = 0; i < 9; i++) {
      group.add(box(MAT.black, 2.6, 0.28, 0.9, sx * 3.5, 0.45, -4.6 + i * 1.15));
    }
    // 履带护板
    group.add(box(MAT.yellowDark, 0.3, 0.5, 9.6, sx * 4.85, 1.3, 0));
  }
  // 底架与回转平台
  group.add(box(MAT.steel, 6.2, 0.7, 6.2, 0, 2.6, 0));
  group.add(box(MAT.yellow, 6.6, 0.5, 6.6, 0, 3.1, -0.2));
  // 上部机械室
  group.add(box(MAT.yellow, 5.8, 2.9, 6.6, 0, 4.85, -0.9));
  group.add(box(MAT.yellowDark, 5.9, 0.4, 6.7, 0, 6.35, -0.9));
  group.add(box(MAT.dark, 5.2, 1.6, 0.2, 0, 4.6, -4.2));
  // 司机室
  group.add(box(MAT.body, 2.0, 2.1, 2.2, -2.6, 5.3, 2.9));
  group.add(box(MAT.glass, 1.8, 1.1, 0.1, -2.6, 5.8, 4.02));
  group.add(box(MAT.glass, 0.1, 1.0, 1.6, -3.62, 5.7, 2.9));
  group.add(box(MAT.beacon, 0.3, 0.26, 0.3, -2.6, 6.55, 2.4));
  // 配重
  group.add(box(MAT.concreteLight, 4.8, 2.3, 2.6, 0, 4.5, -4.4));
  for (let i = 0; i < 3; i++) group.add(box(MAT.yellowDark, 4.2, 0.32, 0.1, 0, 3.7 + i * 0.6, -5.72));
  // 机房栏杆
  for (const sx of [-1, 1]) {
    group.add(box(MAT.steelLight, 0.1, 0.9, 5.8, sx * 2.85, 7.0, -0.9));
    for (let i = 0; i < 4; i++) group.add(box(MAT.steelLight, 0.1, 0.9, 0.1, sx * 2.85, 6.95, -3.6 + i * 1.8));
  }
  group.add(box(MAT.steelLight, 5.8, 0.1, 0.1, 0, 7.4, -3.75));

  // 大臂 + 斗杆 + 铲斗
  const boom = new THREE.Group();
  boom.position.set(0, 6.2, 1.6);
  boom.rotation.x = -0.52;
  const armBox = box(MAT.yellowDark, 1.15, 1.15, 12.4, 0, 0, 5.8);
  boom.add(armBox);
  boom.add(box(MAT.yellow, 1.4, 0.9, 2.0, 0, 0, 1.0));
  // 绷绳
  boom.add(cyl(MAT.steel, 0.09, 9.0, -0.55, 0.65, 6.0, 'z'));
  boom.add(cyl(MAT.steel, 0.09, 9.0, 0.55, 0.65, 6.0, 'z'));
  group.add(boom);

  const stick = new THREE.Group();
  stick.position.set(0, 0, 12.2);
  stick.rotation.x = 1.62;
  stick.add(box(MAT.yellow, 1.0, 1.0, 7.6, 0, 0, 3.4));
  stick.add(box(MAT.steel, 0.9, 0.9, 1.2, 0, 0, 6.9));
  // 铲斗
  const bucket = new THREE.Group();
  bucket.position.set(0, -0.3, 7.3);
  bucket.add(box(MAT.steel, 2.6, 2.0, 2.7, 0, -1.0, 0.6));
  bucket.add(box(MAT.dark, 2.4, 0.4, 2.4, 0, -2.0, 0.6));
  for (let i = 0; i < 5; i++) {
    const tooth = box(MAT.steelLight, 0.3, 0.35, 0.9, -1.0 + i * 0.5, -2.0, 2.1);
    tooth.rotation.x = 0.25;
    bucket.add(tooth);
  }
  stick.add(bucket);
  boom.add(stick);

  // 地面阴影
  const shadow = new THREE.Mesh(G.circle, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(5.6, 6.4, 1);
  shadow.position.y = 0.05;
  group.add(shadow);

  // 机棚照明
  group.add(box(MAT.light, 1.2, 0.22, 0.5, 0, 6.6, 2.8));

  const label = makeLabel(id, '#ffd88a');
  label.position.set(0, 14.6, 0);
  group.add(label);

  group.userData.shovelId = id;
  return { group, boom, stick, bucket, label };
}

// 工作面：装车泊位 + 排队车位标线（场地铺面由场景按台段轮廓生成弯曲带状平台）
export function createFaceYard(face) {
  const group = new THREE.Group();

  const bay = bayMark(17, 30);
  bay.position.set(face.spot.x, face.y + 0.1, face.spot.z);
  bay.rotation.y = face.bay.heading;
  group.add(bay);

  for (let i = 0; i < 4; i++) {
    const s = face.queueSlots[i];
    const m = bayMark(17, 30, MAT.markDim);
    m.position.set(s.x, face.y + 0.1, s.z);
    m.rotation.y = s.heading;
    group.add(m);
  }

  // 编号牌
  const label = makeLabel(`${face.id} 装车泊位`, face.ore ? '矿石工作面' : '废岩工作面');
  label.position.set(face.spot.x, face.y + 12, face.spot.z);
  label.scale.set(17, 3.7, 1);
  group.add(label);
  return { group, label };
}

export function createStation(st) {
  const group = new THREE.Group();
  group.position.set(st.x, 0, st.z);
  group.rotation.y = st.yaw;

  // 站台
  group.add(box(MAT.pad, 84, 0.5, 62, 0, 0.25, 8));
  group.add(box(MAT.concrete, 84, 0.16, 0.6, 0, 0.62, -22));
  // 换电工位标线
  const bay = bayMark(19, 34);
  bay.position.set(0, 0.4, 0);
  group.add(bay);
  // 直充车位
  for (const x of [-24, 24]) {
    const m = bayMark(15, 24, MAT.markDim);
    m.position.set(x, 0.4, 4);
    group.add(m);
    group.add(box(MAT.steel, 0.9, 5.6, 0.9, x + (x > 0 ? 9 : -9), 3, 4));
    group.add(box(MAT.teal, 1.1, 0.3, 0.5, x + (x > 0 ? 9 : -9), 5.6, 4));
  }

  // 换电门架
  for (const x of [-9.5, 9.5]) group.add(box(MAT.steel, 1.2, 13, 1.2, x, 6.5, 0));
  group.add(box(MAT.dark, 22, 1.1, 2.2, 0, 13.4, 0));
  group.add(box(MAT.teal, 22, 0.22, 2.4, 0, 14.1, 0));
  // 吊装小车与电池包
  const trolley = box(MAT.yellow, 3.0, 1.0, 2.6, 0, 12.4, 0);
  group.add(trolley);
  const hangPack = box(MAT.steel, 3.2, 1.6, 4.2, 0, 10.6, 0);
  group.add(hangPack);
  group.add(box(MAT.teal, 3.3, 0.18, 4.3, 0, 11.35, 0));
  // 换电棚
  for (const [x, z] of [[-21, -10], [21, -10], [-21, 10], [21, 10]]) {
    group.add(box(MAT.steel, 0.9, 9, 0.9, x, 4.5, z));
  }
  group.add(box(MAT.dark, 46, 0.8, 24, 0, 9.3, 0));
  group.add(box(MAT.teal, 46, 0.14, 0.5, 0, 9.85, 11.8));
  group.add(box(MAT.teal, 46, 0.14, 0.5, 0, 9.85, -11.8));
  group.add(box(MAT.light, 9, 0.1, 1.6, 0, 8.85, 0));

  // 电池架
  const packMeshes = [];
  const positions = [[-16, -14], [-5.5, -14], [5.5, -14], [16, -14]];
  positions.forEach(([x, z]) => {
    group.add(box(MAT.concreteLight, 6.4, 0.4, 4.4, x, 0.7, z));
    const shell = box(MAT.steel, 5.6, 3.2, 3.6, x, 2.5, z);
    group.add(shell);
    group.add(box(MAT.dark, 5.8, 0.24, 3.8, x, 4.16, z));
    const glowMat = new THREE.MeshStandardMaterial({ color: 0x12262b, emissive: 0x35e6b0, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0.3 });
    group.add(box(glowMat, 4.9, 2.6, 0.14, x, 2.6, z + 1.86));
    for (let k = 0; k < 4; k++) group.add(box(MAT.dark, 4.6, 0.1, 0.2, x, 1.6 + k * 0.55, z + 1.94));
    const lightMat = new THREE.MeshStandardMaterial({ color: 0x2a3439, emissive: 0x35e6b0, emissiveIntensity: 2 });
    const bulb = new THREE.Mesh(G.sphere, lightMat);
    bulb.scale.setScalar(0.34);
    bulb.position.set(x, 4.5, z);
    group.add(bulb);
    packMeshes.push({ glowMat, lightMat });
  });

  // 充电柜 / 电缆盘 / 集装箱控制室
  for (const x of [-30, 30]) {
    group.add(box(MAT.concreteLight, 3.4, 5.6, 3.6, x, 2.8, -16));
    group.add(box(MAT.teal, 3.0, 0.3, 0.12, x, 5.2, -14.18));
  }
  group.add(box(MAT.body, 7.4, 3.2, 3.4, 0, 1.6, -21));
  group.add(box(MAT.glass, 2.2, 1.0, 0.1, 0, 2.0, -19.28));
  group.add(box(MAT.teal, 7.6, 0.2, 0.3, 0, 3.1, -19.3));
  for (const [x, z] of [[-34, 14], [34, 14]]) {
    group.add(box(MAT.steel, 0.35, 12, 0.35, x, 6, z));
    group.add(box(MAT.light, 1.5, 0.3, 0.7, x, 12.1, z));
  }
  // 围栏
  for (let i = 0; i < 9; i++) {
    const x = -38 + i * 9.5;
    group.add(box(MAT.steelLight, 0.12, 1.8, 0.12, x, 0.9, -26));
  }
  group.add(box(MAT.steelLight, 76, 0.08, 0.08, 0, 1.7, -26));

  const label = makeLabel(st.name, '换电 1 工位 · 直充 2 位');
  label.position.set(0, 17.5, 0);
  group.add(label);
  return { group, packMeshes, label, trolley, hangPack };
}

export function createCrusher(pos = { x: 0, z: 960 }) {
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);

  // 卸车平台
  group.add(box(MAT.concrete, 46, 0.6, 54, 0, 0.3, -34));
  const bay = bayMark(19, 32);
  bay.position.set(0, 0.7, -74);
  group.add(bay);
  // 挡墙
  for (const sx of [-1, 1]) {
    group.add(box(MAT.concrete, 1.4, 6.5, 26, sx * 14, 3.2, -34));
    group.add(box(MAT.yellow, 1.5, 0.3, 26, sx * 14, 6.5, -34));
  }
  group.add(box(MAT.concrete, 28, 6.5, 1.4, 0, 3.2, -21));

  // 受料斗 + 格筛
  group.add(box(MAT.steel, 20, 5.6, 14, 0, 3.4, -46));
  group.add(box(MAT.dark, 21, 0.5, 15, 0, 6.4, -46));
  for (let i = 0; i < 11; i++) {
    group.add(box(MAT.steelLight, 0.28, 0.4, 13.4, -9 + i * 1.8, 6.85, -46));
  }
  // 破碎机楼
  group.add(box(MAT.concreteLight, 18, 12, 16, 0, 6, -14));
  group.add(box(MAT.dark, 18.6, 0.8, 16.6, 0, 12.2, -14));
  group.add(box(MAT.yellow, 3.2, 2.4, 3.2, 9, 1.4, -2));
  // 输送带
  const conveyor = new THREE.Group();
  conveyor.position.set(0, 8, 0);
  conveyor.rotation.x = -0.32;
  group.add(conveyor);
  conveyor.add(box(MAT.dark, 3.2, 0.5, 32, 0, 0, 18));
  for (let i = 0; i < 8; i++) {
    conveyor.add(box(MAT.steel, 0.14, 3.2, 0.14, -1.9, -2, -2 + i * 4));
    conveyor.add(box(MAT.steel, 0.14, 3.2, 0.14, 1.9, -2, -2 + i * 4));
  }
  // 料堆
  const pile = new THREE.Mesh(new THREE.ConeGeometry(15, 11, 20), MAT.ore);
  pile.position.set(0, 5.2, 40);
  pile.castShadow = true;
  pile.receiveShadow = true;
  group.add(pile);
  const pile2 = new THREE.Mesh(new THREE.ConeGeometry(9, 7, 16), MAT.ore);
  pile2.position.set(15, 3.4, 30);
  group.add(pile2);

  // 除尘喷雾
  for (const [x, z] of [[-12, -40], [12, -40], [-12, -30], [12, -30]]) {
    group.add(box(MAT.steel, 0.2, 4.2, 0.2, x, 2.1, z));
    group.add(box(MAT.teal, 0.6, 0.2, 0.6, x, 4.2, z));
  }

  const label = makeLabel('北破碎站', '矿石卸载 · 100t/车');
  label.position.set(0, 22, -8);
  group.add(label);
  return { group, label };
}

export function createWasteDump(pos = { x: -1060, z: 120 }) {
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);
  // 分级排土堆
  const rings = [
    { r: 74, h: 10, y: 5, color: 0x716a5b },
    { r: 52, h: 10, y: 15, color: 0x7c7564 },
    { r: 32, h: 9, y: 24, color: 0x877e6b },
    { r: 14, h: 7, y: 31, color: 0x928772 },
  ];
  for (const ring of rings) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(ring.r, ring.r + 10, ring.h, 26, 1), new THREE.MeshStandardMaterial({ color: ring.color, roughness: 1, flatShading: true }));
    m.position.y = ring.y;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  // 卸车平台 + 挡车堆
  group.add(box(MAT.pad, 44, 0.5, 42, 105, 0.25, 0));
  const bay = bayMark(18, 30);
  bay.rotation.y = Math.PI / 2;
  bay.position.set(108, 0.6, 0);
  group.add(bay);
  for (let i = 0; i < 7; i++) {
    group.add(box(MAT.waste, 3.2, 4.2, 3.2, 88 + (i % 2) * 2.5, 2.1, -14 + i * 4.6));
  }
  // 推土机
  const dozer = new THREE.Group();
  dozer.position.set(62, 9, 26);
  dozer.add(box(MAT.yellow, 3.2, 1.4, 5.0, 0, 1.2, 0));
  dozer.add(box(MAT.yellowDark, 4.4, 1.8, 1.2, 0, 1.2, 2.8));
  dozer.add(box(MAT.dark, 2.8, 0.9, 0.9, 0, 0.5, -1.8));
  group.add(dozer);

  const label = makeLabel('西排土场', '废岩卸载 · 分级堆排');
  label.position.set(0, 38, 0);
  group.add(label);
  return { group, label, dozer };
}

export function createBuilding(x, z, w, d, h, color = 0x9aa3a6) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.12 });
  group.add(box(mat, w, h, d, 0, h / 2, 0));
  group.add(box(MAT.dark, w + 1.4, 0.5, d + 1.4, 0, h + 0.25, 0));
  group.add(box(MAT.teal, w + 1.0, 0.2, 0.4, 0, h * 0.6, d / 2 + 0.1));
  for (let i = 0; i < Math.floor(w / 6); i++) {
    group.add(box(MAT.glass, 1.6, 1.0, 0.1, -w / 2 + 3 + i * 6, h * 0.62, d / 2 + 0.12));
  }
  return group;
}

export function createMast(x, z, height = 18) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.add(box(MAT.concreteLight, 1.6, 0.7, 1.6, 0, 0.35, 0));
  group.add(box(MAT.steel, 0.62, height, 0.62, 0, height / 2 + 0.6, 0));
  // 斜撑
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const brace = box(MAT.steel, 0.09, height * 0.34, 0.09, sx * 0.72, height * 0.19 + 0.6, sz * 0.72);
    brace.rotation.z = sx * 0.22;
    brace.rotation.x = -sz * 0.22;
    group.add(brace);
  }
  group.add(box(MAT.dark, 3.4, 0.3, 1.0, 0, height + 0.55, 0));
  group.add(box(MAT.light, 2.6, 0.22, 0.7, 0, height + 0.28, 0));
  group.add(box(MAT.dark, 1.5, 0.5, 0.7, 0.9, height + 0.8, 0));
  return group;
}

export function createRock(size, color = 0x8a8172) {
  const geo = new THREE.DodecahedronGeometry(size, 0);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------------- 远景能源设施 ----------------
// 南侧燃煤火电厂：主厂房 + 锅炉房 + 双烟囱 + 冷却塔 + 煤场 + 升压站
export function createThermalPlant({ x = 0, z = 0, y = -1.6, yaw = 0 } = {}) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  const red = new THREE.MeshStandardMaterial({ color: 0xb0472f, roughness: 0.72 });
  const white = new THREE.MeshStandardMaterial({ color: 0xd9dad4, roughness: 0.78 });
  const coal = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 1, flatShading: true });

  // 厂区地坪
  group.add(box(MAT.pad, 340, 0.5, 250, 0, 0.25, 0));
  // 汽机房 / 主厂房
  group.add(box(MAT.steelLight, 150, 40, 62, 40, 20, -40));
  group.add(box(MAT.dark, 154, 2.4, 66, 40, 41, -40));
  group.add(box(MAT.concreteLight, 96, 30, 46, 130, 15, 20));
  group.add(box(MAT.teal, 98, 2.6, 46, 130, 31, 20));
  // 锅炉房
  group.add(box(MAT.steel, 58, 72, 52, -40, 36, 24));
  group.add(box(MAT.dark, 62, 3, 56, -40, 73, 24));
  group.add(box(MAT.yellow, 10, 10, 10, -40, 80, 24));
  // 双烟囱（红白环带）
  for (const sx of [26, 76]) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 8.4, 165, 18), white);
    stack.position.set(sx, 82.5, 92);
    stack.castShadow = true;
    group.add(stack);
    for (const h of [105, 135, 158]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(6.0 - h * 0.012, 6.2 - h * 0.012, 7, 18), red);
      band.position.set(sx, h, 92);
      group.add(band);
    }
  }
  // 冷却塔（双曲面近似）
  const towerPts = [
    new THREE.Vector2(48, 0), new THREE.Vector2(36, 24), new THREE.Vector2(25, 58),
    new THREE.Vector2(23, 76), new THREE.Vector2(29, 96), new THREE.Vector2(31, 104),
  ];
  const towerGeo = new THREE.LatheGeometry(towerPts, 30);
  for (const [tx, tz] of [[-138, -30], [-138, 88]]) {
    const tw = new THREE.Mesh(towerGeo, MAT.concreteLight);
    tw.position.set(tx, 0, tz);
    tw.castShadow = true;
    tw.receiveShadow = true;
    group.add(tw);
  }
  // 煤场 + 堆取料皮带
  const pile = new THREE.Mesh(new THREE.ConeGeometry(48, 26, 22), coal);
  pile.position.set(-60, 13, -158);
  pile.castShadow = true;
  group.add(pile);
  const belt = box(MAT.dark, 8, 1.4, 150, -40, 16, -92);
  belt.rotation.x = -0.22;
  group.add(belt);
  // 升压站：门型构架 + 主变
  for (let i = 0; i < 3; i++) {
    const px = 150 + i * 26;
    group.add(box(MAT.steel, 0.6, 18, 0.6, px, 9, -100));
    group.add(box(MAT.steel, 0.6, 18, 0.6, px, 9, -84));
    group.add(box(MAT.steelLight, 0.5, 0.5, 17, px, 18, -92));
  }
  group.add(box(MAT.dark, 10, 7, 8, 138, 3.5, -118));
  group.add(box(MAT.yellow, 6, 5, 5, 156, 2.5, -118));
  // 标识灯
  for (const [lx, lz] of [[-160, 110], [160, 110], [-160, -110], [160, -110]]) {
    group.add(box(MAT.light, 1.2, 1.2, 1.2, lx, 8, lz));
    group.add(box(MAT.dark, 0.5, 8, 0.5, lx, 4, lz));
  }
  return { group };
}

// 东北光伏电站：成排倾斜光伏板 + 逆变器 + 中控楼
export function createSolarFarm({ x = 0, z = 0, y = -1.6, yaw = 0, rows = 9, cols = 12 } = {}) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x14203a, roughness: 0.28, metalness: 0.68, emissive: 0x0a1630, emissiveIntensity: 0.35,
  });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x9aa4ab, roughness: 0.5, metalness: 0.6 });
  const PW = 5.4, PL = 9.6, CGAP = 2.6, RGAP = 17;
  const gw = cols * (PW + CGAP);
  const gd = rows * RGAP;
  group.add(box(MAT.pad, gw + 40, 0.35, gd + 40, 0, 0.18, 0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = -gw / 2 + PW / 2 + c * (PW + CGAP);
      const pz = -gd / 2 + r * RGAP;
      const panel = new THREE.Mesh(G.box, panelMat);
      panel.scale.set(PW, 0.22, PL);
      panel.position.set(px, 2.9, pz);
      panel.rotation.x = -0.42;
      panel.castShadow = true;
      panel.receiveShadow = true;
      group.add(panel);
      group.add(box(frameMat, 0.28, 2.6, 0.28, px - PW * 0.42, 1.4, pz));
      group.add(box(frameMat, 0.28, 2.6, 0.28, px + PW * 0.42, 1.4, pz));
    }
  }
  // 汇流箱 / 逆变器
  for (let r = 0; r < rows; r += 3) {
    group.add(box(MAT.steelLight, 4.2, 3.4, 2.6, gw / 2 + 14, 1.7, -gd / 2 + r * RGAP + 6));
  }
  group.add(box(MAT.concreteLight, 26, 9, 14, gw / 2 + 34, 4.5, gd / 2 - 6));
  group.add(box(MAT.dark, 27, 0.8, 15, gw / 2 + 34, 9.4, gd / 2 - 6));
  return { group };
}

// 西侧风电场：一排塔筒 + 三叶片转子（转子由场景每帧旋转）
export function createWindFarm({ x = 0, z = 0, y = -1.6, yaw = 0, count = 6, spacing = 330 } = {}) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  const towerMat = new THREE.MeshStandardMaterial({ color: 0xe3e5e1, roughness: 0.5, metalness: 0.22 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xf0f1ec, roughness: 0.38, metalness: 0.12 });
  const towerGeo = new THREE.CylinderGeometry(2.1, 4.0, 96, 14);
  const rotors = [];
  for (let i = 0; i < count; i++) {
    const unit = new THREE.Group();
    unit.position.set((i % 2) * 70, 0, (i - (count - 1) / 2) * spacing);
    unit.add(box(MAT.concrete, 16, 1.0, 16, 0, 0.5, 0));
    const tower = new THREE.Mesh(towerGeo, towerMat);
    tower.position.y = 48;
    tower.castShadow = true;
    unit.add(tower);
    unit.add(box(towerMat, 7.4, 7.4, 15, 0, 98, 2));
    const rotor = new THREE.Group();
    rotor.position.set(0, 98, 10.4);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 3.4, 12), bladeMat);
    hub.rotation.x = Math.PI / 2;
    rotor.add(hub);
    for (let k = 0; k < 3; k++) {
      const arm = new THREE.Group();
      arm.rotation.z = (k * Math.PI * 2) / 3;
      arm.add(box(bladeMat, 2.6, 16, 0.8, 0, 8, 0));
      const tip = box(bladeMat, 1.2, 38, 0.55, 0, 34, 0);
      tip.rotation.z = 0.012;
      arm.add(tip);
      rotor.add(arm);
    }
    unit.add(rotor);
    rotors.push(rotor);
    group.add(unit);
  }
  return { group, rotors };
}

// 高压输电走廊：格构塔 + 下垂导线
export function createPylonLine(pts = []) {
  const group = new THREE.Group();
  if (pts.length < 2) return group;
  const H = 46;
  const ARM = [30, 39];
  const HALF = 9.5;
  const first = pts[0], last = pts[pts.length - 1];
  const yaw = Math.atan2(last.x - first.x, last.z - first.z);
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2c3338, transparent: true, opacity: 0.85 });

  const towers = pts.map((p) => {
    const t = new THREE.Group();
    t.position.set(p.x, p.y, p.z);
    t.rotation.y = yaw;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = box(MAT.steel, 0.55, H, 0.55, sx * 3.0, H / 2, sz * 2.2);
        leg.rotation.z = -sx * 0.045;
        leg.rotation.x = sz * 0.045;
        t.add(leg);
      }
    }
    for (const h of [13, 23, 32]) t.add(box(MAT.steel, 7.4, 0.4, 5.2, 0, h, 0));
    for (const h of ARM) {
      t.add(box(MAT.steel, 2 * HALF + 2, 0.55, 0.55, 0, h, 0));
      for (const sx of [-1, 1]) t.add(box(MAT.steelLight, 0.35, 3.2, 0.35, sx * HALF, h - 1.6, 0));
    }
    t.add(box(MAT.beacon, 0.7, 0.7, 0.7, 0, H + 0.6, 0));
    group.add(t);
    return p;
  });

  const attach = (p, s, h) => ({
    x: p.x + s * HALF * cos,
    y: p.y + h,
    z: p.z - s * HALF * sin,
  });
  for (let i = 0; i < towers.length - 1; i++) {
    for (const h of ARM) {
      for (const s of [-1, 1]) {
        const A = attach(towers[i], s, h);
        const B = attach(towers[i + 1], s, h);
        const arr = [];
        for (let k = 0; k <= 10; k++) {
          const t = k / 10;
          arr.push(new THREE.Vector3(
            A.x + (B.x - A.x) * t,
            A.y + (B.y - A.y) * t - Math.sin(Math.PI * t) * 5.5,
            A.z + (B.z - A.z) * t
          ));
        }
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arr), wireMat));
      }
    }
  }
  return group;
}
