// Offline test of settings.mjs: defaults, validation, atomic write, the seats.json edits (name rules, own login folder for a second account),
// disciplines, routines (cron), remotes, Telegram token. Exit 0 = all passed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaults, validateSettings, readSettings, writeJsonAtomic, addSeat, removeSeat, checkDisciplines, saveRoutine, addRemote, telegramToken } from './settings.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-settings-')), file = path.join(dir, 'settings.json');
const seats = { dev: { email: 'dev@example.com', role: 'Code' }, ops: { email: 'ops@example.com', role: 'Ops' } };
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('defaults: optional features off, codex resets only with a codex seat, projects only with disciplines.json', () => {
  const d = defaults({ seats });
  assert.equal(d.claudeResets, false); assert.equal(d.codexResets, false); assert.equal(d.multiProjects, false); assert.equal(d.usageMeters, true); assert.equal(d.autoArchiveDays, 3);
  assert.equal(defaults({ seats: { ...seats, gpt: { agent: 'codex' } }, disciplines: true }).codexResets, true);
  assert.equal(defaults({ seats, disciplines: true }).multiProjects, true);
});
t('validation: types, ranges, unknown keys, models of known seats only', () => {
  assert.deepEqual(validateSettings({ claudeResets: true, autoArchiveDays: 0, models: { dev: 'claude-sonnet-5-5', ops: '' } }, seats), { claudeResets: true, autoArchiveDays: 0, models: { dev: 'claude-sonnet-5-5' } });
  for (const bad of [{ claudeResets: 'yes' }, { autoArchiveDays: -1 }, { autoArchiveDays: 1.5 }, { idleReapMinutes: 0 }, { nope: true }, { models: { ghost: 'x' } }, { models: { dev: 'a b' } }, null, []])
    assert.throws(() => validateSettings(bad, seats), undefined, JSON.stringify(bad));
});
t('read: missing = first run with defaults; a broken file = defaults + the reason', () => {
  assert.deepEqual(readSettings(file, { seats }), { settings: defaults({ seats }), firstRun: true, error: null });
  fs.writeFileSync(file, '{"claudeResets": 1}'); const r = readSettings(file, { seats });
  assert.equal(r.firstRun, false); assert.equal(r.settings.claudeResets, false); assert.match(r.error, /claudeResets/);
  fs.writeFileSync(file, '{"claudeResets": true, "models": {"gone": "x", "dev": "m"}}');   // a removed seat's model does not throw the file away
  assert.deepEqual(readSettings(file, { seats }).settings.models, { dev: 'm' }); assert.equal(readSettings(file, { seats }).settings.claudeResets, true);
});
t('atomic write: whole file, no temp left, read back', () => {
  writeJsonAtomic(file, { ...defaults({ seats }), claudeResets: true });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  assert.equal(readSettings(file, { seats }).settings.claudeResets, true);
});
t('add seat: name rules, no duplicate, second account of an agent gets its own home', () => {
  const cfg = { projectsDir: '/p', seats };
  for (const name of ['Dev', '1dev', 'd', 'a'.repeat(22), 'dev', 'x y', '']) assert.throws(() => addSeat(cfg, { name }), undefined, name);
  assert.throws(() => addSeat(cfg, { name: 'web', agent: 'gpt' }));
  assert.throws(() => addSeat(cfg, { name: 'web', email: 'not-an-email' }));
  const one = addSeat(cfg, { name: 'web', email: 'w@example.com', role: 'Sites' });
  assert.deepEqual(one.seats.web, { email: 'w@example.com', role: 'Sites' }); assert.equal(one.projectsDir, '/p'); assert.equal(cfg.seats.web, undefined);
  const c1 = addSeat(one, { name: 'codex', agent: 'codex' }), c2 = addSeat(c1, { name: 'codex2', agent: 'codex' }), a1 = addSeat(c2, { name: 'agy', agent: 'agy' });
  assert.equal(c1.seats.codex.home, undefined); assert.equal(c2.seats.codex2.home, '~/.seat-console/accounts/codex2'); assert.equal(a1.seats.agy.home, undefined);
});
t('remove seat: only unused, never the last', () => {
  assert.throws(() => removeSeat({ seats }, 'dev', ['2 conversations']), /still used/);
  assert.throws(() => removeSeat({ seats: { dev: {} } }, 'dev'), /last seat/);
  assert.throws(() => removeSeat({ seats }, 'ghost'));
  assert.deepEqual(Object.keys(removeSeat({ seats }, 'ops').seats), ['dev']);
});
t('disciplines: every target and the owner must exist', () => {
  assert.deepEqual(checkDisciplines({ owner: 'dev', disciplines: { frontend: 'dev', deploy: 'ops' } }, seats).disciplines, { frontend: 'dev', deploy: 'ops' });
  assert.throws(() => checkDisciplines({ owner: 'ghost', disciplines: { a: 'dev' } }, seats));
  assert.throws(() => checkDisciplines({ owner: 'dev', disciplines: { a: 'ghost' } }, seats));
  assert.throws(() => checkDisciplines({ owner: 'dev', disciplines: {} }, seats));
});
t('routines: cron checked, an edit replaces by id and keeps enabled', () => {
  const r = { id: 'weekly', seat: 'dev', cron: '0 9 * * 1', cwd: '/tmp', prompt: 'x' };
  assert.throws(() => saveRoutine([], { ...r, cron: '0 9 * *' }, seats), /5 fields/);
  assert.throws(() => saveRoutine([], { ...r, seat: 'ghost' }, seats));
  assert.throws(() => saveRoutine([], { ...r, cwd: 'relative' }, seats));
  const list = saveRoutine([{ id: 'weekly', enabled: false, promptFile: '/f.md', cron: '* * * * *', seat: 'dev', cwd: '/' }], { ...r, prompt: 'y' }, seats);
  assert.equal(list.length, 1); assert.equal(list[0].enabled, false); assert.equal(list[0].prompt, 'y'); assert.equal(list[0].promptFile, undefined);
  assert.equal(saveRoutine(list, { ...r, id: 'daily' }, seats).length, 2);
});
t('remotes: the start-up rules, unique name, account must be a seat', () => {
  const ok = { name: 'box', target: 'u@203.0.113.5', identity: '~/.ssh/id', control: true, account: 'dev' };
  assert.equal(addRemote([], ok, seats, '/home/x')[0].account, 'dev');
  assert.throws(() => addRemote([{ name: 'box' }], ok, seats, '/h'), /already/);
  assert.throws(() => addRemote([], { ...ok, target: 'u@h; rm -rf /' }, seats, '/h'));
  assert.throws(() => addRemote([], { ...ok, control: false }, seats, '/h'));   // read-only needs paths to follow
  assert.throws(() => addRemote([], { ...ok, account: 'ghost' }, seats, '/h'));
});
t('telegram token: format checked; a new bot drops the old chat link', () => {
  const tok = '123456789:' + 'A'.repeat(35);
  assert.throws(() => telegramToken({}, 'nope'));
  assert.deepEqual(telegramToken({ botToken: tok, chatId: '5' }, tok), { botToken: tok, chatId: '5' });
  assert.deepEqual(telegramToken({ botToken: tok, chatId: '5' }, '987654321:' + 'B'.repeat(35)), { botToken: '987654321:' + 'B'.repeat(35) });
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(`test-settings: ${n} passed`);
