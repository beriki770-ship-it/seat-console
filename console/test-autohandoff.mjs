// Unit tests for the local auto handoff decision (rollover.mjs autoHandoffStep + helpers): node console/test-autohandoff.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { autoHandoffStep, handoffReadyPath, handoffFileFor, autoHandoffPrompt, continuePrompt, AH_MAX_RUNNING } from './rollover.mjs';

const cfg = { on: true, pct: 30, minTokens: 120000 };
const cv = (o = {}) => ({ id: 'abcdef1234', title: 'Work', seat: 'ops', ...o });
const v = (o = {}) => ({ pct: 31, used: 310000, settled: true, blocked: false, running: 0, ...o });

// threshold crossing: armed only at a result, only at/after the limit, only above the floor
assert.equal(autoHandoffStep(cv(), v({ pct: 29.9, atResult: true }), cfg), null);
assert.equal(autoHandoffStep(cv(), v({ atResult: true }), cfg), 'arm');
assert.equal(autoHandoffStep(cv(), v({ atResult: false }), cfg), null, 'an idle conversation past the limit is not armed by the tick (gentle start after a restart)');
assert.equal(autoHandoffStep(cv(), v({ pct: 40, used: 80000, atResult: true }), cfg), null, '200k window: 40% = 80k is under the 120k floor');
assert.equal(autoHandoffStep(cv(), v({ pct: null, atResult: true }), cfg), null, 'no meter (Codex / agy) = nothing');
console.log('ok  crossing: arm at a result past the limit and the floor only');

// skipped kinds
for (const [o, why] of [[{ remote: 'x' }, 'remote'], [{ phone: {} }, 'phone'], [{ archived: true }, 'archived'], [{ noAutoHandoff: true }, 'per-conversation off']])
  assert.equal(autoHandoffStep(cv(o), v({ atResult: true }), cfg), null, why);
assert.equal(autoHandoffStep(cv(), v({ atResult: true, agent: true }), cfg), null, 'agent seat');
assert.equal(autoHandoffStep(cv(), v({ atResult: true }), { ...cfg, on: false }), null, 'Settings off');
console.log('ok  skipped: remote, phone, archived, per-conversation off, agent seats, Settings off');

// working -> armed -> fires after it settles; blocked (approval / question) waits; cap of running handoffs
const armed = cv({ autoHandoff: { stage: 'armed' } });
assert.equal(autoHandoffStep(armed, v({ settled: false }), cfg), null, 'still working');
assert.equal(autoHandoffStep(armed, v({ blocked: true }), cfg), null, 'pending approval / needs answer');
assert.equal(autoHandoffStep(armed, v({ running: AH_MAX_RUNNING }), cfg), null, 'two handoffs already running');
assert.equal(autoHandoffStep(armed, v(), cfg), 'ask');
assert.equal(autoHandoffStep(armed, v({ pct: 12 }), cfg), 'disarm', 'compacted by hand meanwhile');
console.log('ok  working -> arm -> ask once settled; blocked and the running cap wait');

// asked: READY + fresh file -> continue; no READY / stale file -> retry once, then give up; the owner wrote in between -> cancel
const asked = (o = {}) => cv({ autoHandoff: { stage: 'asked', tries: 1, ...o } });
assert.equal(autoHandoffStep(asked({ ready: '/p/docs/HANDOFF.md' }), v({ settled: false, fresh: true }), cfg), null);
assert.equal(autoHandoffStep(asked({ ready: '/p/docs/HANDOFF.md' }), v({ fresh: true }), cfg), 'continue');
assert.equal(autoHandoffStep(asked({ ready: '/p/docs/HANDOFF.md' }), v({ fresh: false }), cfg), 'retry', 'line given but the file did not change');
assert.equal(autoHandoffStep(asked({}), v({ fresh: true }), cfg), 'retry', 'file changed but no HANDOFF-READY line');
assert.equal(autoHandoffStep(asked({ tries: 2 }), v(), cfg), 'giveup');
assert.equal(autoHandoffStep(asked({ ready: '/x', owner: true }), v({ fresh: true }), cfg), 'cancel', 'owner message in between cancels Step B');
assert.equal(autoHandoffStep(asked({ owner: true }), v({ settled: false }), cfg), 'cancel');
assert.equal(autoHandoffStep(asked({}), v({ settled: false, stuck: true }), cfg), 'giveup', 'ask turn never came back to idle');
assert.equal(autoHandoffStep(asked({}), v(), { ...cfg, on: false }), 'disarm', 'switched off while asked: no frozen slot');
assert.equal(autoHandoffStep(cv({ noAutoHandoff: true, autoHandoff: { stage: 'armed' } }), v(), cfg), 'disarm');
console.log('ok  asked: continue / retry once / give up / owner message cancels');

// no loop + hysteresis
const done = cv({ autoHandoff: { stage: 'done' } }), gave = cv({ autoHandoff: { stage: 'gave-up' } });
assert.equal(autoHandoffStep(done, v({ atResult: true, pct: 60 }), cfg), null, 'never twice in one crossing');
assert.equal(autoHandoffStep(gave, v({ atResult: true, pct: 60 }), cfg), null);
assert.equal(autoHandoffStep(done, v({ pct: 27 }), cfg), null, 'within the 5-point band');
assert.equal(autoHandoffStep(done, v({ pct: 24.9 }), cfg), 'rearm');
console.log('ok  no loop: done / gave-up stay until the context dropped 5 points below the limit');

// helpers
assert.equal(handoffReadyPath('done.\nHANDOFF-READY: /home/u/p/docs/HANDOFF.md'), '/home/u/p/docs/HANDOFF.md');
assert.equal(handoffReadyPath('HANDOFF-READY: `/a/b.md`'), '/a/b.md');
assert.equal(handoffReadyPath('I will write HANDOFF-READY later'), null);
const have = new Set(['/home/u/proj/docs/HANDOFF.md', '/home/u/proj2/.git']), ex = (f) => have.has(f);
assert.equal(handoffFileFor('/home/u/proj/console', '/home/u', ex, path.posix.join, path.posix.dirname), '/home/u/proj/docs/HANDOFF.md');
assert.equal(handoffFileFor('/home/u/proj2/src/a', '/home/u', ex, path.posix.join, path.posix.dirname), '/home/u/proj2/docs/HANDOFF.md');
assert.equal(handoffFileFor('/home/u/loose', '/home/u', ex, path.posix.join, path.posix.dirname), '/home/u/loose/docs/HANDOFF.md');
assert.match(autoHandoffPrompt(31.4, '/p/docs/HANDOFF.md'), /^🧭 Console: context at 31% —[\s\S]*HANDOFF-READY: </);
assert.match(continuePrompt({ id: 'abcdef1234', title: 'Work', pct: 31 }, '/p/docs/HANDOFF.md'), /^Continue from \/p\/docs\/HANDOFF\.md: read it first/);
console.log('ok  helpers: READY line, which HANDOFF.md, prompts');
