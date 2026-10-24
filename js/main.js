// 控制台主程序：世界模型 → Web Worker 仿真 → Three.js 场景 → 界面联动
import { buildWorld, CONFIG, rimRadius, levelRadius } from './world.js?v=world23';
import { MineScene } from './render/scene.js?v=drive24';
import { Overview2D } from './render/overview2d.js?v=2d9';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

const TAG_LABEL = {
  dispatch: '调度',
  alert: '告警',
  energy: '能源',
  shovel: '采掘',
  load: '装载',
  dump: '卸载',
  haul: '运输',
  system: '系统',
};

const STATE_TONE = {
  idle: 's-idle',
  to_shovel: 's-move',
  to_dump: 's-move',
  to_energy: 's-move',
  queue_shovel: 's-queue',
  queue_dump: 's-queue',
  queue_energy: 's-queue',
  loading: 's-work',
  dumping: 's-work',
  swapping: 's-energy',
  charging: 's-energy',
  stranded: 's-stranded',
  manual: 's-drive',
};

const PACK_LABEL = { ready: '待用', charging: '充电', waiting: '待充', swap: '换装', occupied: '占用' };

// 事件分类：默认只看关键事件，到站/逐车改派等例行日志归入各自分类
const LOG_FILTER = {
  key: (r) => ['system', 'alert', 'shovel'].includes(r.tag) || r.level === 'warn' || r.level === 'critical',
  all: () => true,
  dispatch: (r) => r.tag === 'dispatch' || r.tag === 'system',
  haul: (r) => ['load', 'dump', 'haul', 'shovel'].includes(r.tag),
  energy: (r) => r.tag === 'energy',
  alert: (r) => r.tag === 'alert',
};

const stage = $('stage');
const world = buildWorld();
const cfg = world.config;

// 初始化门禁：三维场景构建完成 + 仿真引擎送出首帧，两者齐备才关闭启动画面
let sceneReady = false;
let firstStateSeen = false;

let scene = null;
let worker = null;
let latest = null;
let selectedId = null;
let lastUi = 0;
let lastChartAt = 0;
let currentSpeed = 2;
let uiTimer = null;

// 驾驶模式状态
let driveOn = false;
let driveView = 'front';
let savedSpeed = null;
let driveResendAt = 0;
const driveKeys = { w: false, s: false, a: false, d: false, shift: false, brake: false };

const DRIVE_VIEW_NAME = {
  front: '前视摄像头', rear: '后视摄像头', left: '左视摄像头', right: '右视摄像头', third: '第三人称视角',
};

// TEMP-DEBUG：驾驶链路排查用，读取当前按键与仿真侧状态
window.__driveState = () => {
  const t = latest && selectedId ? latest.trucks.find((x) => x.id === selectedId) : null;
  return {
    driveOn, selectedId, keys: { ...driveKeys },
    state: t ? t.state : null, manual: t ? t.manual : null,
    v: t ? t.v : null, x: t ? Math.round(t.x) : null, z: t ? Math.round(t.z) : null,
    elapsed: latest ? latest.elapsed : null, paused: latest ? latest.paused : null, speed: currentSpeed,
  };
};

const chartData = [];
const cards = new Map();
let logFilter = 'key';
const logBuf = [];

// ---------------- Three.js 场景 ----------------
try {
  scene = new MineScene({
    canvas: $('gl'),
    cabCanvas: $('cabCanvas'),
    world,
    onSelect: (id) => { if (id) selectTruck(id); },
    onHover: (id, x, y) => showHover(id, x, y),
    onFollow: (v) => syncFollowUI(v),
    onSelectFacility: (id, type) => showFacilityInfo(id, type),
    onFreeCam: (v) => { if (v) toast('自由视角：WASD 移动 · 鼠标拖拽转向 · Q/E 升降 · 滚轮调速'); },
  });
} catch (err) {
  console.error(err);
  window.__bootError = (err && err.stack) || String(err); // TEMP-DEBUG
  setStatus(false, '三维渲染初始化失败');
}
sceneReady = true;
window.__scene = scene; // TEMP-DEBUG

// 2D 总视角：纯 Canvas 平面态势图，与三维场景互斥渲染
let overview2d = null;
try {
  overview2d = new Overview2D($('overview2d'), world, { onSelect: (id) => selectTruck(id) });
  window.__overview2d = overview2d; // TEMP-DEBUG：二维视图排查用
} catch (err) {
  console.error(err);
}

let frameCost = 0;
function loop(now) {
  const t0 = performance.now();
  if (overview2d && overview2d.active) {
    overview2d.frame(now);
    // 二维模式仍保留车载前视画面：只推进车辆插值与该相机渲染，不重绘整场景
    scene && scene.frameCab(now, 0.016);
  } else if (scene) scene.frame(now);
  frameCost = frameCost * 0.85 + (performance.now() - t0) * 0.15;
  fpsTick(now);
  requestAnimationFrame(loop);
}

let fpsFrames = 0;
let fpsAt = performance.now();
let lowSamples = 0;
function fpsTick(now) {
  fpsFrames++;
  if (now - fpsAt > 900) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsAt));
    $('fps').textContent = `${fps} FPS · ${frameCost.toFixed(1)}ms`;
    $('fps').style.color = frameCost > 22 ? '#ffc168' : '';
    if (scene && frameCost > 22) {
      lowSamples++;
      if (lowSamples >= 3) { scene.setQuality(true); lowSamples = 0; }
    } else {
      lowSamples = 0;
    }
    fpsFrames = 0;
    fpsAt = now;
  }
}

function setStatus(ok, text) {
  const box = document.querySelector('.link-status');
  box.classList.toggle('lost', !ok);
  $('statusText').textContent = text || (ok ? '调度链路在线' : '调度链路中断');
}

