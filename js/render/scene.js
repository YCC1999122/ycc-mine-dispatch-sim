// Three.js 主场景：不规则采坑地形、分级运输道路、矿卡/电铲、能源站与驾驶室视角
import * as THREE from '../../vendor/three.module.min.js';
import { heightAt, rimRadius, levelRadius, benchWidthAt } from '../world.js?v=world23';
import {
  createTruck, createShovel, createStation, createCrusher, createWasteDump,
  createFaceYard, createBuilding, createMast, createRock,
  createThermalPlant, createSolarFarm, createWindFarm, createPylonLine,
} from './models.js?v=ycc3';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function hash(x, z) {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

const TRUCK_ACCENTS = [0x1f9fc4, 0xc8912f, 0xb8543f, 0x35a37a, 0x8a7ad4, 0xc2b64a];

// 地表细粒纹理：碎石颗粒 + 低频色差，避免大面积单色导致“塑料感”
function makeGroundTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    const rad = 8 + Math.random() * 38;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const dark = Math.random() > 0.5;
    g.addColorStop(0, dark ? 'rgba(120,112,100,0.16)' : 'rgba(255,252,244,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 9000; i++) {
    const v = 150 + Math.random() * 95;
    ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},${0.1 + Math.random() * 0.2})`;
    const w = 0.8 + Math.random() * 2.2;
    ctx.fillRect(Math.random() * s, Math.random() * s, w, w);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(52, 45);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRoadIndex(world) {
  const cell = 48;
  const map = new Map();
  const key = (ix, iz) => `${ix}:${iz}`;
  const add = (x, z, y, half, kind) => {
    const ix = Math.floor(x / cell);
    const iz = Math.floor(z / cell);
    const k = key(ix, iz);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ x, z, y, half, kind });
  };
  for (const road of world.roads) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const A = world.nodes[road.pts[i]];
      const B = world.nodes[road.pts[i + 1]];
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      const steps = Math.max(1, Math.ceil(len / 11));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        add(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t, A.y + (B.y - A.y) * t, road.width / 2, road.kind);
      }
    }
  }
  return { map, cell, key };
}

function nearestRoad(index, x, z) {
  const { map, cell, key } = index;
  const ix = Math.floor(x / cell);
  const iz = Math.floor(z / cell);
  let best = null;
  let bd = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const arr = map.get(key(ix + dx, iz + dz));
      if (!arr) continue;
      for (const p of arr) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bd) { bd = d; best = p; }
      }
    }
  }
  return best ? { dist: bd, ...best } : null;
}

export class MineScene {
  constructor({ canvas, cabCanvas, world, onSelect, onHover, onFollow }) {
    this.canvas = canvas;
    this.cabCanvas = cabCanvas;
    this.world = world;
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
    this.onFollow = onFollow || (() => {});
    this.selected = null;
    this.focus = false;
    this.follow = false;
    this.cabActive = false;
    // 驾驶模式：选中矿车后可由右下角面板进入，主视角切为车载/第三人称视角
    this.drive = { on: false, id: null, view: 'front' };
    this.truckRefs = new Map();
    this.truckTargets = new Map();
    this.stationRefs = new Map();
    this.shovelRefs = new Map();
    this.dumpRefs = new Map();
    this.facePads = new Map();
    this.windRotors = [];
    this.lastHover = 0;
    this.raycaster = new THREE.Raycaster();

    // 追车相机参数
    this.followDist = 68;
    this.followHeight = 30;
    this.followSide = 14;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.cabRenderer = new THREE.WebGLRenderer({ canvas: cabCanvas, antialias: true, preserveDrawingBuffer: true });
    this.cabRenderer.setClearColor(0x0a141b, 1);
    this.cabRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.3));
    this.cabRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.cabRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.cabRenderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xd8e0e2, 2300, 5800);
    this.camera = new THREE.PerspectiveCamera(54, 1, 1.2, 9000);
    this.cabCamera = new THREE.PerspectiveCamera(72, 1.6, 0.4, 4000);

    this.theta = Math.PI;
    this.phi = 0.66;
    this.radius = 1350;
    this.target = new THREE.Vector3(0, -28, 0);

    // 默认机位：对准主力矿石工作面，保证车辆在初始视角下可辨认
    const workFace = world.faces.find((f) => f.ore) || world.faces[0];
    if (workFace) {
      this.work = {
        x: workFace.spot.x,
        z: workFace.spot.z,
        y: workFace.y,
        theta: Math.atan2(workFace.spot.x, workFace.spot.z),
      };
      this.target.set(this.work.x, -46, this.work.z);
      this.theta = this.work.theta;
      this.phi = 0.8;
      this.radius = 680;
    }
    this.shadowAcc = 0;

    this.clock = new THREE.Clock();
    this.keys = {};
    this.freeCam = false;
    this.freeYaw = 0;
    this.freePitch = 0.2;
    this.freeSpeed = 160;
    this.buildSky();
    this.buildLights();
    this.buildTerrain();
    this.buildRoads();
    this.buildFacilities();
    this.buildVehicles();
    this.buildDust();
    this.buildWeather();
    this.buildWeatherFX();
    this.buildSelection();
    this.buildRoute();
    this.buildTracks();
    this.bindPointer();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  buildSky() {
    const geo = new THREE.SphereGeometry(4400, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x74a8c6) },
        bottom: { value: new THREE.Color(0xe9e3d4) },
        offset: { value: 280 },
        exponent: { value: 0.85 },
      },
      vertexShader: 'varying vec3 vWorld; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; uniform float offset; uniform float exponent; varying vec3 vWorld; void main(){ float h = normalize(vWorld + vec3(0.0, offset, 0.0)).y; gl_FragColor = vec4(mix(bottom, top, pow(max(h,0.0), exponent)), 1.0); }',
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xd2e4ee, 0x6b5f4e, 0.56));
    const sun = new THREE.DirectionalLight(0xfff3e2, 1.95);
    sun.position.set(-880, 1250, 820);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -1000;
    sun.shadow.camera.right = 1000;
    sun.shadow.camera.top = 1000;
    sun.shadow.camera.bottom = -1000;
    sun.shadow.camera.near = 200;
    sun.shadow.camera.far = 3400;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 1.1;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x8fa4ad, 0.26));
  }

  buildTerrain() {
    const pit = this.world.pit;
    const sizeX = 4000;
    const sizeZ = 3600;
    const segX = 400;
    const segZ = 360;
    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // 分类型建索引：地表道路只做路基削平；坡道要做断面开挖/填方，
    // 否则坡道走廊与台面之间会残留一圈土埂（视觉上像碗状圆环把路切断）
    const roadIndex = makeRoadIndex({
      nodes: this.world.nodes,
      roads: this.world.roads.filter((r) => r.kind === 'surface' || r.kind === 'station'),
    });
    const rampIndex = makeRoadIndex({
      nodes: this.world.nodes,
      roads: this.world.roads.filter((r) => r.kind === 'ramp'),
    });
    this.roadIndex = roadIndex;
    this.rampIndex = rampIndex;
    const pads = [
      ...this.world.stations.map((s) => ({ x: s.x, z: s.z, r: 58, blend: 64 })),
      ...this.world.dumps.list.map((d) => ({ x: d.x, z: d.z, r: 92, blend: 80 })),
    ];
    const oreSpots = this.world.faces.filter((f) => f.ore).map((f) => ({ x: f.spot.x, z: f.spot.z }));
    const cA = new THREE.Color(0x817a6d);
    const cB = new THREE.Color(0x736d61);
    const cFloor = new THREE.Color(0x675f54);
    const cWall = new THREE.Color(0x453d34);
    const cBerm = new THREE.Color(0x9a907d);
    const cOut = new THREE.Color(0x8f897b);
    const cVeg = new THREE.Color(0x74805f);
    const cOre = new THREE.Color(0x241c16);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let h = heightAt(x, z, pit);

      // 路基削平：仅地表道路与场内支线需要把起伏地形削平
      const road = nearestRoad(roadIndex, x, z);
      if (road && road.dist < road.half + 26) {
        const t = 1 - smoothstep(road.half, road.half + 26, road.dist);
        h = h * (1 - t) + (road.y + 0.02) * t;
      }
      // 坡道断面：高于路面处开挖、低于路面处填方，边坡 1:1.4，
      // 保证坡道始终坐在同一套地形上，既不悬空也不被台面埋住
      const ramp = nearestRoad(rampIndex, x, z);
      if (ramp && ramp.dist - ramp.half < 50) {
        // 路面半宽 + 路肩范围内保持平整，再以 1:1.4 边坡过渡到原地面
        const lim = Math.max(0, ramp.dist - (ramp.half + 7)) * 1.4;
        h = Math.min(Math.max(h, ramp.y - lim), ramp.y + lim);
      }
      for (const p of pads) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < p.r + p.blend) {
          const t = 1 - smoothstep(p.r, p.r + p.blend, d);
          h = h * (1 - t);
        }
      }
      pos.setY(i, h);

      const ang = Math.atan2(z, x);
      const rim = rimRadius(ang, pit);
      const d = rim - Math.hypot(x, z);
      if (d > -4) {
        const t = clamp(d / benchWidthAt(ang, pit), 0, pit.levels + 0.001);
        const lvl = Math.min(pit.levels, Math.floor(t));
        c.copy(lvl >= pit.levels ? cFloor : lvl % 2 ? cB : cA);
        const f = t - lvl;
        if (lvl < pit.levels) {
          // 台段外缘压实挡土埂提亮，坡面明显压暗，强化台阶层次
          if (f < 0.07) c.lerp(cBerm, 0.55 * (1 - f / 0.07));
          if (f > 0.62) c.lerp(cWall, Math.min(0.92, (f - 0.62) * 3.4));
        }
        for (const s of oreSpots) {
          const ds = Math.hypot(x - s.x, z - s.z);
          if (ds < 150) c.lerp(cOre, 0.5 * (1 - ds / 150));
        }
      } else {
        c.copy(cOut);
        if (hash(x * 0.5, z * 0.5) > 0.66) c.lerp(cVeg, 0.42);
        if (hash(x * 0.13 + 3, z * 0.17) > 0.9) c.lerp(cWall, 0.25);
      }
      const n = hash(x * 0.7, z * 0.7) * 0.55 + hash(x * 0.11 + 5, z * 0.13 - 3) * 0.45;
      c.offsetHSL(0, 0, (n - 0.5) * 0.075);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const groundTex = makeGroundTexture();
    groundTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0.02, map: groundTex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.terrainMat = mat;
    this.terrainMesh = mesh;

    // 远景基底（内径大于坑口最大半径，避免遮挡坑内台段）
    const apron = new THREE.Mesh(
      new THREE.RingGeometry(1620, 5000, 96),
      new THREE.MeshStandardMaterial({ color: 0x8a8576, roughness: 1, side: THREE.DoubleSide })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -1.6;
    this.scene.add(apron);

    this.buildBenchWalls(pit);

    // 台段轮廓（宽度随方位变化，台阶线不平行）
    for (let i = 0; i <= pit.levels; i++) {
      const y = -i * pit.benchH + 0.12;
      const segs = [];
      let prev = null;
      for (let k = 0; k <= 200; k++) {
        const a = (k / 200) * Math.PI * 2;
        const r = levelRadius(a, i, pit);
        const p = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
        // 坡道走廊内不画台段轮廓线，避免线条横跨开挖断面（视觉上像“路下面还有一条路”）
        const cut = nearestRoad(this.rampIndex, p.x, p.z);
        if (cut && cut.dist < cut.half + 40) { prev = null; continue; }
        if (prev) segs.push(prev, p);
        prev = p;
      }
      const line = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(segs),
        new THREE.LineBasicMaterial({ color: i === 0 ? 0xd9e4e2 : 0x6f6756, transparent: true, opacity: i === 0 ? 0.35 : 0.22 })
      );
      this.scene.add(line);
    }

    // 远山：连续山脊环带，替代孤立锥体
    this.buildFarRidges();

    // 地表建筑、灯杆与散石
    this.scene.add(createBuilding(-300, 1020, 86, 40, 15, 0x9aa3a6));
    this.scene.add(createBuilding(-430, 960, 42, 26, 11, 0xb0b4b2));
    this.scene.add(createBuilding(980, 760, 52, 34, 12, 0xa3aaa9));
    this.scene.add(createMast(-92, 700, 22));
    this.scene.add(createMast(300, 700, 22));
    this.scene.add(createMast(96, 960, 22));
    this.scene.add(createMast(-760, -560, 22));
    this.scene.add(createMast(720, -520, 22));
    for (let i = 0; i < 54; i++) {
      const a = hash(i, 21) * Math.PI * 2;
      const r = 560 + hash(i, 23) * 700;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // 散石不落在道路、场地与采坑内
      const near = nearestRoad(roadIndex, x, z);
      if (near && near.dist < 34) continue;
      if (rimRadius(Math.atan2(z, x), pit) - Math.hypot(x, z) > -10) continue;
      if (pads.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + 40)) continue;
      if (this.world.faces.some((f) => Math.hypot(x - f.spot.x, z - f.spot.z) < 150)) continue;
      const rock = createRock(2 + hash(i, 29) * 5.5);
      rock.position.set(x, heightAt(x, z, pit) + 0.5, z);
      rock.rotation.set(hash(i, 31) * 0.4, hash(i, 37) * 3, 0);
      this.scene.add(rock);
    }
  }

  // 远景山脊：两层错落环带，受雾衰减，形成连续山际线
  buildFarRidges() {
    const layers = [
      { r: 3250, base: -110, h: 230, seg: 150, top: 0x8d9a9e, bot: 0x74838a },
      { r: 4050, base: -130, h: 330, seg: 128, top: 0x9daaad, bot: 0x86949a },
    ];
    layers.forEach((L, li) => {
      const pos = [];
      const col = [];
      const idx = [];
      const cT = new THREE.Color(L.top);
      const cB = new THREE.Color(L.bot);
      for (let k = 0; k <= L.seg; k++) {
        const a = (k / L.seg) * Math.PI * 2;
        const n = Math.sin(a * 3.1 + li * 2.3) * 0.32 + Math.sin(a * 7.7 + 1.2) * 0.2 + Math.sin(a * 13.3 + li) * 0.1;
        const h = L.h * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(a * 5 + li * 1.7)) + n);
        const r = L.r * (1 + Math.sin(a * 2 + li) * 0.02);
        pos.push(Math.cos(a) * r, L.base, Math.sin(a) * r);
        pos.push(Math.cos(a) * r, h, Math.sin(a) * r);
        col.push(cB.r, cB.g, cB.b, cT.r, cT.g, cT.b);
      }
      for (let k = 0; k < L.seg; k++) {
        const p = k * 2;
        idx.push(p, p + 2, p + 3, p, p + 3, p + 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, fog: true,
      }));
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    });
  }

  // 台阶坡面：沿每层台段内缘生成近直立岩壁，保证任意距离下台阶轮廓清晰
  buildBenchWalls(pit) {
    const COUNT = 260;
    const pos = [];
    const col = [];
    const idx = [];
    const cTop = new THREE.Color(0xb1a489);
    const cMid = new THREE.Color(0x8a7d68);
    const cBot = new THREE.Color(0x6a5f50);
    const top = new THREE.Color();
    const bot = new THREE.Color();
    // 坡道是切进台段坡面的堑沟：走廊内的台段壁必须挖开，
    // 否则壁面会从坡道路面里凸出来，形成“路中间立起一个碗状圆环”的假象
    const rampIndex = makeRoadIndex({
      nodes: this.world.nodes,
      roads: this.world.roads.filter((r) => r.kind === 'ramp'),
    });
    const inRampCut = (x, z) => {
      const r = nearestRoad(rampIndex, x, z);
      return !!(r && r.dist < r.half + 45);
    };
    for (let i = 0; i < pit.levels; i++) {
      const base = pos.length / 3;
      for (let k = 0; k <= COUNT; k++) {
        const a = (k / COUNT) * Math.PI * 2;
        const w = benchWidthAt(a, pit);
        const rim = rimRadius(a, pit);
        // 台段坡面从 0.8w（陡坎起）到 1.0w（下一台段地表），与地形 smoothstep 区间严格对齐
        const rTop = rim - (i + 0.8) * w;
        const rBot = rim - (i + 1.0) * w;
        const yTop = -i * pit.benchH + 0.02;
        const yBot = -(i + 1) * pit.benchH + 0.02;
        pos.push(Math.cos(a) * rTop, yTop, Math.sin(a) * rTop);
        pos.push(Math.cos(a) * rBot, yBot, Math.sin(a) * rBot);
        const band = 0.5 + 0.5 * Math.sin(a * 6 + i * 1.9);
        top.copy(cTop).lerp(cMid, 0.18 + 0.3 * band);
        bot.copy(cBot).lerp(cMid, 0.35 * band);
        col.push(top.r, top.g, top.b, bot.r, bot.g, bot.b);
      }
      for (let k = 0; k < COUNT; k++) {
        const p = base + k * 2;
        const mx = (pos[p * 3] + pos[(p + 1) * 3] + pos[(p + 2) * 3] + pos[(p + 3) * 3]) / 4;
        const mz = (pos[p * 3 + 2] + pos[(p + 1) * 3 + 2] + pos[(p + 2) * 3 + 2] + pos[(p + 3) * 3 + 2]) / 4;
        if (inRampCut(mx, mz)) continue;
        idx.push(p, p + 1, p + 3, p, p + 3, p + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const wall = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
      flatShading: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    wall.receiveShadow = true;
    wall.castShadow = true;
    wall.name = 'benchWall';
    this.benchWall = wall;
    this.scene.add(wall);
  }

  // 道路分层：路肩 → 路面 → 车辙 → 边线（坡道另加挡车埂）
  buildRoads() {
    const world = this.world;
    const pos = [];
    const col = [];
    const idx = [];
    const lpos = [];
    const lcol = [];
    const lidx = [];
    let vi = 0;
    let li = 0;

    const COL = {
      surface: new THREE.Color(0x5c6265),
      ramp: new THREE.Color(0x4a5155),
      bench: new THREE.Color(0x6a6459),
      station: new THREE.Color(0x54595b),
      road: new THREE.Color(0x606662),
      shoulder: new THREE.Color(0x7c7059),
      rut: new THREE.Color(0x332f2b),     // 车辙印：深色压实带，比路面略低
      berm: new THREE.Color(0x857a63),
    };

    // 节点法线：取相邻两段方向的均值，使折线接头处共用一条法线，
    // 避免逐段四边形在拐点处相互交叠而出现“小扇形 / 网状”瑕疵
    const nodeNormals = (list) => list.map((_, i) => {
      const prev = list[Math.max(0, i - 1)];
      const next = list[Math.min(list.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      return { nx: -dz / len, nz: dx / len };
    });

    // 连续条带：沿整条道路一次成型，相邻段共享边界，不再出现重叠或缝隙
    const band = (list, nrm, oA, oB, yA, yB, color) => {
      if (list.length < 2) return;
      let aO = oA, bO = oB, aY = yA, bY = yB;
      if (aO > bO) { aO = oB; bO = oA; aY = yB; bY = yA; }
      const base = vi;
      for (let i = 0; i < list.length; i++) {
        const A = list[i];
        const n = nrm[i];
        const sh = 0.94 + hash(i, list.length) * 0.12;
        pos.push(A.x + n.nx * aO, A.y + aY, A.z + n.nz * aO);
        pos.push(A.x + n.nx * bO, A.y + bY, A.z + n.nz * bO);
        col.push(color.r * sh, color.g * sh, color.b * sh);
        col.push(color.r * sh, color.g * sh, color.b * sh);
        vi += 2;
      }
      for (let i = 0; i < list.length - 1; i++) {
        const v = base + i * 2;
        idx.push(v, v + 1, v + 3, v, v + 3, v + 2);
      }
    };

    for (const road of world.roads) {
      const base = COL[road.kind] || COL.road;
      const hw = road.width / 2;
      const list = road.pts.map((i) => world.nodes[i]);
      if (list.length < 2) continue;
      const nrm = nodeNormals(list);
      // 路肩 → 路面 → 车辙（土路无白色标线）
      band(list, nrm, -(hw + 5), hw + 5, 0.06, 0.06, COL.shoulder);
      band(list, nrm, -hw, hw, 0.22, 0.22, base);
      band(list, nrm, -hw * 0.58 - 1.6, -hw * 0.58 + 1.6, 0.26, 0.26, COL.rut);
      band(list, nrm, hw * 0.58 - 1.6, hw * 0.58 + 1.6, 0.26, 0.26, COL.rut);
      if (road.kind === 'ramp') {
        // 坡道两侧挡车埂
        band(list, nrm, hw + 2.4, hw + 4.2, 0.95, 0.95, COL.berm);
        band(list, nrm, -(hw + 4.2), -(hw + 2.4), 0.95, 0.95, COL.berm);
      } else if (road.kind === 'bench' || road.kind === 'road') {
        // 台段道路仅靠坑一侧设挡车埂；地表环道不设，避免坑口出现小扇形凸起
        let acc = 0;
        for (let i = 0; i < list.length; i++) acc += nrm[i].nx * list[i].x + nrm[i].nz * list[i].z;
        const s = acc >= 0 ? -1 : 1;
        band(list, nrm, s * (hw + 0.7), s * (hw + 1.9), 0.12, 1.0, COL.berm);
        band(list, nrm, s * (hw + 1.9), s * (hw + 3.1), 1.0, 0.12, COL.berm);
      }
    }

    // 坡道边界桩：两侧每 32m 一根，顶端反光片
    const posts = [];
    for (const road of world.roads) {
      if (road.kind !== 'ramp') continue;
      const hw = road.width / 2;
      let acc = 14;
      for (let i = 0; i < road.pts.length - 1; i++) {
        const A = world.nodes[road.pts[i]];
        const B = world.nodes[road.pts[i + 1]];
        const dx = B.x - A.x;
        const dz = B.z - A.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.2) continue;
        const nx = -dz / len;
        const nz = dx / len;
        for (let s = acc; s < len; s += 32) {
          const t = s / len;
          for (const side of [-1, 1]) {
            posts.push({
              x: A.x + dx * t + nx * side * (hw + 1.1),
              y: A.y + (B.y - A.y) * t,
              z: A.z + dz * t + nz * side * (hw + 1.1),
            });
          }
        }
        acc = Math.max(0, acc - len) % 32;
        if (acc === 0) acc = 32 - (len % 32);
      }
    }
    if (posts.length) {
      const postGeo = new THREE.BoxGeometry(0.16, 1.15, 0.16);
      const postMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d4, roughness: 0.62 });
      const capGeo = new THREE.BoxGeometry(0.22, 0.18, 0.22);
      const capMat = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffa33a, emissiveIntensity: 1.4 });
      const inst = new THREE.InstancedMesh(postGeo, postMat, posts.length);
      const caps = new THREE.InstancedMesh(capGeo, capMat, posts.length);
      const m = new THREE.Matrix4();
      posts.forEach((p, i) => {
        m.makeTranslation(p.x, p.y + 0.58, p.z);
        inst.setMatrixAt(i, m);
        m.makeTranslation(p.x, p.y + 1.02, p.z);
        caps.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      caps.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      this.scene.add(inst, caps);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.93, metalness: 0.03,
      polygonOffset: true, polygonOffsetFactor: -2,
    }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
    lgeo.setAttribute('color', new THREE.Float32BufferAttribute(lcol, 3));
    lgeo.setIndex(lidx);
    const lmesh = new THREE.Mesh(lgeo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.42, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4,
    }));
    this.scene.add(lmesh);
  }

  // 工作面沿台段轮廓的清理平台（弯曲带状，贴合台阶）
  buildFacePad(face) {
    const pit = this.world.pit;
    const bayAng = face.bay.angle;
    const q0 = face.queueSlots[0];
    let da = Math.atan2(q0.z, q0.x) - bayAng;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const dpm = da / 36;
    const half = 23;
    const samples = 22;
    const from = -46;
    const to = 244;
    const pos = [];
    const idx = [];
    let v = 0;
    for (let i = 0; i <= samples; i++) {
      const s = from + ((to - from) * i) / samples;
      const a = bayAng + dpm * s;
      const r = levelRadius(a, face.level, pit) - 26;
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      pos.push(
        cx - nx * half, face.y + 0.07, cz - nz * half,
        cx + nx * half, face.y + 0.07, cz + nz * half
      );
      if (i > 0) {
        const p = v - 2;
        idx.push(p, p + 1, v + 1, p, v + 1, v);
      }
      v += 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: face.ore ? 0x2a201a : 0x8a806b,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    const pad = new THREE.Mesh(geo, mat);
    pad.receiveShadow = true;
    this.scene.add(pad);
    return pad;
  }

  buildFacilities() {
    for (const f of this.world.faces) {
      this.buildFacePad(f);
      const yard = createFaceYard(f);
      this.scene.add(yard.group);
      this.facePads.set(f.id, yard);

      const s = createShovel(f.id);
      s.group.position.set(f.shovel.x, f.y + 0.12, f.shovel.z);
      s.group.rotation.y = f.shovel.heading;
      s.group.userData.facility = { id: f.id, type: 'shovel' };
      this.scene.add(s.group);
      this.shovelRefs.set(f.id, s);
    }

    for (const st of this.world.stations) {
      const ref = createStation(st);
      ref.group.userData.facility = { id: st.id, type: 'station' };
      this.scene.add(ref.group);
      this.stationRefs.set(st.id, ref);
    }

    // 卸载点按世界模型批量创建：矿石 → 破碎站，废岩 → 排土场
    for (const d of this.world.dumps.list) {
      const ref = d.type === 'waste'
        ? createWasteDump({ x: d.x, z: d.z })
        : createCrusher({ x: d.x, z: d.z });
      const type = d.type === 'waste' ? 'waste' : 'crusher';
      ref.group.userData.facility = { id: d.id, type };
      this.scene.add(ref.group);
      this.dumpRefs.set(d.id, ref);
    }

    // 远景能源设施：南侧火电厂、东北光伏电站、西侧风电场 + 高压输电走廊
    for (const f of this.world.facilities || []) {
      if (f.kind === 'thermal') {
        this.scene.add(createThermalPlant(f).group);
      } else if (f.kind === 'solar') {
        this.scene.add(createSolarFarm(f).group);
      } else if (f.kind === 'wind') {
        const ref = createWindFarm(f);
        this.scene.add(ref.group);
        this.windRotors.push(...ref.rotors);
      }
    }
    if (this.world.hvLine) this.scene.add(createPylonLine(this.world.hvLine.pts));
  }

  buildVehicles() {
    const TRUCK_SCALE = 1.28;
    for (let i = 0; i < this.world.config.truck.count; i++) {
      const id = `T-${101 + i}`;
      const ref = createTruck(id, TRUCK_ACCENTS[i % TRUCK_ACCENTS.length], i);
      const sp = this.world.spawnPoints[i];
      ref.group.scale.setScalar(TRUCK_SCALE);
      ref.group.position.set(sp.x, sp.y || 0, sp.z);
      ref.heading = 0;
      ref.label.userData.draw(id, '待命');
      ref.trackPtsL = [];
      ref.trackPtsR = [];
      ref.trackMeshL = null;
      ref.trackMeshR = null;
      this.scene.add(ref.group);
      this.truckRefs.set(id, ref);
    }
  }

  buildDust() {
    const count = 180;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = 0.82;
      colors[i * 3 + 1] = 0.75;
      colors[i * 3 + 2] = 0.62;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.PointsMaterial({
      size: 9,
      map: texture,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      vertexColors: true,
      sizeAttenuation: true,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dustSeeds = Array.from({ length: count }, (_, i) => ({
      truck: i % Math.max(1, this.truckRefs.size),
      back: 5 + hash(i, 2) * 17,
      side: (hash(i, 4) - 0.5) * 13,
      up: 0.4 + hash(i, 6) * 4,
      phase: hash(i, 8) * Math.PI * 2,
    }));
    this.scene.add(this.dust);
  }

  // 天气粒子：雪 / 雨 / 风沙（扬尘复用矿卡 dust）
  buildWeather() {
    const N = 900;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 1600;
      pos[i * 3 + 1] = Math.random() * 220;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 1600;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.weatherParticles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 2.4, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true,
    }));
    this.weatherParticles.frustumCulled = false;
    this.weatherParticles.visible = false;
    this.scene.add(this.weatherParticles);
    this.weatherVel = vel;
    this.weatherN = N;
  }

  updateWeather(dt) {
    const w = (this.state && this.state.weather) || 'clear';
    const fx = this.weatherFX;
    if (!fx) return;

    // ---- 粒子（雨/雪/风沙） ----
    const particleActive = w === 'snow' || w === 'rain' || w === 'sandstorm';
    this.weatherParticles.visible = particleActive;
    if (particleActive) {
      const mat = this.weatherParticles.material;
      const pos = this.weatherParticles.geometry.attributes.position.array;
      if (w === 'snow') { mat.color.setHex(0xf6f9ff); mat.opacity = 0.85; mat.size = 3.2; }
      else if (w === 'rain') { mat.color.setHex(0xbcd0de); mat.opacity = 0.5; mat.size = 1.8; }
      else { mat.color.setHex(0xd8b878); mat.opacity = 0.7; mat.size = 3.4; }
      const fall = w === 'rain' ? 140 : w === 'sandstorm' ? 55 : 16;
      const windX = w === 'sandstorm' ? 110 : w === 'snow' ? 14 : 4;
      for (let i = 0; i < this.weatherN; i++) {
        pos[i * 3] += windX * dt + (Math.random() - 0.5) * 2;
        pos[i * 3 + 1] -= fall * dt;
        pos[i * 3 + 2] += (Math.random() - 0.5) * 3;
        if (pos[i * 3 + 1] < -10) {
          pos[i * 3] = (Math.random() - 0.5) * 1800;
          pos[i * 3 + 1] = 220 + Math.random() * 60;
          pos[i * 3 + 2] = (Math.random() - 0.5) * 1800;
        }
      }
      this.weatherParticles.geometry.attributes.position.needsUpdate = true;
    }

    // ---- 太阳（仅晴天/风天可见） ----
    fx.sun.visible = w === 'clear' || w === 'wind';

    // ---- 扬尘粒子（扬尘/风沙启用） ----
    fx.dust.visible = w === 'dust' || w === 'sandstorm';
    if (fx.dust.visible) {
      const dpos = fx.dust.geometry.attributes.position.array;
      const strong = w === 'sandstorm';
      const amp = strong ? 26 : 12;
      for (let i = 0; i < fx.dustN; i++) {
        dpos[i * 3] += (Math.random() - 0.5) * amp * dt * 6;
        dpos[i * 3 + 2] += (Math.random() - 0.5) * amp * dt * 6;
      }
      fx.dust.geometry.attributes.position.needsUpdate = true;
    }

    // ---- 风粒子（大风/风沙） ----
    fx.wind.visible = w === 'wind' || w === 'sandstorm';
    if (fx.wind.visible) {
      const wpos = fx.wind.geometry.attributes.position.array;
      const ws = w === 'sandstorm' ? 320 : 180;
      for (let i = 0; i < fx.windN; i++) {
        wpos[i * 3] += ws * dt;
        wpos[i * 3 + 2] += (Math.random() - 0.5) * 40 * dt;
        if (wpos[i * 3] > 900) {
          wpos[i * 3] = -900;
          wpos[i * 3 + 1] = 8 + Math.random() * 60;
          wpos[i * 3 + 2] = (Math.random() - 0.5) * 1600;
        }
      }
      fx.wind.geometry.attributes.position.needsUpdate = true;
    }

    // ---- 地面积水（降雨） ----
    fx.puddles.visible = w === 'rain';

    // ---- 地面积雪（降雪） ----
    fx.snow.visible = w === 'snow';

    // ---- 雾（风沙/扬尘降低能见度） ----
    const fog = this.scene.fog;
    if (w === 'sandstorm') {
      fog.color.setHex(0xc9a86a); fog.near = 180; fog.far = 720;
    } else if (w === 'dust') {
      fog.color.setHex(0xb8a878); fog.near = 600; fog.far = 2200;
    } else if (w === 'rain') {
      fog.color.setHex(0x8a98a2); fog.near = 900; fog.far = 3200;
    } else if (w === 'snow') {
      fog.color.setHex(0xdfe6ec); fog.near = 700; fog.far = 2600;
    } else {
      fog.color.setHex(0xd8e0e2); fog.near = 2300; fog.far = 5800;
    }

    // ---- 地表材质着色（积雪泛白 / 降雨湿暗） ----
    const tm = this.terrainMat;
    if (w === 'snow') {
      tm.color.setHex(0xcdd6dc); tm.roughness = 0.85;
    } else if (w === 'rain') {
      tm.color.setHex(0x6b7276); tm.roughness = 0.55; tm.metalness = 0.08;
    } else {
      tm.color.setHex(0xffffff); tm.roughness = 0.98; tm.metalness = 0.02;
    }
  }

  // 天气视觉特效：太阳 / 扬尘 / 风 / 积水 / 积雪
  buildWeatherFX() {
    const fx = {};

    // 太阳：加法混合光晕 Sprite，不受雾影响
    const sunCanvas = document.createElement('canvas');
    sunCanvas.width = sunCanvas.height = 256;
    const sctx = sunCanvas.getContext('2d');
    const grad = sctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,248,220,1)');
    grad.addColorStop(0.25, 'rgba(255,220,140,0.95)');
    grad.addColorStop(0.55, 'rgba(255,180,80,0.5)');
    grad.addColorStop(1, 'rgba(255,160,60,0)');
    sctx.fillStyle = grad; sctx.fillRect(0, 0, 256, 256);
    const sunTex = new THREE.CanvasTexture(sunCanvas);
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sunTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    sun.position.set(-1500, 1400, 1100);
    sun.scale.set(520, 520, 1);
    this.scene.add(sun);
    fx.sun = sun;

    // 扬尘粒子（弥漫地表的黄褐色尘埃）
    const DN = 600;
    const dpos = new Float32Array(DN * 3);
    for (let i = 0; i < DN; i++) {
      dpos[i * 3] = (Math.random() - 0.5) * 1800;
      dpos[i * 3 + 1] = Math.random() * 70;
      dpos[i * 3 + 2] = (Math.random() - 0.5) * 1800;
    }
    const dust = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(dpos, 3)),
      new THREE.PointsMaterial({ color: 0xc8a86a, size: 7, transparent: true, opacity: 0.18, depthWrite: false, sizeAttenuation: true })
    );
    dust.frustumCulled = false;
    dust.visible = false;
    this.scene.add(dust);
    fx.dust = dust; fx.dustN = DN;

    // 风粒子（横向飞过的细线/光点）
    const WN = 400;
    const wpos = new Float32Array(WN * 3);
    for (let i = 0; i < WN; i++) {
      wpos[i * 3] = (Math.random() - 0.5) * 1800;
      wpos[i * 3 + 1] = 8 + Math.random() * 80;
      wpos[i * 3 + 2] = (Math.random() - 0.5) * 1600;
    }
    const wind = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(wpos, 3)),
      new THREE.PointsMaterial({ color: 0xcfe0e8, size: 2.2, transparent: true, opacity: 0.5, depthWrite: false, sizeAttenuation: true })
    );
    wind.frustumCulled = false;
    wind.visible = false;
    this.scene.add(wind);
    fx.wind = wind; fx.windN = WN;

    // 地面积水（降雨时的蓝色水坑）
    const puddles = new THREE.Group();
    const puddleGeo = new THREE.CircleGeometry(1, 24);
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 200 + Math.random() * 1300;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const m = new THREE.Mesh(puddleGeo, new THREE.MeshStandardMaterial({
        color: 0x4a6a7e, transparent: true, opacity: 0.42, roughness: 0.15, metalness: 0.4, depthWrite: false,
      }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(px, 0.15, pz);
      m.scale.setScalar(14 + Math.random() * 30);
      puddles.add(m);
    }
    puddles.visible = false;
    this.scene.add(puddles);
    fx.puddles = puddles;

    // 地面积雪（半透明白色覆盖，模拟积雪路面）
    const snow = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 3600, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xeef3f7, transparent: true, opacity: 0.55, roughness: 0.95, depthWrite: false })
    );
    snow.rotation.x = -Math.PI / 2;
    snow.position.y = 0.18;
    snow.visible = false;
    this.scene.add(snow);
    fx.snow = snow;

    this.weatherFX = fx;
  }

  buildSelection() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(9, 12.5, 44),
      new THREE.MeshBasicMaterial({ color: 0x56e1ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    this.scene.add(ring);
    this.selectionRing = ring;
  }

  // 选中矿车的计划行驶路线：GTI 式地面发光导航带
  buildRoute() {
    this.routeGroup = new THREE.Group();
    this.routeGroup.visible = false;
    this.scene.add(this.routeGroup);
  }

  // 矿卡行驶车辙印：两道黑色压实带，随车辆移动动态铺设
  buildTracks() {
    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);
    this.trackMat = new THREE.MeshBasicMaterial({
      color: 0x1a1612, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  makeTrackRibbon(pts) {
    if (pts.length < 2) return null;
    const W = 1.1; // 单条车辙半宽
    const positions = [];
    const indices = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next.x - prev.x, dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      positions.push(p.x + nx * W, p.y, p.z + nz * W);
      positions.push(p.x - nx * W, p.y, p.z - nz * W);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const v = i * 2;
      indices.push(v, v + 1, v + 3, v, v + 3, v + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }

  // 导航带逐帧绘制：引擎已把车道 + 车辙轨位偏移烘焙进 pathPts，
  // 这里直接按路径点铺带，不再做二次车道偏移
  showRoute(points, from) {
    while (this.routeGroup.children.length) {
      const m = this.routeGroup.children.pop();
      if (m.geometry) m.geometry.dispose();
    }
    if (!points || points.length < 2) { this.routeGroup.visible = false; return; }
    const raw = [];
    if (from) raw.push([from.x, from.y, from.z]);
    // pathPts 为 [x,y,z] 数组（引擎侧已做圆角平滑，条带与实际行驶轨迹一致）
    for (const p of points) raw.push(p);
    if (raw.length < 2) { this.routeGroup.visible = false; return; }
    const pts = [];
    for (const p of raw) pts.push(new THREE.Vector3(p[0], p[1] + 1.0, p[2]));

    // 发光导航带（沿路径的扁平 ribbon，抬高 1m 避免与路面共面而被深度缓冲吞掉）
    const build = (W, color, opacity, lift) => {
      const rpos = [];
      const ridx = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const dx = next.x - prev.x, dz = next.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len, nz = dx / len;
        rpos.push(p.x + nx * W, p.y + lift, p.z + nz * W);
        rpos.push(p.x - nx * W, p.y + lift, p.z - nz * W);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const v = i * 2;
        ridx.push(v, v + 1, v + 3, v, v + 3, v + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(rpos, 3));
      g.setIndex(ridx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      }));
      m.renderOrder = 5;
      this.routeGroup.add(m);
    };
    // 外圈光晕 + 主带，保证远距离与浅色路面上都能看清整条路线
    build(9.5, 0x1fa8d8, 0.22, 0.02);
    build(6.2, 0x28d6ff, 0.62, 0.06);

    // 中心亮线
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xcaf6ff, transparent: true, opacity: 0.95 })
    );
    line.renderOrder = 6;
    this.routeGroup.add(line);

    this.routeGroup.visible = true;
  }

  bindPointer() {
    const c = this.canvas;
    this.drag = null;
    this.dragged = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.drag = { x: e.clientX, y: e.clientY, button: e.button };
      this.dragged = 0;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
        this.dragged += Math.abs(dx) + Math.abs(dy);
        if (this.drag.button === 0) {
          if (this.freeCam) {
            this.freeYaw -= dx * 0.0035;
            this.freePitch = clamp(this.freePitch - dy * 0.0035, -1.4, 1.4);
          } else {
            if (this.focus) {
              this.focus = false;
              this.follow = false;
              this.onFollow(false);
            }
            this.theta -= dx * 0.0045;
            this.phi = clamp(this.phi - dy * 0.0038, 0.06, 1.45);
          }
        } else {
          const s = this.radius * 0.0016;
          const rx = Math.cos(this.theta);
          const rz = -Math.sin(this.theta);
          const fx = -Math.sin(this.theta);
          const fz = -Math.cos(this.theta);
          this.target.x -= rx * dx * s - fx * dy * s;
          this.target.z -= rz * dx * s - fz * dy * s;
        }
      } else {
        this.handleHover(e);
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (this.drag && this.dragged < 16 && this.drag.button === 0) this.pick(e);
      this.drag = null;
    });
    c.addEventListener('pointerleave', () => {
      this.drag = null;
      this.onHover(null, 0, 0);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.freeCam) {
        this.freeSpeed = clamp(this.freeSpeed * Math.exp(-e.deltaY * 0.0015), 30, 1200);
      } else if (this.focus) {
        this.followDist = clamp(this.followDist * Math.exp(e.deltaY * 0.0012), 24, 170);
        this.followHeight = clamp(this.followHeight + e.deltaY * 0.02, 10, 90);
      } else {
        this.radius = clamp(this.radius * Math.exp(e.deltaY * 0.0011), 120, 3200);
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
  }

  handleHover(e) {
    const now = performance.now();
    if (now - this.lastHover < 90) return;
    this.lastHover = now;
    const res = this.pickId(e);
    const id = res && res.kind === 'truck' ? res.id : null;
    this.onHover(id, e.clientX, e.clientY);
  }

  pickId(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const groups = [];
    this.truckRefs.forEach((ref) => groups.push(ref.group));
    this.shovelRefs.forEach((ref) => groups.push(ref.group));
    this.stationRefs.forEach((ref) => groups.push(ref.group));
    this.dumpRefs.forEach((ref) => groups.push(ref.group));
    const hits = this.raycaster.intersectObjects(groups, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o) {
        if (o.userData && o.userData.truckId) return { kind: 'truck', id: o.userData.truckId };
        if (o.userData && o.userData.facility) return { kind: 'facility', id: o.userData.facility.id, type: o.userData.facility.type };
        o = o.parent;
      }
    }
    return null;
  }

  pick(e) {
    const res = this.pickId(e) || this.pickFacilityByScreen(e);
    if (!res) return;
    if (res.kind === 'truck') this.focusTruck(res.id);
    else if (res.kind === 'facility') this.focusFacility(res.id, res.type);
  }

  // 屏幕空间兜底：射线未命中时，按点击点与设施投影中心的屏幕距离选取
  pickFacilityByScreen(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const v = new THREE.Vector3();
    const candidates = [];
    const add = (id, type, pos) => {
      if (!pos) return;
      v.set(pos.x, pos.y + 4, pos.z).project(this.camera);
      if (v.z > 1) return;
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < 110) candidates.push({ id, type, d });
    };
    this.shovelRefs.forEach((s) => add(s.group.userData.facility.id, 'shovel', s.group.position));
    this.stationRefs.forEach((s) => add(s.group.userData.facility.id, 'station', s.group.position));
    this.dumpRefs.forEach((ref) => add(ref.group.userData.facility.id, ref.group.userData.facility.type, ref.group.position));
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.d - b.d);
    return { kind: 'facility', id: candidates[0].id, type: candidates[0].type };
  }

  // 点击设施：视角锁定到该设施
  focusFacility(id, type) {
    this.setSelected(null, false);
    this.freeCam = false;
    this.focus = false;
    this.follow = false;
    this.onFollow(false);
    let pos = null;
    if (type === 'shovel') {
      const s = this.shovelRefs.get(id);
      if (s) pos = s.group.position;
    } else if (type === 'station') {
      const st = this.stationRefs.get(id);
      if (st) pos = st.group.position;
    } else if (type === 'crusher' || type === 'waste') {
      const d = this.dumpRefs.get(id);
      if (d) pos = d.group.position;
    }
    if (!pos) return;
    this.target.set(pos.x, pos.y, pos.z);
    this.theta = 2.4;
    this.phi = 0.82;
    this.radius = 180;
    if (this.onSelectFacility) this.onSelectFacility(id, type);
  }

  setSelected(id, notify = true) {
    if (this.selected && this.selected !== id) {
      const prev = this.truckRefs.get(this.selected);
      if (prev) prev.label.visible = true;
    }
    this.selected = id;
    this.selectionRing.visible = !!id;
    if (!id) {
      this.focus = false;
      this.follow = false;
      this.onFollow(false);
    }
    if (notify) this.onSelect(id);
  }

  // 点击车辆：主视角直接锁定到该车三维结构后方
  focusTruck(id) {
    this.setSelected(id, false);
    if (!id) return;
    const ref = this.truckRefs.get(id);
    if (!ref) return;
    this.focus = true;
    this.follow = true;
    this.followDist = 44;
    this.followHeight = 15;
    this.followSide = 7;
    this.target.copy(ref.group.position);
    const h = ref.heading || 0;
    this.camera.position.set(
      ref.group.position.x - Math.sin(h) * this.followDist + Math.cos(h) * this.followSide,
      ref.group.position.y + this.followHeight,
      ref.group.position.z - Math.cos(h) * this.followDist - Math.sin(h) * this.followSide
    );
    this.camera.lookAt(
      ref.group.position.x + Math.sin(h) * 18,
      ref.group.position.y + 3.5,
      ref.group.position.z + Math.cos(h) * 18
    );
    this.onFollow(true);
  }

  setFollow(v) {
    this.follow = !!v;
    this.focus = !!v && !!this.selected;
    if (v && this.selected) {
      const ref = this.truckRefs.get(this.selected);
      if (ref) this.target.copy(ref.group.position);
    }
  }

  setView(name) {
    this.freeCam = false;
    this.focus = false;
    this.follow = false;
    this.onFollow(false);
    if (this.drive.on) this.exitDrive(false);
    if (name === 'overview') {
      this.target.set(0, -50, 0); this.theta = 1.3; this.phi = 0.64; this.radius = 2000;
    } else if (name === 'pit') {
      if (this.work) {
        this.target.set(this.work.x, -44, this.work.z);
        this.theta = this.work.theta; this.phi = 0.94; this.radius = 380;
      } else {
        this.target.set(0, -60, 40); this.theta = 2.3; this.phi = 0.94; this.radius = 760;
      }
    } else if (name === 'top') {
      this.target.set(0, -40, 120); this.theta = 0; this.phi = 0.1; this.radius = 1750;
    } else if (name === 'free') {
      this.freeCam = true;
      // 从当前视角初始化自由视角朝向
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.freeYaw = Math.atan2(-dir.x, -dir.z);
      this.freePitch = clamp(Math.asin(dir.y), -1.4, 1.4);
      if (this.onFreeCam) this.onFreeCam(true);
    }
  }

  // ---------- 驾驶模式 ----------
  // 进入驾驶：主视角改为车载/第三人称视角，车辆由键盘人工操控（仿真引擎侧生效）
  enterDrive(id, view = 'front') {
    if (!id) return false;
    const ref = this.truckRefs.get(id);
    if (!ref) return false;
    this.setSelected(id, false);
    this.drive.on = true;
    this.drive.id = id;
    this.drive.view = view;
    this.focus = false;
    this.follow = false;
    this.freeCam = false;
    this.onFollow(false);
    this.target.copy(ref.group.position);
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    return true;
  }

  // 退出驾驶：恢复车体显示与默认视场角，默认回到该车的第三人称跟随视角
  exitDrive(restore = true) {
    if (!this.drive.on) return;
    const id = this.drive.id;
    this.drive.on = false;
    this.drive.id = null;
    const ref = id ? this.truckRefs.get(id) : null;
    if (ref) ref.group.visible = true;
    this.camera.fov = 54;
    this.camera.updateProjectionMatrix();
    if (restore && id) this.focusTruck(id);
  }

  setDriveView(view) {
    this.drive.view = view;
  }

  // 车载视角机位：前/后/左/右摄像头；第三人称只把机位向后拉开，不做四路拼接
  applyDriveCamera() {
    const ref = this.truckRefs.get(this.drive.id);
    if (!ref) return false;
    const p = ref.group.position;
    const h = ref.heading || 0;
    const sn = Math.sin(h), cs = Math.cos(h);
    const view = this.drive.view;
    let lx = 0, ly = 7.2, lz = 9.3;        // 车身局部坐标：x 右、z 前
    let fwd = 120, side = 0, lookY = 3.0;  // 注视点相对车体的前向/侧向偏移
    if (view === 'rear') { lx = 0; ly = 5.4; lz = -10.8; fwd = -90; lookY = 3.2; }
    else if (view === 'left') { lx = -7.2; ly = 4.9; lz = 1.2; fwd = 4; side = -110; lookY = 2.4; }
    else if (view === 'right') { lx = 7.2; ly = 4.9; lz = 1.2; fwd = 4; side = 110; lookY = 2.4; }
    else if (view === 'third') { lx = 0; ly = 16; lz = -42; fwd = 45; side = 0; lookY = 4.0; }
    const camX = p.x + lx * cs + lz * sn;
    const camZ = p.z - lx * sn + lz * cs;
    const lookX = p.x + fwd * sn + side * cs;
    const lookZ = p.z + fwd * cs - side * sn;
    this.camera.up.set(0, 1, 0);
    if (view === 'third') {
      // 第三人称略微平滑，避免手动转向时画面抖动
      this.camera.position.lerp(new THREE.Vector3(camX, p.y + ly, camZ), 0.35);
    } else {
      this.camera.position.set(camX, p.y + ly, camZ);
    }
    this.camera.lookAt(lookX, p.y + lookY, lookZ);
    // 车载视角隐藏自身车体；第三人称保留车身以便观察姿态
    ref.group.visible = view === 'third';
    this.routeGroup.visible = false;
    return true;
  }

  setQuality(low) {
    if (this.lowQuality === low) return;
    this.renderer.shadowMap.enabled = !low;
    this.renderer.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio || 1, 1.35));
    this.renderer.shadowMap.needsUpdate = true;
    this.dust.visible = !low;
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 2 && h > 2) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  setSnapshot(state) {
    this.state = state;
    let selectedPath = null;
    let selectedFrom = null;
    for (const t of state.trucks) {
      this.truckTargets.set(t.id, t);
      const ref = this.truckRefs.get(t.id);
      if (!ref) continue;
      if (t.id === this.selected) {
        // 只显示“将要行驶”的路线：车辆在行驶状态下才绘制，排队/装卸时不出图
        const moving = t.state === 'to_shovel' || t.state === 'to_dump' || t.state === 'to_energy';
        if (t.pathPts && moving) {
          const seg = Math.max(0, Math.min(t.pathPts.length - 1, t.seg || 0));
          // 只取车头前方的路径点：seg 指向车辆当前所在路段的起点（在车后方），
          // 若连同该点一起传入，车尾会多出一截反向蓝带并随 seg 切换而抖动
          let rest = t.pathPts.slice(seg + 1);
          const hd = t.heading || 0;
          const fx = Math.sin(hd), fz = Math.cos(hd);
          const FRONT = 11;   // 车头保险杠距车辆中心的距离
          // 丢弃仍在保险杠平面之内的首段路径点，蓝带一律从车头向前起画
          while (rest.length > 1 && (rest[0][0] - t.x) * fx + (rest[0][2] - t.z) * fz < FRONT) rest.shift();
          selectedPath = rest.length ? rest : [t.pathPts[t.pathPts.length - 1]];
          selectedFrom = { x: t.x + fx * FRONT, y: t.y, z: t.z + fz * FRONT };
        } else {
          selectedPath = null;
          selectedFrom = { x: t.x, y: t.y, z: t.z };
        }
      }
      ref.label.userData.draw(t.id, `${t.stateLabel}${t.targetName ? ' · ' + t.targetName : ''}`);
      ref.state = t.state;
      // 卸车时货厢倾翻
      const targetTip = t.state === 'dumping' ? -0.46 : 0;
      ref.tip = (ref.tip || 0) + (targetTip - (ref.tip || 0)) * 0.22;
      ref.bed.rotation.x = ref.tip;
      // 载荷随载重变化（卸车时随货厢倾翻而减少）
      const pct = clamp(t.payloadPct || 0, 0, 1);
      const tipFade = Math.max(0, 1 + ref.tip / 0.46);
      const showLoad = pct > 0.02 && tipFade > 0.05;
      ref.load.visible = showLoad;
      if (showLoad) {
        ref.load.scale.y = (0.4 + pct * 1.45) * tipFade;
        ref.load.position.y = 0.42 + pct * 0.3;
        ref.loadMat.color.set(t.loadType === 'waste' ? 0x6f6857 : 0x1c1612);
      }
      // 跟随/驾驶模式下收起悬浮标签，避免遮挡视角
      ref.label.visible = !this.focus && !this.drive.on;
    }
    for (const s of state.shovels) {
      const ref = this.shovelRefs.get(s.id);
      if (ref) {
        ref.label.userData.draw(`${s.id} · ${s.stateLabel}`, `队列 ${s.queue} · 已采 ${(s.extracted / 1000).toFixed(1)}kt`);
        ref.label.visible = !this.focus;
      }
      const yard = this.facePads.get(s.id);
      if (yard) {
        yard.label.userData.draw(`${s.id} 装车泊位`, `队列 ${s.queue} · 本班 ${(s.extracted / 1000).toFixed(1)}kt`);
        yard.label.visible = !this.focus;
      }
    }
    for (const st of state.stations) {
      const ref = this.stationRefs.get(st.id);
      if (!ref) continue;
      ref.label.userData.draw(st.name, `排队 ${st.queue} · 满包 ${st.ready}`);
      ref.label.visible = !this.focus;
      st.packs.forEach((p, i) => {
        const pm = ref.packMeshes[i];
        if (!pm) return;
        const color = new THREE.Color();
        if (p.state === 'ready') color.setHSL(0.38, 0.82, 0.52);
        else if (p.state === 'charging') color.setHSL(0.52, 0.8, 0.5);
        else if (p.state === 'waiting') color.setHSL(0.08, 0.9, 0.5);
        else color.setHSL(0.58, 0.55, 0.35);
        if (p.state === 'ready' && p.soc < 80) color.setHSL(0.13, 0.8, 0.5);
        pm.glowMat.emissive.copy(color);
        pm.lightMat.emissive.copy(color);
        pm.glowMat.emissiveIntensity = p.state === 'charging' ? 1.8 : p.state === 'ready' ? 1.5 : 0.8;
        pm.lightMat.emissiveIntensity = p.state === 'charging' ? 2.6 : 1.6;
      });
    }
    for (const d of state.dumps) {
      const ref = this.dumpRefs.get(d.id);
      if (!ref) continue;
      ref.label.userData.draw(d.name, `卸车排队 ${d.queue}`);
      ref.label.visible = !this.focus;
    }
    if (this.selected && selectedPath) this.showRoute(selectedPath, selectedFrom);
    else this.routeGroup.visible = false;
  }

  updateCamera(dt) {
    // 驾驶模式优先：主视角完全由所选车载摄像头/第三人称机位决定
    if (this.drive.on && this.applyDriveCamera()) return;
    if (this.freeCam) {
      const cp = Math.cos(this.freePitch);
      const sp = Math.sin(this.freePitch);
      const fwd = new THREE.Vector3(-Math.sin(this.freeYaw) * cp, sp, -Math.cos(this.freeYaw) * cp);
      const right = new THREE.Vector3(Math.cos(this.freeYaw), 0, -Math.sin(this.freeYaw));
      const up = new THREE.Vector3(0, 1, 0);
      const move = new THREE.Vector3();
      if (this.keys['KeyW']) move.add(fwd);
      if (this.keys['KeyS']) move.sub(fwd);
      if (this.keys['KeyD']) move.add(right);
      if (this.keys['KeyA']) move.sub(right);
      if (this.keys['KeyE'] || this.keys['Space']) move.add(up);
      if (this.keys['KeyQ'] || this.keys['ShiftLeft']) move.sub(up);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(this.freeSpeed * dt);
      this.camera.position.add(move);
      const look = this.camera.position.clone().add(fwd);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(look);
      return;
    }
    if (this.focus && this.selected) {
      const ref = this.truckRefs.get(this.selected);
      if (ref) {
        const p = ref.group.position;
        const h = ref.heading || 0;
        const speed = clamp((ref.speed || 0) / 14, 0, 1);
        const dist = this.followDist + speed * 10;
        const side = this.followSide;
        const desired = new THREE.Vector3(
          p.x - Math.sin(h) * dist + Math.cos(h) * side,
          p.y + this.followHeight + speed * 2,
          p.z - Math.cos(h) * dist - Math.sin(h) * side
        );
        this.camera.position.lerp(desired, 1 - Math.exp(-dt * 3.6));
        const look = new THREE.Vector3(p.x + Math.sin(h) * 22, p.y + 4.6, p.z + Math.cos(h) * 22);
        this.camera.lookAt(look);
        this.target.copy(p);
        return;
      }
    }
    const sp = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sp * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sp * Math.cos(this.theta)
    );
    this.camera.lookAt(this.target);
  }

  updateTrucks(dt) {
    const k = 1 - Math.exp(-dt * 13);
    const ROAD_Y = 0.22;   // 路面顶面相对节点高度，使车轮贴合路面
    for (const [id, ref] of this.truckRefs) {
      const t = this.truckTargets.get(id);
      if (!t) continue;
      const p = ref.group.position;
      // 侧向偏移已由引擎烘焙进 pathPts / 车辆坐标，渲染层直接使用快照坐标
      const tx = t.x;
      const tz = t.z;
      const ty = t.y + ROAD_Y;
      const dx = tx - p.x;
      const dy = ty - p.y;
      const dz = tz - p.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 260) {
        p.set(tx, ty, tz);
      } else {
        p.x += dx * k;
        p.y += dy * k;
        p.z += dz * k;
      }
      let dh = t.heading - ref.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      ref.heading = (ref.heading || 0) + dh * k;
      ref.group.rotation.y = ref.heading;
      ref.speed = t.v;
      // 标签随视距缩放，远景下仍可辨认车号与状态
      const camD = this.camera.position.distanceTo(p);
      const ls = clamp(camD / 620, 0.58, 1.28);
      ref.label.scale.set(12.5 * ls, 2.75 * ls, 1);
      // 车轮滚动
      const spin = (t.v * dt) / 1.9;
      if (spin > 0.0001) {
        for (const w of ref.wheels) w.rotation.x -= spin;
      }
      // 车辙印：后轮两道黑色压实带，移动超过阈值才采样
      if (t.v > 0.2) {
        const hh = ref.heading || 0;
        const fwd = { x: Math.sin(hh), z: Math.cos(hh) };
        const right = { x: Math.cos(hh), z: -Math.sin(hh) };
        const wheelY = p.y + 0.06; // 略高于路面（路面顶面 0.22），避免被路面盖住
        const rear = -5.7; // 后轮轴位置（车体按 1.28 缩放，后轴 local z=-4.45）
        const halfW = 4.1; // 左右轮距之半（local x=±3.2 缩放后）
        const pL = { x: p.x + fwd.x * rear + right.x * halfW, y: wheelY, z: p.z + fwd.z * rear + right.z * halfW };
        const pR = { x: p.x + fwd.x * rear - right.x * halfW, y: wheelY, z: p.z + fwd.z * rear - right.z * halfW };
        const lastL = ref.trackPtsL[ref.trackPtsL.length - 1];
        if (!lastL || Math.hypot(pL.x - lastL.x, pL.z - lastL.z) > 2.6) {
          ref.trackPtsL.push(pL);
          ref.trackPtsR.push(pR);
          const MAX = 130;
          if (ref.trackPtsL.length > MAX) { ref.trackPtsL.shift(); ref.trackPtsR.shift(); }
          this.updateTrackMesh(ref, 'L');
          this.updateTrackMesh(ref, 'R');
        }
      }
    }
  }

  updateTrackMesh(ref, side) {
    const pts = side === 'L' ? ref.trackPtsL : ref.trackPtsR;
    const key = 'trackMesh' + side;
    if (pts.length < 2) {
      if (ref[key]) { ref[key].visible = false; }
      return;
    }
    const geo = this.makeTrackRibbon(pts);
    if (!geo) return;
    if (!ref[key]) {
      ref[key] = new THREE.Mesh(geo, this.trackMat);
      ref[key].frustumCulled = false;
      this.trackGroup.add(ref[key]);
    } else {
      ref[key].geometry.dispose();
      ref[key].geometry = geo;
      ref[key].visible = true;
    }
  }

  updateShovels(now) {
    if (!this.state) return;
    for (const s of this.state.shovels) {
      const ref = this.shovelRefs.get(s.id);
      if (!ref) continue;
      const amp = s.state === 'loading' ? 0.3 : 0.05;
      ref.boom.rotation.x = Math.sin(now * 0.0035) * amp - 0.52;
      ref.stick.rotation.x = 1.62 + Math.sin(now * 0.0026 + 1.2) * amp * 0.35;
    }
  }

  updateDust(dt) {
    const pos = this.dust.geometry.attributes.position;
    const refs = Array.from(this.truckRefs.values());
    if (!refs.length) return;
    const t = performance.now() * 0.001;
    for (let i = 0; i < this.dustSeeds.length; i++) {
      const seed = this.dustSeeds[i];
      const ref = refs[seed.truck % refs.length];
      if (!ref) continue;
      const h = ref.heading || 0;
      const speed = clamp((ref.speed || 0) / 12, 0, 1);
      const drift = Math.sin(t * 0.8 + seed.phase) * 2.2;
      const back = seed.back + seed.phase * 0.5;
      const p = ref.group.position;
      pos.setXYZ(
        i,
        p.x - Math.sin(h) * back + Math.cos(h) * seed.side + drift,
        p.y + seed.up * (0.4 + speed),
        p.z - Math.cos(h) * back - Math.sin(h) * seed.side + Math.cos(t + seed.phase) * 1.5
      );
      if (speed < 0.05) pos.setY(i, p.y - 30);
    }
    pos.needsUpdate = true;
  }

  updateSelection(now) {
    if (!this.selected) { this.selectionRing.visible = false; return; }
    const ref = this.truckRefs.get(this.selected);
    if (!ref) return;
    // 驾驶模式下车载视角不显示地面选中圈，避免车头画面出现脚下光圈
    this.selectionRing.visible = !(this.drive.on && this.drive.view !== 'third');
    const pulse = 1 + Math.sin(now * 0.004) * 0.08;
    this.selectionRing.scale.setScalar(pulse);
    this.selectionRing.position.set(ref.group.position.x, ref.group.position.y + 0.3, ref.group.position.z);
    this.selectionRing.rotation.z = now * 0.0012;
  }

  // 车载前视摄像头：贴合驾驶室前挡位置，不加入滚转
  renderCab(now, dt = 0.016) {
    if (!this.selected || !this.cabActive) return;
    const ref = this.truckRefs.get(this.selected);
    if (!ref) return;
    const w = this.cabCanvas.clientWidth;
    const h = this.cabCanvas.clientHeight;
    if (w < 4 || h < 4) return;
    if (this.cabW !== w || this.cabH !== h) {
      this.cabRenderer.setSize(w, h, false);
      this.cabCamera.aspect = w / h;
      this.cabCamera.updateProjectionMatrix();
      this.cabW = w;
      this.cabH = h;
    }
    // 驾驶室顶部前视（高机位越过近处台段岩壁，望向远方道路地平线）
    const p = ref.group.position;
    const spd = ref.speed || 0;
    // 仅在行驶时跟踪航向，停车时锁定上一帧朝向，避免装卸/换电时画面翻转
    const targetHd = spd > 0.3 ? (ref.heading || 0) : (ref.cabHeading != null ? ref.cabHeading : (ref.heading || 0));
    const curHd = ref.cabHeading != null ? ref.cabHeading : targetHd;
    let dh = targetHd - curHd;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const maxTurn = 2.2 * dt;   // 限制最大转角，避免 180° 掉头时画面瞬切
    ref.cabHeading = curHd + clamp(dh, -maxTurn, maxTurn);
    const hd = ref.cabHeading;
    const cs = Math.cos(hd);
    const sn = Math.sin(hd);
    // 前视摄像头安装在前保险杠上方：机位完全在车体之外（车头最前端 z≈7.9），
    // 渲染时隐藏自身车体，画面内不再出现任何车身轮廓遮挡
    const lx = 0;
    const ly = 7.2;
    const lz = 9.2;
    const bob = Math.sin(now * 0.009) * 0.08 * clamp(spd / 10, 0, 1);
    const camX = p.x + lx * cs + lz * sn;
    const camZ = p.z - lx * sn + lz * cs;
    const lookFar = spd < 0.4 ? 75 : 140;
    const lookDy = spd < 0.4 ? 2.5 : 0.5;
    this.cabCamera.up.set(0, 1, 0);
    this.cabCamera.position.set(camX, p.y + ly + bob, camZ);
    this.cabCamera.lookAt(
      camX + sn * lookFar,
      p.y + lookDy + bob,
      camZ + cs * lookFar
    );
    // 车载前视：隐藏车身、导航条带与选中圈，保证画面干净
    const routeVis = this.routeGroup.visible;
    const ringVis = this.selectionRing.visible;
    this.routeGroup.visible = false;
    this.selectionRing.visible = false;
    ref.group.visible = false;
    this.cabRenderer.render(this.scene, this.cabCamera);
    ref.group.visible = true;
    this.routeGroup.visible = routeVis;
    this.selectionRing.visible = ringVis;
  }

  // 二维总视角下只推进车辆插值与车载前视渲染，避免整场景重绘
  frameCab(now, dt = 0.016) {
    this.updateTrucks(dt);
    this.renderCab(now, dt);
  }

  frame(now) {
    const dt = Math.min(0.06, this.clock.getDelta());
    this.shadowAcc += dt;
    if (this.shadowAcc > 0.2) {
      this.shadowAcc = 0;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.updateTrucks(dt);
    this.updateCamera(dt);
    this.updateShovels(now);
    this.updateDust(dt);
    this.updateWeather(dt);
    for (const r of this.windRotors) r.rotation.z += dt * 0.9;
    this.updateSelection(now);
    this.renderer.render(this.scene, this.camera);
    this.renderCab(now, dt);
  }

  dispose() {
    this.ro && this.ro.disconnect();
    this.renderer.dispose();
    this.cabRenderer.dispose();
  }
}
