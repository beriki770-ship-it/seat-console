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

// Which listed project a conversation belongs to (dirs: resolved): its own choice (⋯ Move to project) while that folder is still listed,
// otherwise the deepest listed folder holding its cwd (the cwd itself cannot change: the CLI keys a session's history by it). null = none.
export function convProject(c, dirs) {
  if (c.project && dirs.includes(path.resolve(c.project))) return path.resolve(c.project);
  if (!c.cwd) return null; const r = path.resolve(c.cwd);
  return dirs.filter((d) => r === d || r.startsWith(d + path.sep)).sort((a, b) => b.length - a.length)[0] || null;
}

// A NEW chat's folder from its first message (send() when no folder was picked): a project named as a path start ("seats/docs/HANDOFF.md",
// "tools/seats/x", "/srv/x/projects/tools/seats/x") or as a whole word ("the seats console"), matched on the folder's relative path or
// its last segment. A hit that holds another hit is dropped (the more specific one wins). Exactly one project left -> its dir; none or several -> null.
// folders: [{ name: relative path under the projects root, dir }]
export function detectProject(text, folders) {
  const s = String(text || '').slice(0, 4000).toLowerCase(), hits = new Set();
  for (const f of folders) {
    const rel = f.name.replace(/\\/g, '/').toLowerCase();
    for (const key of new Set([rel, rel.split('/').pop()])) {
      const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // a bare name counts only at the start of a path or as a word ("seats/docs" names seats, not a project called docs), or right after projects/
      // a hyphen after a Latin letter joins a longer name (robo-lion is not lion); after anything else it is a prefix (Hebrew ב-seats)
      const before = (key.includes('/') ? '(?<![\\p{L}\\p{N}_.])' : '(?:(?<=projects/)|(?<![\\p{L}\\p{N}_./]))') + '(?<![A-Za-z0-9_]-)';
      if (new RegExp(`${before}${k}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'u').test(s)) hits.add(path.resolve(f.dir));
    }
  }
  const left = [...hits].filter((d) => ![...hits].some((o) => o !== d && o.startsWith(d + path.sep)));
  return left.length === 1 ? left[0] : null;
}

// The folder a NEW chat opens in: the one picked for it (project chip, New chat here, the folder field), else the one project its first
// message names, else the projects root. Never the seat's previous folder.
export const newChatCwd = ({ picked, text, folders, root }) => picked || detectProject(text, folders) || root;

const git = (dir, args) => new Promise((ok) => execFile('git', ['-C', dir, ...args], { timeout: 3000, windowsHide: true }, (e, out) => ok(e ? null : out)));
const gitCache = new Map();
// { branch, dirty, commits: [{ hash, at (ms), subject }] } or null when the folder is not a git repo; cached 60 s.
export async function gitInfo(dir) {
  const hit = gitCache.get(dir); if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const [st, log] = await Promise.all([git(dir, ['status', '--porcelain', '-b']), git(dir, ['log', '-5', '--pretty=%h%x09%ct%x09%s'])]);
  const lines = st ? st.split('\n').filter(Boolean) : [];
  const v = st === null ? null : { branch: (lines[0] || '').replace(/^## (No commits yet on )?/, '').split('...')[0], dirty: lines.length > 1, commits: (log || '').split('\n').filter(Boolean).map((l) => { const [hash, ct, ...s] = l.split('\t'); return { hash, at: +ct * 1000, subject: s.join('\t') }; }) };
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