// ---------------- Worker ----------------
function spawnWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js?v=boot1', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'state') return;
    latest = msg.state;
    if (!firstStateSeen) {
      firstStateSeen = true;
      tryFinishBoot();
    }
    scene && scene.setSnapshot(msg.state);
    overview2d && overview2d.setSnapshot(msg.state);
    appendLogs(msg.logs);
    // 人工驾驶自愈：已进入驾驶但仿真侧仍是自动状态（消息丢失/旧缓存）时补发接管指令
    if (driveOn && selectedId) {
      const mt = msg.state.trucks.find((x) => x.id === selectedId);
      if (mt && !mt.manual) {
        const now = performance.now();
        if (now - driveResendAt > 800) {
          driveResendAt = now;
          worker.postMessage({ type: 'manual', truckId: selectedId, on: true });
        }
      }
    }
    const now = performance.now();
    if (now - lastUi > 180) {
      lastUi = now;
      updateUI(msg.state);
    }
  };
  worker.onerror = (err) => {
    console.error(err);
    setStatus(false, '调度进程异常');
  };
  worker.postMessage({ type: 'init', world, speed: currentSpeed });
  setStatus(true);
}

// ---------------- 界面初始化 ----------------
function buildTruckCards() {
  const strip = $('truckStrip');
  strip.innerHTML = '';
  for (let i = 0; i < cfg.truck.count; i++) {
    const id = `T-${101 + i}`;
    const el = document.createElement('button');
    el.className = 'tcard s-idle';
    el.dataset.id = id;
    el.innerHTML = `
      <div class="tc-top"><b>${id}</b><span class="st">待命</span></div>
      <div class="tc-tgt">无任务</div>
      <div class="tc-bars">
        <div class="tc-bar soc"><i></i></div>
        <div class="tc-bar load"><i></i></div>
      </div>
      <div class="tc-meta"><span class="soc">0%</span><span class="load">0 t</span><span class="spd">0 km/h</span></div>
    `;
    el.addEventListener('click', () => selectTruck(id));
    strip.appendChild(el);
    cards.set(id, {
      el,
      state: el.querySelector('.tc-top .st'),
      tgt: el.querySelector('.tc-tgt'),
      socBar: el.querySelector('.tc-bar.soc i'),
      loadBar: el.querySelector('.tc-bar.load i'),
      socText: el.querySelector('.tc-meta .soc'),
      loadText: el.querySelector('.tc-meta .load'),
      spdText: el.querySelector('.tc-meta .spd'),
    });
  }
}

