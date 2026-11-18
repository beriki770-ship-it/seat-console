// Run: node console/test-multi.mjs. Multi-sided projects (multi.mjs): plan validation, fixed discipline -> seat routing, dependencies,
// done detection by .multi/out/<task>.md, integration, and the HARD RULE: a seat at its usage limit makes its tasks wait, no failover.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMulti, validatePlan, seatFor, blockedUntil, loadDisciplines, MARGIN_MS } from './multi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The shipped example loads against the example seats.
const ex = loadDisciplines(path.join(HERE, 'disciplines.example.json'), JSON.parse(fs.readFileSync(path.join(HERE, '..', 'seats.example.json'), 'utf8')).seats);
assert.equal(ex.owner, 'dev'); assert.equal(ex.map.frontend, 'studio'); assert.equal(ex.map.deploy, 'ops');
// A five-seat mapping for the flow below, written to a temp file (loadDisciplines rejects an unknown seat).
const SEATS = { studio: {}, dev: {}, render: {}, info: {}, ops: {}, max: {} };
const DISC = { owner: 'dev', disciplines: { design: 'studio', frontend: 'studio', backend: 'dev', logic: 'dev', video: 'render', animation: 'render', copy: 'info', marketing: 'info', deploy: 'ops', automations: 'ops' } };
const discFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multi-disc-')), 'disciplines.json'); fs.writeFileSync(discFile, JSON.stringify(DISC));
const { map, owner } = loadDisciplines(discFile, SEATS);
assert.deepEqual(map, DISC.disciplines);
assert.equal(owner, 'dev');
assert.throws(() => loadDisciplines(discFile, { dev: {} }), /unknown seat/);
assert.throws(() => seatFor(map, 'sales'), /unknown discipline/);

// ---- plan validation ----
const plan = { tasks: [
  { id: 'site', title: 'Landing page', discipline: 'frontend', deps: [], brief: 'build it', seat: 'dev' },   // a planner-written seat is ignored
  { id: 'api', title: 'API', discipline: 'backend', deps: [], brief: 'api' },
  { id: 'promo', title: 'Promo clip', discipline: 'video', deps: ['site'], brief: 'clip of the site' },
] };
const v = validatePlan(plan, map);
assert.deepEqual(v.map((t) => t.seat), ['studio', 'dev', 'render']);
assert.throws(() => validatePlan({ tasks: [{ id: 'a', discipline: 'sales', brief: 'x' }] }, map), /unknown discipline/);
assert.throws(() => validatePlan({ tasks: [{ id: 'a', discipline: 'copy', brief: 'x', deps: ['b'] }, { id: 'b', discipline: 'copy', brief: 'x', deps: ['a'] }] }, map), /cycle/);
assert.throws(() => validatePlan({ tasks: [{ id: 'a', discipline: 'copy', brief: 'x', deps: ['zz'] }] }, map), /unknown dependency/);
assert.throws(() => validatePlan({ tasks: [{ id: 'A B', discipline: 'copy', brief: 'x' }] }, map), /bad id/);
assert.throws(() => validatePlan({ tasks: [] }, map), /no tasks/);

// ---- blockedUntil ----
const T0 = Date.UTC(2026, 10, 18, 12), sec = (ms) => ms / 1000;
assert.equal(blockedUntil({ five_hour: { utilization: 0.5, resetsAt: sec(T0 + 3600e3) } }, T0), 0);
assert.equal(blockedUntil({ five_hour: { utilization: 1, resetsAt: sec(T0 + 3600e3) } }, T0), T0 + 3600e3 + MARGIN_MS);
assert.equal(blockedUntil({ five_hour: { utilization: 1, resetsAt: sec(T0 - 1000) } }, T0), 0);   // already reset
assert.equal(blockedUntil({ seven_day: { utilization: 1, resetsAt: sec(T0 + 86400e3) } }, T0), T0 + 86400e3 + MARGIN_MS);

// ---- the whole flow with a fake send and fake usage ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-'));
let now = T0; const usage = {}; const idle = new Set(); const sends = []; let n = 0; const convs = {};
const state = {}; let saves = 0;
const m = createMulti({ state, save: () => saves++, broadcast: () => {}, deps: {
  map, owner, seats: SEATS, root, now: () => now, idle: (id) => idle.has(id), windows: (s) => usage[s]?.windows, notify: () => {}, log: () => {},
  send: async (b) => { if (b.conversationId && !convs[b.conversationId]) throw new Error('unknown conversation'); const c = b.conversationId ? convs[b.conversationId] : (convs['c' + ++n] = { id: 'c' + n, seat: b.seat, cwd: b.cwd }); sends.push({ ...b, seat: c.seat }); return c; },
} });
const flush = () => m.tick();
const settle = (id, o) => m.settled(convs[id], o);

