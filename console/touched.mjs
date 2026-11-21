// Which files a conversation touched, from the tool calls in its log: the base of "Related" on a project page (searchidx.mjs collects,
// server.mjs decides). Pure: no file system. A write is a tool that names its file (Edit/Write/MultiEdit/NotebookEdit, Antigravity write_file);
// shell commands only ever count as reads of the absolute paths they mention: guessing writes from a shell line would be wrong too often.
import path from 'node:path';

// Absolute paths inside a shell command: start of the line, after whitespace, a quote, = or a redirect. Stops at shell syntax and glob characters.
const ABS = /(?:^|[\s'"=<>(|;&])(\/[^\s'"`<>()|;&*?[\]{}$\\,]+)/g;
// Codex wraps every command as `/bin/bash -lc '<script>'` (or "<script>"): the wrapper itself is no path of the conversation.
const unwrap = (cmd) => { const m = /^\s*\S*\bbash\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd); return m ? m[2] : cmd; };
const shellPaths = (cmd) => [...unwrap(String(cmd || '')).matchAll(ABS)].map((m) => m[1].replace(/[.:]+$/, '')).filter((p) => p.length > 1);
// A Glob pattern such as /a/b/**/*.js reads the folder in front of the first glob character.
const globBase = (p) => { const s = String(p || ''), i = s.search(/[*?[{]/); const base = i < 0 ? s : s.slice(0, s.lastIndexOf('/', i)); return base.startsWith('/') ? base : ''; };

// One tool_use block -> [{ path, kind: 'w' | 'r' }]; only absolute paths, normalised (a relative one has no known base).
export function touchedOf(b) {
  const i = b?.input || {}, out = [];
  const add = (p, kind) => { if (typeof p === 'string' && p.startsWith('/') && !p.includes('\0')) out.push({ path: path.posix.normalize(p).replace(/(.)\/$/, '$1'), kind }); };
  switch (b?.name) {
    case 'Edit': case 'Write': case 'MultiEdit': add(i.file_path, 'w'); break;
    case 'NotebookEdit': add(i.notebook_path, 'w'); break;
    case 'write_file': add(i.Path, 'w'); break;
    case 'Read': add(i.file_path, 'r'); break;
    case 'Glob': add(i.path, 'r'); if (!i.path) add(globBase(i.pattern), 'r'); break;
    case 'Grep': add(i.path, 'r'); break;   // its pattern is a regex, not a path
    case 'Bash': for (const p of shellPaths(i.command)) add(p, 'r'); break;
    case 'run_command': for (const p of shellPaths(i.CommandLine)) add(p, 'r'); break;
  }
  return out;
}

// One log line -> what its tool calls touched. Only assistant lines holding a tool_use are parsed: tool results (user lines) carry
// "tool_use_id" and are the bulk of the 15 GB of logs, so they are skipped by the prefix test before any JSON.parse.
export function lineTouched(line) {
  if (!line.startsWith('{"type":"assistant"') || !line.includes('"tool_use"')) return [];
  try { return (JSON.parse(line).message?.content || []).filter((b) => b?.type === 'tool_use').flatMap(touchedOf); } catch { return []; }
}

// Which listed project each touched path is in (deepest folder first, as convProject): paths: Map path -> 'w'|'r', dirs: resolved folders.
// -> { total: paths counted, by: Map dir -> { w, r } } (a path both written and read counts as written).
export function byProject(paths, dirs) {
  const deep = [...dirs].sort((a, b) => b.length - a.length), by = new Map();
  for (const [p, kind] of paths) {
    const d = deep.find((x) => p === x || p.startsWith(x + '/')); if (!d) continue;
    const e = by.get(d) || { w: 0, r: 0 }; e[kind === 'w' ? 'w' : 'r']++; by.set(d, e);
  }
  return { total: paths.size, by };
}

// A conversation is RELATED to a project it was not opened in (own) when it edited 2+ of its files, read 8+, or spent at least a quarter
// of everything it touched there (3 files at the least); a folder marked "Not related" for it (notRelated) never is.
// split: byProject's result -> [[dir, { w, r }]]
const isRelated = ({ w, r }, total) => w >= 2 || r >= 8 || (w + r >= 3 && w + r >= 0.25 * total);
export const relatedFor = (split, own, notRelated = []) => [...split.by].filter(([d, n]) => d !== own && !notRelated.includes(d) && isRelated(n, split.total));
