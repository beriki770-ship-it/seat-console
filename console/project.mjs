// A project's own page (GET /api/project): which dirs may be opened, its git state and the head of its HANDOFF.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Only a folder the Projects page lists (a scanned project folder or a run's dir) may be opened; `..`, relative and outside paths resolve to something not in the list.
export const allowedDir = (dir, dirs) => {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) return null;
  const r = path.resolve(dir);
  return dirs.some((d) => path.resolve(d) === r) ? r : null;
};

const git = (dir, args) => new Promise((ok) => execFile('git', ['-C', dir, ...args], { timeout: 3000, windowsHide: true }, (e, out) => ok(e ? null : out)));
const gitCache = new Map();
// { branch, dirty, commits: [{ hash, subject }] } or null when the folder is not a git repo; cached 60 s.
export async function gitInfo(dir) {
  const hit = gitCache.get(dir); if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const [st, log] = await Promise.all([git(dir, ['status', '--porcelain', '-b']), git(dir, ['log', '-5', '--pretty=%h%x09%s'])]);
  const lines = st ? st.split('\n').filter(Boolean) : [];
  const v = st === null ? null : { branch: (lines[0] || '').replace(/^## (No commits yet on )?/, '').split('...')[0], dirty: lines.length > 1, commits: (log || '').split('\n').filter(Boolean).map((l) => { const [hash, ...s] = l.split('\t'); return { hash, subject: s.join('\t') }; }) };
  gitCache.set(dir, { at: Date.now(), v }); return v;
}

// The first lines of docs/HANDOFF.md (or HANDOFF.md) of the project; a symlink pointing out of the folder is not followed.
export function handoffHead(dir, lines = 25) {
  for (const rel of [path.join('docs', 'HANDOFF.md'), 'HANDOFF.md']) {
    try {
      const f = path.join(dir, rel), real = fs.realpathSync(f), root = fs.realpathSync(dir);
      if (!real.startsWith(root + path.sep)) continue;
      return { file: rel, text: fs.readFileSync(real, 'utf8').split('\n').slice(0, lines).join('\n').slice(0, 4000) };
    } catch {}
  }
  return null;
}