const p = m.create({ name: 'Demo Shop', brief: 'A shop with a promo clip' });
assert.equal(p.dir, path.join(root, 'demo-shop')); assert.ok(fs.existsSync(p.dir));
await flush();
assert.equal(sends.length, 1); assert.equal(sends[0].seat, 'dev'); assert.match(sends[0].text, /PLANNER/); assert.equal(sends[0].cwd, p.dir);
assert.throws(() => m.create({ name: 'x', brief: 'y', dir: p.dir }), /already runs/);
assert.throws(() => m.create({ name: 'x', brief: 'y', dir: '/etc/nope-multi' }), /does not exist/);

// planner wrote nothing -> plan-error; retry sends the fix into the SAME conversation
settle(p.planConv, {}); assert.equal(p.status, 'plan-error'); assert.match(p.error, /ENOENT|no such file/);
m.retry(p.id); await flush();
assert.equal(sends.length, 2); assert.equal(sends[1].conversationId, p.planConv); assert.match(sends[1].text, /could not use/);
fs.writeFileSync(path.join(p.dir, '.multi', 'plan.json'), JSON.stringify(plan));
settle(p.planConv, {}); assert.equal(p.status, 'plan-ready'); assert.equal(p.tasks.length, 3);
await flush(); assert.equal(sends.length, 2, 'nothing runs before the user approves');
fs.writeFileSync(path.join(p.dir, '.multi', 'plan.json'), JSON.stringify({ tasks: [...plan.tasks, { id: 'late', discipline: 'copy', brief: 'x' }] }));
assert.throws(() => m.retry(p.id, 'site'), /not running/);

// HARD RULE: studio (frontend) is at its limit; every other seat is free. The site task must WAIT, never go elsewhere.
usage.studio = { windows: { five_hour: { utilization: 1, resetsAt: sec(T0 + 2 * 3600e3) } } };
m.approve(p.id); await flush();
assert.equal(p.tasks.length, 4, 'approve took the plan as it is now'); const late = p.tasks.find((t) => t.id === 'late'); assert.equal(convs[late.conv].seat, 'info');
fs.writeFileSync(path.join(p.dir, '.multi', 'out', 'late.md'), 'done'); settle(late.conv, {});
const site = p.tasks.find((t) => t.id === 'site'), api = p.tasks.find((t) => t.id === 'api'), promo = p.tasks.find((t) => t.id === 'promo');
assert.equal(api.status, 'running'); assert.equal(convs[api.conv].seat, 'dev');
assert.equal(site.status, 'pending'); assert.equal(site.waitUntil, T0 + 2 * 3600e3 + MARGIN_MS);
assert.equal(promo.status, 'pending'); assert.equal(sends.length, 4, 'only the api + late tasks started');
for (let i = 0; i < 5; i++) { now += 60e3; await flush(); }   // ticks while the limit holds
assert.equal(sends.length, 4, 'no failover: the blocked task was not sent to any seat');
assert.ok(!sends.some((s) => /Landing page/.test(s.title || '')), 'site task never dispatched while studio is blocked');
// every task conversation ever started sits on the seat of its discipline
const seatOk = () => { for (const t of p.tasks) if (t.conv) assert.equal(convs[t.conv].seat, map[t.discipline]); };
seatOk();

// the reset passes -> the site task starts on studio (its own seat)
now = T0 + 2 * 3600e3 + MARGIN_MS + 1; await flush();
assert.equal(site.status, 'running'); assert.equal(convs[site.conv].seat, 'studio'); assert.equal(site.waitUntil, 0);
assert.equal(promo.status, 'pending', 'promo waits for its dependency');