function buildAssignOptions() {
  const sel = $('cabAssign');
  sel.innerHTML = '';
  const g1 = document.createElement('optgroup');
  g1.label = '采装工作面';
  for (const f of world.faces) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = `${f.id} · ${f.ore ? '矿石' : '废岩'} · ${f.level * cfg.pit.benchH}m 水平`;
    g1.appendChild(o);
  }
  const g2 = document.createElement('optgroup');
  g2.label = '能源站';
  for (const s of world.stations) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.name} · 换电`;
    g2.appendChild(o);
  }
  const g3 = document.createElement('optgroup');
  g3.label = '卸载点';
  for (const d of world.dumps.list) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = `${d.name} · ${d.type === 'waste' ? '废岩排土' : '矿石卸载'}`;
    g3.appendChild(o);
  }
  sel.append(g1, g2, g3);
}

function initUI() {
  buildTruckCards();
  buildAssignOptions();
  $('socRange').value = Math.round(cfg.truck.socSwap * 100);
  $('socValue').textContent = `${Math.round(cfg.truck.socSwap * 100)}%`;

  $('speedGroup').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b) return;
    currentSpeed = Number(b.dataset.speed);
    worker && worker.postMessage({ type: 'speed', value: currentSpeed });
    markGroup($('speedGroup'), b);
  });

  // 右上角：切换二维总视角 / 三维场景
  $('view2dBtn').addEventListener('click', () => set2D(!(overview2d && overview2d.active)));

  $('btnPause').addEventListener('click', () => {
    const paused = latest ? !latest.paused : false;
    worker && worker.postMessage({ type: 'pause', value: paused });
    $('btnPause').classList.toggle('on', paused);
    $('btnPause').textContent = paused ? '继续' : '暂停';
    toast(paused ? '仿真已暂停' : '仿真继续运行');
  });

  $('btnReset').addEventListener('click', () => {
    if (driveOn) {
      driveOn = false;
      resetDriveKeys();
      scene && scene.exitDrive(false);
      savedSpeed = null;
      $('drivePanel').classList.remove('driving');
      $('drivePanel').classList.remove('open');
      $('miniWrap').classList.remove('show');
      $('driveToggle').textContent = '进入驾驶';
    }
    selectedId = null;
    latest = null;
    chartData.length = 0;
    logBuf.length = 0;
    alertSig = null;
    scene && scene.setSelected(null, false);
    overview2d && overview2d.reset();
    overview2d && overview2d.setSelected(null);
    scene && (scene.cabActive = false);
    $('cabPanel').classList.remove('open');
    $('logList').innerHTML = '';
    $('alertsList').innerHTML = '';
    closeCab();
    $('btnPause').classList.remove('on');
    $('btnPause').textContent = '暂停';
    spawnWorker();
    toast('调度引擎已重置，班次重新开始');
  });

  $('btnHelp').addEventListener('click', () => $('helpModal').classList.add('open'));
  $('helpClose').addEventListener('click', () => $('helpModal').classList.remove('open'));
  $('helpModal').addEventListener('click', (e) => {
    if (e.target.id === 'helpModal') $('helpModal').classList.remove('open');
  });

  $('viewGroup').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    markGroup($('viewGroup'), b);
    scene && scene.setView(b.dataset.view);
    setFollow(false);
  });

  $('followBtn').addEventListener('click', () => {
    if (!selectedId) { toast('请先在三维视图或车队条中选择一台矿卡'); return; }
    setFollow(!(scene && scene.follow));
  });

  $('modeGroup').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    markGroup($('modeGroup'), b);
    worker && worker.postMessage({ type: 'mode', value: b.dataset.mode });
  });

  $('weatherGroup').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-weather]');
    if (!b) return;
    markGroup($('weatherGroup'), b);
    worker && worker.postMessage({ type: 'weather', value: b.dataset.weather });
  });

  $('socRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('socValue').textContent = `${v}%`;
    worker && worker.postMessage({ type: 'socReserve', value: v / 100 });
  });

  $('logFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    logFilter = b.dataset.f;
    markGroup($('logFilter'), b);
    renderLogs();
  });

  $('cabClose').addEventListener('click', closeCab);
  $('cabFollow').addEventListener('change', (e) => setFollow(e.target.checked));

  // 左侧面板点击设施 → 切换到该设施观测视角
  const focusFacilityFromList = (e) => {
    const row = e.target.closest('[data-facility]');
    if (!row) return;
    const id = row.dataset.facility;
    const type = row.dataset.type;
    scene && scene.focusFacility(id, type);
  };
  $('shovelList').addEventListener('click', focusFacilityFromList);
  $('dumpList').addEventListener('click', focusFacilityFromList);
  $('stationList').addEventListener('click', focusFacilityFromList);

  $('cabAssignBtn').addEventListener('click', () => {
    if (!selectedId) return;
    const targetId = $('cabAssign').value;
    worker && worker.postMessage({ type: 'assign', truckId: selectedId, targetId });
    toast(`人工指派已下发：${selectedId} → ${$('cabAssign').selectedOptions[0]?.textContent || targetId}`);
  });

  // 驾驶模式：进入/退出 与 视角切换
  $('driveToggle').addEventListener('click', () => {
    if (driveOn) exitDrive();
    else enterDrive(driveView);
  });

  $('driveViews').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cam]');
    if (!b) return;
    const view = b.dataset.cam;
    markGroup($('driveViews'), b);
    driveView = view;
    if (driveOn) {
      scene && scene.setDriveView(view);
      toast(`驾驶视角：${DRIVE_VIEW_NAME[view]}`);
    } else if (selectedId) {
      enterDrive(view);
    }
  });

  // 驾驶时接管键盘（捕获阶段拦截，避免空格触发暂停、WASD 触发自由视角）
  window.addEventListener('keydown', (e) => onDriveKey(e, true), true);
  window.addEventListener('keyup', (e) => onDriveKey(e, false), true);
  // 仅在页面真正隐藏时清空按键：部分浏览器/自动化环境会误触发 window blur，
  // 会把刚按下的 W/S 立刻清掉，表现成“按键完全没反应”
  window.addEventListener('blur', () => {
    if (driveOn && document.hidden) { resetDriveKeys(); sendDrive(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (driveOn && document.hidden) { resetDriveKeys(); sendDrive(); }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      $('btnPause').click();
    } else if (e.key === 'Escape') {
      $('helpModal').classList.remove('open');
      closeCab();
    } else if (e.key === 'f' || e.key === 'F') {
      if (selectedId) setFollow(!(scene && scene.follow));
    }
  });

  window.addEventListener('resize', drawChart);
}

function markGroup(group, btn) {
  group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
}

// ---------------- 仿真状态 → 界面 ----------------
function updateUI(s) {
  $('clock').textContent = s.clock;
  $('shiftBar').style.width = `${(s.shiftProgress * 100).toFixed(1)}%`;
  $('shiftLabel').textContent = `班次进度 ${(s.shiftProgress * 100).toFixed(1)}%`;

  const WEATHER_TEXT = {
    clear: '晴 · 路面干燥 · 限速正常',
    dust: '扬尘 · 能见度下降 · 限速 88%',
    rain: '降雨 · 路面湿滑 · 限速 76%',
    snow: '降雪 · 路面结冰 · 限速 66%',
    wind: '大风 · 侧向风载 · 限速 92%',
    sandstorm: '风沙 · 能见度极低 · 限速 58%',
  };
  $('weatherLabel').textContent = WEATHER_TEXT[s.weather] || WEATHER_TEXT.clear;

  const k = s.kpis;
  $('kpiRate').textContent = fmt(k.productionRate);
  $('kpiTotal').textContent = `${fmt(k.totalTonnes)} t`;
  $('kpiOre').textContent = `${fmt(k.oreTonnes)} t`;
  $('kpiWaste').textContent = `${fmt(k.wasteTonnes)} t`;
  const targetPct = clamp((k.totalTonnes / k.shiftTarget) * 100, 0, 100);
  $('targetPct').textContent = `${targetPct.toFixed(1)}%`;
  $('targetBar').style.width = `${targetPct}%`;

  $('kpiActive').textContent = `${k.activeTrucks}/${s.trucks.length}`;
  $('kpiCycle').innerHTML = k.avgCycle > 0 ? `${k.avgCycle.toFixed(1)}<small>min</small>` : '—';
  $('kpiMatch').textContent = k.avgCycle > 0 ? k.matchFactor.toFixed(2) : '—';
  $('kpiMatch').classList.toggle('warn', k.matchFactor > 1.25);
  $('kpiUtil').textContent = `${k.utilization}%`;
  $('kpiEnergy').innerHTML = `${k.energyPerTonne.toFixed(2)}<small>kWh/t</small>`;
  $('kpiSwaps').textContent = String(k.swaps);

  renderShovels(s);
  renderStations(s);
  renderTrucks(s);
  renderAlerts(s.alerts);
  renderStats(s);
  renderHealth(s.health);

  if (selectedId) updateCab(s);
  updateDrivePanel(s);
  drawMiniMap(s);

  const now = performance.now();
  if (now - lastChartAt > 1000) {
    lastChartAt = now;
    chartData.push(k.productionRate);
    if (chartData.length > 90) chartData.shift();
    drawChart();
  }
}

function renderStats(s) {
  const k = s.kpis;
  $('stActive').textContent = `${k.activeTrucks}/${cfg.truck.count}`;
  $('stCycle').textContent = k.avgCycle > 0 ? `${k.avgCycle.toFixed(1)} min` : '—';
  $('stMatch').textContent = k.avgCycle > 0 ? k.matchFactor.toFixed(2) : '—';
  $('stMatch').classList.toggle('warn', k.matchFactor > 1.25);
  $('stUtil').textContent = `${k.utilization}%`;
  $('stEnergy').textContent = `${k.energyPerTonne.toFixed(2)} kWh/t`;
  $('stQueue').textContent = k.avgQueue > 0 ? `${k.avgQueue.toFixed(1)} min` : '—';
  $('stTrips').textContent = String(k.trips);
  $('stSwaps').textContent = String(k.swaps);
  $('stOre').textContent = `${fmt(k.oreTonnes)} t`;
  $('stWaste').textContent = `${fmt(k.wasteTonnes)} t`;
  const total = k.oreTonnes + k.wasteTonnes;
  $('stMixBar').style.width = `${total ? (k.oreTonnes / total) * 100 : 0}%`;

  // 状态分布
  let moving = 0, work = 0, queue = 0, energy = 0, idle = 0;
  for (const t of s.trucks) {
    if (['to_shovel', 'to_dump', 'to_energy'].includes(t.state)) moving++;
    else if (t.state === 'loading' || t.state === 'dumping') work++;
    else if (t.state.startsWith('queue_')) queue++;
    else if (t.state === 'swapping' || t.state === 'charging') energy++;
    else idle++;
  }
  $('statState').innerHTML = [
    ['行驶', moving], ['作业', work], ['排队', queue], ['补能', energy], ['待命', idle],
  ].map(([n, v]) => `<span>${n}<b>${v}</b></span>`).join('');

  // 调度事件面板顶部的当前态势摘要
  $('logSummary').innerHTML = [
    ['装车', work, false],
    ['行驶', moving, false],
    ['排队', queue, queue > 0],
    ['补能', energy, false],
    ['待命', idle, idle > 6],
    ['告警', s.alerts.length, s.alerts.length > 0],
  ].map(([n, v, hot]) => `<span class="${hot ? 'hot' : ''}">${n}<b>${v}</b></span>`).join('');
}

function renderShovels(s) {
  const wrap = $('shovelList');
  wrap.innerHTML = s.shovels.map((sh) => {
    const busy = ['loading', 'waiting'].includes(sh.state) || sh.queue > 0;
    return `
      <div class="row clickable" data-facility="${sh.id}" data-type="shovel" title="点击切换到 ${sh.name} 视角">
        <i class="dot ${sh.queue > 0 ? 'warn' : 'on'}"></i>
        <div class="nm">
          <b>${sh.name}</b>
          <small>${sh.type === 'ore' ? '矿石' : '废岩'} · ${(sh.level ?? 0) * cfg.pit.benchH}m 水平 · 队列 ${sh.queue}</small>
        </div>
        <div class="rt">${sh.stateLabel}<em>${fmt(sh.extracted)} t</em></div>
      </div>`;
  }).join('');

  $('dumpList').innerHTML = (s.dumps || []).map((d) => `
    <div class="row clickable" data-facility="${d.id}" data-type="${d.type === 'waste' ? 'waste' : 'crusher'}" title="点击切换到 ${d.name} 视角">
      <i class="dot ${d.queue > 0 ? 'warn' : 'on'}"></i>
      <div class="nm"><b>${d.name}</b><small>${d.type === 'waste' ? '废岩排土 · 42s/车' : '矿石卸载 · 55s/车'}</small></div>
      <div class="rt">${d.state === 'busy' ? '卸车中' : '空闲'}<em>队列 ${d.queue}</em></div>
    </div>`).join('');

  if (!wrap.children.length) wrap.innerHTML = '<div class="alert-empty">等待设备状态</div>';
}

function renderStations(s) {
  $('stationList').innerHTML = s.stations.map((st) => {
    const packs = st.packs.map((p) => {
      const cls = p.state === 'ready' ? 'ready' : p.state === 'charging' ? 'charging' : 'waiting';
      const eta = p.state === 'charging'
        ? ` · 余 ${Math.max(1, Math.round(((0.97 - p.soc / 100) * st.packKwh * 60) / st.chargerKw))}min`
        : '';
      return `<div class="pack ${cls}" title="${PACK_LABEL[p.state] || p.state}${eta}"><i style="height:${clamp(p.soc, 0, 100)}%"></i><span>${p.soc}%</span><em>${PACK_LABEL[p.state] || p.state}</em></div>`;
    }).join('');
    const direct = st.stalls.filter(Boolean)
      .map((x) => `· 直充 ${x.truck} ${Math.max(1, Math.round(x.remaining / 60))}min`).join(' ');
    const swap = st.bay ? `· ${st.bay.truck} 换电 ${Math.max(1, Math.round(st.bay.remaining / 60))}min` : '';
    const working = [swap, direct].filter(Boolean).join(' ');
    return `
      <div class="station clickable" data-facility="${st.id}" data-type="station" title="点击切换到 ${st.name} 视角">
        <div class="st-head">
          <b>${st.name}</b>
          <span class="${st.queue > 0 ? 'hot' : ''}">排队 ${st.queue} ${working}</span>
        </div>
        <div class="packs">${packs}</div>
        <div class="st-foot">
          <span>满包 ${st.ready}/${st.packs.length} · 充电位 ${st.chargers} · 已服务 ${st.served}</span>
          <span>均等 ${st.avgWait.toFixed(1)}min</span>
        </div>
      </div>`;
  }).join('');
}

function renderTrucks(s) {
  for (const t of s.trucks) {
    const c = cards.get(t.id);
    if (!c) continue;
    c.el.className = `tcard ${STATE_TONE[t.state] || 's-idle'}${t.id === selectedId ? ' sel' : ''}`;
    c.state.textContent = t.stateLabel;
    c.socBar.style.width = `${clamp(t.soc * 100, 0, 100)}%`;
    c.loadBar.style.width = `${clamp(t.payloadPct * 100, 0, 100)}%`;
    c.socText.textContent = `${Math.round(t.soc * 100)}%`;
    c.loadText.textContent = `${Math.round(t.payload)} t`;
    c.spdText.textContent = `${Math.round(t.v * 3.6)} km/h`;
    c.tgt.textContent = t.targetName || '无任务';
  }
}

let alertSig = null;
function renderHealth(h) {
  if (!h) return;
  const d = h.dims;
  const tone = h.score >= 70 ? 'ok' : h.score >= 50 ? 'mid' : 'bad';
  $('healthBox').innerHTML = `
    <div class="hb-top">
      <span class="hb-label">系统健康度</span>
      <span class="hb-score ${tone}">${h.score} <em>${h.grade}</em></span>
    </div>
    <div class="hb-dims">
      ${[
        ['产能', d.production], ['矿卡', d.truck], ['电铲', d.shovel],
        ['补能', d.energy], ['排队', d.queue], ['告警', d.alert],
      ].map(([n, v]) => `<span title="${n}"><b>${v}</b><i>${n}</i></span>`).join('')}
    </div>`;
}

function renderAlerts(alerts) {
  $('alertCount').textContent = String(alerts.length);
  const sig = alerts.map((a) => `${a.level}:${a.text}`).join('|');
  if (sig === alertSig) return;
  alertSig = sig;
  const wrap = $('alertsList');
  if (!alerts.length) {
    wrap.innerHTML = '<div class="alert-empty">当前无告警，调度状态平稳</div>';
    return;
  }
  wrap.innerHTML = alerts.map((a) => `
    <div class="alert-row ${a.level === 'critical' ? 'critical' : ''}">
      <span>${a.text}</span>
    </div>`).join('');
}

// ---------------- 日志 ----------------
function logRow(rec) {
  const row = document.createElement('div');
  row.className = `log-row lvl-${rec.level || 'info'}`;
  row.title = `${rec.clock} ${TAG_LABEL[rec.tag] || rec.tag}｜${rec.text}`;
  row.innerHTML = `<span class="lt">${rec.clock}</span><span class="tag t-${rec.tag}">${TAG_LABEL[rec.tag] || rec.tag}</span><span class="tx">${rec.text}</span>`;
  return row;
}

function appendLogs(logs) {
  if (!logs || !logs.length) return;
  const wrap = $('logList');
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 60;
  const match = LOG_FILTER[logFilter] || LOG_FILTER.all;
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const rec of logs) {
    if (rec.level === 'trace') continue;
    logBuf.push(rec);
    if (logBuf.length > 260) logBuf.shift();
    if (!match(rec)) continue;
    frag.appendChild(logRow(rec));
    added++;
  }
  if (added) {
    wrap.appendChild(frag);
    while (wrap.children.length > 180) wrap.removeChild(wrap.firstChild);
    if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
    $('logMeta').textContent = `${wrap.children.length} 条事件`;
  }
}

function renderLogs() {
  const wrap = $('logList');
  const match = LOG_FILTER[logFilter] || LOG_FILTER.all;
  wrap.innerHTML = '';
  for (const rec of logBuf) if (match(rec)) wrap.appendChild(logRow(rec));
  while (wrap.children.length > 180) wrap.removeChild(wrap.firstChild);
  wrap.scrollTop = wrap.scrollHeight;
  $('logMeta').textContent = `${wrap.children.length} 条事件`;
}

// ---------------- 车辆选择与驾驶室 ----------------
function selectTruck(id) {
  if (!id) return;
  if (driveOn) exitDrive();
  selectedId = id;
  // 主视角立即锁定该车三维结构
  scene && scene.focusTruck(id);
  scene && (scene.cabActive = true);
  $('cabPanel').classList.add('open');
  // 选中矿车后右下角弹出驾驶模式面板
  $('drivePanel').classList.add('open');
  $('dpTruck').textContent = id;
  cards.forEach((c, cid) => c.el.classList.toggle('sel', cid === id));
  overview2d && overview2d.setSelected(id);
  const card = cards.get(id);
  if (card) card.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  if (latest) updateCab(latest);
  else $('cabTitle').textContent = id;
  if (!$('cabAssign').value) $('cabAssign').value = 'EX-01';
}

// ---------------- 驾驶模式 ----------------
// 进入驾驶：仿真侧切换为人工驾驶状态，主视角切为所选车载/第三人称机位
function enterDrive(view) {
  if (!selectedId) { toast('请先选择一台矿卡'); return; }
  driveView = view || driveView;
  markGroup($('driveViews'), $('driveViews').querySelector(`button[data-cam="${driveView}"]`));
  if (driveOn) {
    scene && scene.setDriveView(driveView);
    toast(`驾驶视角：${DRIVE_VIEW_NAME[driveView]}`);
    return;
  }
  // 先让仿真侧接管：人工驾驶不依赖三维模型是否已加载完成，
  // 否则模型未就绪时 enterDrive 直接返回 false，车辆会继续按自动调度行驶
  driveOn = true;
  resetDriveKeys();
  // 进入驾驶默认 2× 速度；退出时恢复原速度
  if (savedSpeed == null) savedSpeed = currentSpeed;
  currentSpeed = 2;
  worker && worker.postMessage({ type: 'speed', value: 2 });
  worker && worker.postMessage({ type: 'manual', truckId: selectedId, on: true });
  const b = $('speedGroup').querySelector('button[data-speed="2"]');
  if (b) markGroup($('speedGroup'), b);
  // 相机切换到车载/第三人称机位；模型未加载时只提示，不阻断接管
  if (scene) scene.enterDrive(selectedId, driveView);
  $('drivePanel').classList.add('driving');
  $('miniWrap').classList.add('show');
  $('driveToggle').textContent = '退出驾驶';
  toast(`${selectedId} 进入驾驶模式 · ${DRIVE_VIEW_NAME[driveView]}`);
}

function exitDrive() {
  if (!driveOn) return;
  driveOn = false;
  resetDriveKeys();
  worker && worker.postMessage({ type: 'manual', truckId: selectedId, on: false });
  if (savedSpeed != null) {
    currentSpeed = savedSpeed;
    savedSpeed = null;
    worker && worker.postMessage({ type: 'speed', value: currentSpeed });
    const b = $('speedGroup').querySelector(`button[data-speed="${currentSpeed}"]`);
    if (b) markGroup($('speedGroup'), b);
  }
  scene && scene.exitDrive();
  $('drivePanel').classList.remove('driving');
  $('miniWrap').classList.remove('show');
  $('driveToggle').textContent = '进入驾驶';
  toast(`${selectedId} 已退出驾驶模式，交回调度系统`);
}

// ---------------- 2D 总视角 ----------------
// 切换为纯二维态势图：不渲染三维场景，改为绘制路网 / 车辆 / 引导线 / 轨迹 / 站点 / 电量
function set2D(on) {
  if (!overview2d) return;
  if (on && driveOn) exitDrive();
  // 先切 class 让画布可见（display 为 none 时取不到尺寸），再按实际尺寸重建底图
  $('stage').classList.toggle('mode2d', on);
  overview2d.setActive(on);
  overview2d.setSelected(selectedId);
  if (on && latest) overview2d.setSnapshot(latest);
  $('view2dBtn').textContent = on ? '返回三维' : '2D 总览';
  $('view2dBtn').classList.toggle('on', on);
  toast(on ? '已切换为二维总视角 · 点击车辆可与三维联动选中' : '已返回三维视角');
}

function resetDriveKeys() {
  driveKeys.w = driveKeys.s = driveKeys.a = driveKeys.d = driveKeys.shift = driveKeys.brake = false;
}

function sendDrive() {
  worker && worker.postMessage({ type: 'drive', truckId: selectedId, keys: { ...driveKeys } });
}

const DRIVE_KEYMAP = {
  KeyW: 'w', KeyS: 's', KeyA: 'a', KeyD: 'd',
  ShiftLeft: 'shift', ShiftRight: 'shift', Space: 'brake',
};

function onDriveKey(e, down) {
  if (!driveOn) return;
  if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
  if (down && e.code === 'Escape') { e.preventDefault(); exitDrive(); return; }
  const k = DRIVE_KEYMAP[e.code];
  if (!k) return;
  // 驾驶时接管键盘：空格不再触发暂停，WASD 同时用于操控车辆
  e.preventDefault();
  e.stopPropagation();
  if (driveKeys[k] === down) return;
  driveKeys[k] = down;
  sendDrive();
}

function closeCab() {
  if (driveOn) exitDrive();
  scene && (scene.cabActive = false);
  $('cabPanel').classList.remove('open');
  $('drivePanel').classList.remove('open');
  setFollow(false);
}

// 点击设施（电铲/换电站/破碎站/排土场）后展示其运行信息
function showFacilityInfo(id, type) {
  if (driveOn) exitDrive();
  scene && (scene.cabActive = false);
  selectedId = null;
  $('drivePanel').classList.remove('open');
  cards.forEach((c) => c.el.classList.remove('sel'));
  const typeName = { shovel: '电铲', station: '能源站', crusher: '破碎站', waste: '排土场' }[type] || type;
  $('cabTitle').textContent = id;
  $('cabState').textContent = typeName;
  $('cabTag').textContent = `${typeName} · 运行监控`;
  $('cabSpeed').textContent = '—';
  $('cabSoc').textContent = '—'; $('cabSocBar').style.width = '0%';
  $('cabPayload').textContent = '—'; $('cabPayloadBar').style.width = '0%';
  $('cabTarget').textContent = '—';
  $('cabQueue').textContent = '—';
  $('cabPanel').classList.add('open');
  // 用最新状态填充设施详情
  if (latest) {
    let info = '';
    if (type === 'shovel') {
      const s = latest.shovels.find((x) => x.id === id);
      if (s) {
        $('cabState').textContent = s.stateLabel;
        $('cabPayload').textContent = `${s.extracted} t`;
        $('cabPayloadBar').style.width = `${Math.min(100, s.extracted / 300)}%`;
        $('cabTarget').textContent = `队列 ${s.queue} 台`;
        $('cabQueue').textContent = s.busyTruck || '空闲';
        info = `电铲 ${s.id}｜${s.type === 'ore' ? '煤矿' : '废岩'}｜已采 ${s.extracted}t｜队列 ${s.queue}`;
      }
    } else if (type === 'station') {
      const st = latest.stations.find((x) => x.id === id);
      if (st) {
        $('cabState').textContent = st.bay ? '换电中' : '待命';
        $('cabPayload').textContent = `满包 ${st.ready}/${st.packs.length}`;
        $('cabTarget').textContent = `排队 ${st.queue} 台`;
        $('cabQueue').textContent = `已服务 ${st.served}`;
        info = `${st.name}｜排队 ${st.queue}｜满电包 ${st.ready}｜已服务 ${st.served} 次`;
      }
    } else if (type === 'crusher' || type === 'waste') {
      const d = (latest.dumps || []).find((x) => x.id === id);
      if (d) {
        $('cabState').textContent = d.state === 'dumping' ? '卸车中' : '待命';
        $('cabTarget').textContent = `排队 ${d.queue} 台`;
        info = `${d.name}｜队列 ${d.queue}`;
      }
    }
    if (info) toast(info);
  }
}

function updateCab(s) {
  const t = s.trucks.find((x) => x.id === selectedId);
  if (!t) return;
  $('cabTitle').textContent = t.id;
  $('cabDot').style.background = t.state === 'stranded' ? '#ff7272' : t.state === 'queue_shovel' || t.state === 'queue_dump' || t.state === 'queue_energy' ? '#ffc168' : '#52e0a0';
  $('cabDot').style.boxShadow = `0 0 8px ${$('cabDot').style.background}`;
  $('cabState').textContent = t.stateLabel;
  $('cabState').style.color = t.state === 'stranded' ? '#ff9b9b' : '#6fe4ff';
  $('cabSoc').textContent = `${Math.round(t.soc * 100)}%`;
  $('cabSocBar').style.width = `${clamp(t.soc * 100, 0, 100)}%`;
  $('cabPayload').textContent = `${Math.round(t.payload)} / ${cfg.truck.payload} t`;
  $('cabPayloadBar').style.width = `${clamp(t.payloadPct * 100, 0, 100)}%`;
  $('cabTarget').textContent = t.targetName || '无任务';
  $('cabQueue').textContent = t.queueWait >= 60
    ? `${(t.queueWait / 60).toFixed(1)} min`
    : t.queueWait > 1 ? `${Math.round(t.queueWait)} s` : '无';
  $('cabSpeed').textContent = (t.v * 3.6).toFixed(1);
  $('cabTime').textContent = s.clock;
  $('cabTag').title = t.alert || '';
  $('cabTag').textContent = '前视摄像头 · 模拟视频流';
}

function updateDrivePanel(s) {
  if (!selectedId) return;
  const t = s.trucks.find((x) => x.id === selectedId);
  if (!t) return;
  $('dpTruck').textContent = driveOn ? `${t.id} · 人工驾驶 · ${Math.round(t.v * 3.6)} km/h` : `${t.id} · ${t.stateLabel}`;
}

// ---------------- 右上角矿场态势图（含地图坐标） ----------------
const MM_SIZE = 180;
const MM_RANGE = 1900;
let mmBase = null;
let mmDpr = 1;

function mmMapper(S) {
  const s = (S - 22) / (2 * MM_RANGE);
  return {
    s,
    x: (wx) => S / 2 + wx * s,
    y: (wz) => S / 2 - wz * s,
  };
}

function buildMiniBase() {
  const S = MM_SIZE;
  const cvs = document.createElement('canvas');
  cvs.width = Math.round(S * mmDpr);
  cvs.height = Math.round(S * mmDpr);
  const ctx = cvs.getContext('2d');
  ctx.setTransform(mmDpr, 0, 0, mmDpr, 0, 0);
  const m = mmMapper(S);
  ctx.fillStyle = '#071219';
  ctx.fillRect(0, 0, S, S);

  const traceRing = (rFn) => {
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const th = (i / 96) * Math.PI * 2;
      const r = rFn(th);
      const px = m.x(Math.cos(th) * r);
      const py = m.y(Math.sin(th) * r);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
  };

  // 采坑范围填充 + 台段等高线
  traceRing((th) => rimRadius(th));
  ctx.fillStyle = 'rgba(18, 42, 54, 0.9)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(111, 228, 255, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  for (let l = 1; l < CONFIG.pit.levels; l++) {
    traceRing((th) => levelRadius(th, l));
    ctx.strokeStyle = `rgba(111, 228, 255, ${0.2 - l * 0.03})`;
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  // 地表环形运输道
  traceRing((th) => rimRadius(th) + 130);
  ctx.strokeStyle = 'rgba(111, 228, 255, 0.16)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // 东西两端折返坡道
  ctx.beginPath();
  for (const ramp of world.ramps) {
    ramp.pts.forEach((idx, i) => {
      const n = world.nodes[idx];
      const px = m.x(n.x);
      const py = m.y(n.z);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
  }
  ctx.strokeStyle = 'rgba(140, 226, 255, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const dot = (x, z, color, r) => {
    ctx.beginPath();
    ctx.arc(m.x(x), m.y(z), r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };
  for (const f of world.faces) dot(f.shovel.x, f.shovel.z, f.ore ? '#e0a33c' : '#8b9299', 2.4);
  for (const st of world.stations) dot(st.x, st.z, '#52e0a0', 2.2);
  for (const d of world.dumps.list) dot(d.x, d.z, '#98a6ae', 2.4);
  return cvs;
}

function drawMiniMap(s) {
  const cvs = $('miniMap');
  if (!cvs) return;
  // 态势图只在驾驶模式下显示，未显示时不做任何绘制
  if (!$('miniWrap').classList.contains('show')) return;
  if (!mmDpr || mmDpr !== Math.min(window.devicePixelRatio || 1, 2)) {
    mmDpr = Math.min(window.devicePixelRatio || 1, 2);
    mmBase = buildMiniBase();
  }
  if (!mmBase) mmBase = buildMiniBase();
  if (cvs.width !== Math.round(MM_SIZE * mmDpr)) {
    cvs.width = Math.round(MM_SIZE * mmDpr);
    cvs.height = Math.round(MM_SIZE * mmDpr);
  }
  const ctx = cvs.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  ctx.drawImage(mmBase, 0, 0);
  ctx.setTransform(mmDpr, 0, 0, mmDpr, 0, 0);

  const m = mmMapper(MM_SIZE);
  const TONE = {
    move: '#6fe4ff', work: '#52e0a0', queue: '#ffc168', energy: '#a99cff', idle: '#788b94', manual: '#52e0a0',
  };
  const toneOf = (t) => {
    if (t.manual) return TONE.manual;
    if (['to_shovel', 'to_dump', 'to_energy'].includes(t.state)) return TONE.move;
    if (t.state === 'loading' || t.state === 'dumping') return TONE.work;
    if (t.state.startsWith('queue_')) return TONE.queue;
    if (t.state === 'swapping' || t.state === 'charging') return TONE.energy;
    return TONE.idle;
  };

  for (const t of s.trucks) {
    if (t.id === selectedId) continue;
    ctx.beginPath();
    ctx.arc(m.x(t.x), m.y(t.z), t.manual ? 2.2 : 1.7, 0, Math.PI * 2);
    ctx.fillStyle = toneOf(t);
    ctx.globalAlpha = t.manual ? 0.95 : 0.72;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const sel = s.trucks.find((t) => t.id === selectedId);
  if (sel) {
    const px = m.x(sel.x);
    const py = m.y(sel.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(sel.heading || 0);
    ctx.beginPath();
    ctx.moveTo(0, -6.2);
    ctx.lineTo(3.6, 5);
    ctx.lineTo(0, 3);
    ctx.lineTo(-3.6, 5);
    ctx.closePath();
    ctx.fillStyle = driveOn ? '#52e0a0' : '#6fe4ff';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 7;
    ctx.fill();
    ctx.restore();
    ctx.shadowBlur = 0;

    $('mmCoord').textContent = `E ${Math.round(sel.x)} · N ${Math.round(sel.z)}`;
    const deg = Math.round((((sel.heading * 180) / Math.PI) % 360 + 360) % 360);
    $('mmHeading').textContent = `航向 ${deg}°`;
    $('mmSpeed').textContent = `${(sel.v * 3.6).toFixed(1)} km/h`;
  } else {
    $('mmCoord').textContent = 'E — · N —';
    $('mmHeading').textContent = '航向 —';
    $('mmSpeed').textContent = '— km/h';
  }
}

function setFollow(on) {
  scene && scene.setFollow(on);
  syncFollowUI(on);
}

function syncFollowUI(on) {
  $('cabFollow').checked = !!on;
  const btn = $('followBtn');
  btn.classList.toggle('on', !!on);
  btn.textContent = on ? '跟随中' : '跟随选中';
}

function showHover(id, x, y) {
  const tip = $('hoverTip');
  if (!id || !latest) { tip.style.display = 'none'; return; }
  const t = latest.trucks.find((v) => v.id === id);
  if (!t) { tip.style.display = 'none'; return; }
  const r = stage.getBoundingClientRect();
  tip.style.display = 'block';
  tip.style.left = `${clamp(x - r.left, 8, r.width - 190)}px`;
  tip.style.top = `${clamp(y - r.top, 40, r.height - 30)}px`;
  tip.textContent = `${t.id} · ${t.stateLabel} · 电量 ${Math.round(t.soc * 100)}% · 载重 ${Math.round(t.payload)} t`;
}

// ---------------- 产能曲线 ----------------
function drawChart() {
  const cvs = $('prodChart');
  if (!cvs) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cvs.clientWidth || 240;
  const h = cvs.clientHeight || 52;
  if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
  }
  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(120, 200, 225, 0.09)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const y = (h / 3) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const data = chartData.length ? chartData : [0, 0];
  const max = Math.max(6000, ...data) * 1.15;
  const step = w / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [i * step, h - clamp(v / max, 0, 1) * (h - 5)]);

  ctx.beginPath();
  ctx.moveTo(pts[0][0], h);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(111, 228, 255, 0.28)');
  grad.addColorStop(1, 'rgba(111, 228, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = '#6fe4ff';
  ctx.lineWidth = 1.4;
  ctx.shadowColor = 'rgba(111, 228, 255, 0.6)';
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const last = pts[pts.length - 1];
  ctx.fillStyle = '#c8f6ff';
  ctx.beginPath();
  ctx.arc(last[0], last[1], 2.2, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------- 轻提示 ----------------
let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------- 启动初始化画面 ----------------
// 清单与 world.js 的设施一一对应；逐项点亮后等待三维场景与仿真首帧，再淡出进入控制台
const BOOT_STEPS = [
  '采坑地形与运输路网已生成',
  '东西折返坡道已就绪（东下西上）',
  '6 座采装工作面已标定',
  '3 个卸载点已接入',
  '4 座能源站已上线',
  '40 台电动矿卡已装载',
  '远景设施已装配完成',
];
const bootStartedAt = performance.now();
let bootSeqDone = false;
let bootFinished = false;

function bootProgress(p, text) {
  const bar = $('bootBar');
  if (bar) bar.style.width = `${p}%`;
  const pct = $('bootPct');
  if (pct) pct.textContent = `${Math.round(p)}%`;
  const tx = $('bootText');
  if (tx && text) tx.textContent = text;
}

function tryFinishBoot() {
  if (bootFinished || !bootSeqDone || !sceneReady || !firstStateSeen) return;
  // ?boot=hold：演示/排查用，保留启动画面不关闭
  if (/[?&]boot=hold/.test(location.search)) return;
  bootFinished = true;
  const wait = Math.max(0, 2300 - (performance.now() - bootStartedAt));
  setTimeout(() => {
    bootProgress(100, '初始化完成 · 进入仿真');
    const el = $('boot');
    if (!el) return;
    el.classList.add('hide');
    setTimeout(() => el.remove(), 700);
    toast('YCC 矿山调度模拟已就绪 · 当前为虚拟仿真演示');
  }, wait);
}

function bootRun() {
  const items = Array.from(document.querySelectorAll('#bootList .boot-item'));
  let i = 0;
  const tick = () => {
    if (i > 0) {
      const prev = items[i - 1];
      prev.classList.remove('on');
      prev.classList.add('done');
      const em = prev.querySelector('em');
      if (em) em.textContent = '已就绪';
    }
    if (i >= items.length) {
      bootSeqDone = true;
      bootProgress(88, '等待仿真引擎首帧…');
      tryFinishBoot();
      return;
    }
    items[i].classList.add('on');
    const em = items[i].querySelector('em');
    if (em) em.textContent = '初始化中';
    bootProgress(((i + 1) / items.length) * 86, BOOT_STEPS[i] || '正在初始化…');
    i++;
    setTimeout(tick, 190);
  };
  tick();
  // 兜底：模型或 Worker 异常时最多 8s 也进入主界面，避免卡在启动画面
  setTimeout(() => {
    sceneReady = true;
    firstStateSeen = true;
    bootSeqDone = true;
    tryFinishBoot();
  }, 8000);
}

// ---------------- 启动 ----------------
bootRun();
initUI();
spawnWorker();
requestAnimationFrame(loop);
setTimeout(drawChart, 200);
