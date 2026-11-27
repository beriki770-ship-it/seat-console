// "Tell me when a new version is out" (Settings > Start, updateCheck, off by default): compares this checkout's commit with main on GitHub.
// One anonymous request a day; nothing about the user or the machine is sent (the commit hash of the public repo is part of the URL, nothing else).
// server.mjs owns the timers and the broadcast; test-updatecheck.mjs drives this with a fake fetch.
import { execFile } from 'node:child_process';

export const REPO = 'beriki770-ship-it/seat-console';   // the one place the public repo is named
export const API = 'https://api.github.com';

const gitHead = (cwd) => new Promise((ok) => execFile('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true }, (e, out) => ok(e ? null : out.trim() || null)));

// enabled(): the live setting. onChange(view): called whenever what the page shows changes. Every failure is one log line, never a throw.
export function createUpdateCheck({ cwd, enabled, onChange = () => {}, log = () => {}, fetchFn = fetch, getSha = () => gitHead(cwd), api = API }) {
  let update = null, checkedAt = null, noGitLogged = false;
  const view = () => ({ on: !!enabled(), checkedAt, update });
  const set = (u, at) => { const was = JSON.stringify(view()); update = u; if (at) checkedAt = at; if (JSON.stringify(view()) !== was) onChange(view()); };
  async function check() {
    if (!enabled()) { checkedAt = null; set(null); return view(); }   // turned off: nothing is shown, nothing is asked
    const sha = await getSha();
    if (!sha) { if (!noGitLogged) { noGitLogged = true; log('[update] not a git checkout (or no git): update check skipped'); } return view(); }
    try {
      const r = await fetchFn(`${api}/repos/${REPO}/compare/${sha}...main`, { headers: { 'User-Agent': 'seat-console', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) { log(`[update] GitHub answered ${r.status}: no update shown`); set(null); return view(); }   // 404: this commit is not on GitHub (a fork, local work)
      const j = await r.json(), last = Array.isArray(j.commits) ? j.commits[j.commits.length - 1] : null;   // oldest first: the last one is main's head
      if (j.status !== 'ahead' || !(j.ahead_by > 0) || !last) { set(null, Date.now()); return view(); }   // identical, behind (this checkout is newer) or diverged
      set({ behind: j.ahead_by, latest: { sha: String(last.sha).slice(0, 7), message: String(last.commit?.message || '').split('\n')[0], date: last.commit?.committer?.date || null }, url: j.html_url }, Date.now());
    } catch (e) { log(`[update] check failed: ${e.message}`); }   // offline: what was shown stays
    return view();
  }
  return { check, view };
}