// done only with the out file; without it the task is "stuck"
settle(site.conv, {}); assert.equal(site.status, 'stuck');
m.retry(p.id, 'site'); await flush();
assert.equal(sends.at(-1).conversationId, site.conv); assert.equal(sends.at(-1).seat, 'studio'); assert.equal(site.status, 'running');
fs.writeFileSync(path.join(p.dir, '.multi', 'out', 'site.md'), 'done');
settle(site.conv, {}); assert.equal(site.status, 'done'); await flush();
assert.equal(promo.status, 'running'); assert.equal(convs[promo.conv].seat, 'render'); assert.match(sends.at(-1).text, /\.multi\/out\/site\.md/);

// a running task whose process died (no settle): Continue only when its conversation is idle, on the same conversation
assert.throws(() => m.retry(p.id, 'api'), /task is running/);
idle.add(api.conv); m.retry(p.id, 'api'); await flush(); assert.equal(sends.at(-1).conversationId, api.conv); assert.equal(api.status, 'running');
// an error marks the task, a needs-answer is shown as such
settle(api.conv, { error: 'boom' }); assert.equal(api.status, 'error');
m.retry(p.id, 'api'); await flush(); assert.equal(api.status, 'running'); assert.equal(convs[api.conv].seat, 'dev');
settle(api.conv, { needsAnswer: true }); assert.equal(api.status, 'needs-answer');
fs.writeFileSync(path.join(p.dir, '.multi', 'out', 'api.md'), 'done'); settle(api.conv, {}); assert.equal(api.status, 'done');
fs.writeFileSync(path.join(p.dir, '.multi', 'out', 'promo.md'), 'done'); settle(promo.conv, {});
await flush();
seatOk();

// all done -> integration on the owner seat; owner at its limit -> the integration waits too
assert.equal(p.status, 'integrating');
assert.equal(sends.filter((s) => /INTEGRATION/.test(s.text)).length, 1); assert.equal(convs[p.integrateConv].seat, 'dev');
settle(p.integrateConv, {}); assert.equal(p.status, 'integrate-error', 'no _integration.md = not done');
m.retry(p.id, 'integrate'); await flush(); assert.equal(sends.at(-1).conversationId, p.integrateConv);
fs.writeFileSync(path.join(p.dir, '.multi', 'out', '_integration.md'), 'ok'); settle(p.integrateConv, {}); assert.equal(p.status, 'done');
const tj = JSON.parse(fs.readFileSync(path.join(p.dir, '.multi', 'tasks.json'), 'utf8'));
assert.equal(tj.status, 'done'); assert.deepEqual(tj.tasks.map((t) => [t.id, t.seat, t.status]), [['site', 'studio', 'done'], ['api', 'dev', 'done'], ['promo', 'render', 'done'], ['late', 'info', 'done']]);

// the same folder again: the old .multi is moved aside, its out files do not count
const again = m.create({ name: 'Again', brief: 'b', dir: p.dir });
assert.ok(!fs.existsSync(path.join(p.dir, '.multi', 'out', 'site.md'))); assert.ok(fs.readdirSync(p.dir).some((f) => f.startsWith('.multi.old-')));
await flush(); m.cancel(again.id); assert.equal(again.status, 'cancelled');
const n0 = sends.length; await flush(); assert.equal(sends.length, n0, 'a cancelled project starts nothing');
// a deleted task conversation: error, Retry starts a new one on the same seat
const third = m.create({ name: 'Third', brief: 'b', dir: p.dir }); await flush();
fs.writeFileSync(path.join(p.dir, '.multi', 'plan.json'), JSON.stringify({ tasks: [{ id: 'one', discipline: 'design', brief: 'x' }] }));
settle(third.planConv, {}); m.approve(third.id); await flush();
const one = third.tasks[0]; settle(one.conv, { error: 'x' }); delete convs[one.conv];
m.retry(third.id, 'one'); await flush(); assert.equal(one.status, 'error'); assert.equal(one.conv, null);
m.retry(third.id, 'one'); await flush(); assert.equal(one.status, 'running'); assert.equal(convs[one.conv].seat, 'studio');
m.cancel(third.id);

// owner blocked: the planner itself waits
usage.dev = { windows: { seven_day: { utilization: 1, resetsAt: sec(now + 86400e3) } } };
const before = sends.length, q = m.create({ name: 'Second', brief: 'b' }); await flush();
assert.equal(sends.length, before); assert.equal(q.status, 'planning'); assert.ok(q.waitUntil > now);
assert.ok(!m.view()[0].brief && !m.view()[0].tasks.some((t) => t.brief), 'view stays small');

fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.dirname(discFile), { recursive: true, force: true });
console.log('test-multi: all passed');
