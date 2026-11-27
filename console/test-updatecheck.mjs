// Offline test of updatecheck.mjs: ahead / identical / diverged / 404 / network error / setting off / no git. A fake fetch, never the network. Exit 0 = all passed.
import assert from 'node:assert/strict';
import { createUpdateCheck, REPO } from './updatecheck.mjs';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok ' + name); };
const answer = (status, body) => async (url, opts) => { answer.last = { url, opts }; return { ok: status >= 200 && status < 300, status, json: async () => body }; };
const ahead = { status: 'ahead', ahead_by: 2, html_url: 'https://github.com/x/y/compare/a...main', commits: [{ sha: '1111111aaaa', commit: { message: 'Old change', committer: { date: '2026-01-01T00:00:00Z' } } }, { sha: '2222222bbbb', commit: { message: 'Newest change\n\nlong body', committer: { date: '2026-01-02T00:00:00Z' } } }] };
const make = (fetchFn, over = {}) => { const logs = [], changes = []; const u = createUpdateCheck({ cwd: '.', enabled: () => true, getSha: async () => 'abc123', fetchFn, log: (m) => logs.push(m), onChange: (v) => changes.push(v), ...over }); return { u, logs, changes }; };

await t('ahead: behind count, newest commit (first line), link, one change event; the request names the repo and the local commit', async () => {
  const { u, changes } = make(answer(200, ahead)); const v = await u.check();
  assert.deepEqual(v.update, { behind: 2, latest: { sha: '2222222', message: 'Newest change', date: '2026-01-02T00:00:00Z' }, url: ahead.html_url });
  assert.ok(v.checkedAt && v.on && changes.length === 1);
  assert.equal(answer.last.url, `https://api.github.com/repos/${REPO}/compare/abc123...main`); assert.equal(answer.last.opts.headers['User-Agent'], 'seat-console');
});
await t('identical: up to date, checked time set, no update', async () => {
  const { u } = make(answer(200, { status: 'identical', ahead_by: 0, commits: [] })); const v = await u.check();
  assert.equal(v.update, null); assert.ok(v.checkedAt);
});
await t('local ahead (behind_by on main) shows nothing', async () => { const { u } = make(answer(200, { status: 'behind', ahead_by: 0, commits: [] })); assert.equal((await u.check()).update, null); });
await t('diverged shows nothing', async () => { const { u } = make(answer(200, { status: 'diverged', ahead_by: 3, behind_by: 1, commits: ahead.commits })); assert.equal((await u.check()).update, null); });
await t('404 (unknown commit, a fork): nothing shown, one log line, no throw', async () => {
  const { u, logs } = make(answer(404, { message: 'Not Found' })); assert.equal((await u.check()).update, null); assert.equal(logs.length, 1); assert.match(logs[0], /404/);
});
await t('network error: no throw, one log line, an earlier notice stays', async () => {
  let fail = false; const { u, logs } = make(async (...a) => { if (fail) throw new Error('offline'); return answer(200, ahead)(...a); });
  await u.check(); fail = true; const v = await u.check();
  assert.equal(v.update.behind, 2); assert.equal(logs.length, 1); assert.match(logs[0], /offline/);
});
await t('setting off: nothing is asked and the notice is cleared', async () => {
  let on = true, calls = 0; const { u, changes } = make(async (...a) => { calls++; return answer(200, ahead)(...a); }, { enabled: () => on });
  await u.check(); assert.equal(calls, 1); on = false; const v = await u.check();
  assert.equal(calls, 1); assert.equal(v.update, null); assert.equal(v.on, false); assert.equal(changes.at(-1).update, null);
});
await t('not a git checkout: skipped silently, logged once', async () => {
  let calls = 0; const { u, logs } = make(async () => { calls++; }, { getSha: async () => null });
  await u.check(); await u.check(); assert.equal(calls, 0); assert.equal(logs.length, 1);
});
console.log(`test-updatecheck: ${n} passed`);
