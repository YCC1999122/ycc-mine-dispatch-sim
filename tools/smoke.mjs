import { buildWorld } from '../js/world.js';
import { SimEngine } from '../js/sim/engine.js';

const world = buildWorld();
console.log('nodes', world.nodes.length, 'edges', world.edges.length, 'roads', world.roads.length);
const engine = new SimEngine(world);

const states = {};
for (let i = 0; i < 6 * 3600; i++) {
  engine.tick(1);
  if (i % 900 === 0) {
    const s = engine.snapshot();
    states[s.clock] = s.trucks.map((t) => `${t.id}:${t.state}:${Math.round(t.soc * 100)}`).join(' ');
  }
}
const s = engine.snapshot();
console.log('KPI', s.kpis);
console.log('trucks', s.trucks.slice(0, 4));
console.log('stations', s.stations.map((st) => ({ id: st.id, q: st.queue, served: st.served, packs: st.packs.map((p) => `${p.soc}:${p.state}`) })));
console.log('alerts', s.alerts);
console.log('logs', engine.logAll.slice(-25).map((l) => `${l.clock} [${l.tag}] ${l.text}`));
console.log('statesSample', Object.entries(states).slice(0, 4));
