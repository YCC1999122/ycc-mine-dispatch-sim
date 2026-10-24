// 仿真后台线程：固定节拍推进，向主线程推送状态快照
import { SimEngine } from './sim/engine.js?v=boot1';

let engine = null;
let timer = null;

function emit() {
  if (!engine) return;
  self.postMessage({ type: 'state', state: engine.snapshot(), logs: engine.drainLogs() });
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'init') {
    engine = new SimEngine(msg.world);
    if (msg.speed) engine.setSpeed(msg.speed);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!engine.paused) engine.tick(0.1 * engine.speed);
      emit();
    }, 100);
    emit();
    return;
  }
  if (!engine) return;
  switch (msg.type) {
    case 'speed': engine.setSpeed(msg.value); break;
    case 'pause': engine.setPaused(msg.value); break;
    case 'weather': engine.setWeather(msg.value); break;
    case 'mode': engine.setMode(msg.value); break;
    case 'socReserve': engine.setSocReserve(msg.value); break;
    case 'assign': engine.manualAssign(msg.truckId, msg.targetId); break;
    case 'manual': engine.setManual(msg.truckId, msg.on); break;
    case 'drive': engine.setDrive(msg.truckId, msg.keys || {}); break;
    default: break;
  }
};
