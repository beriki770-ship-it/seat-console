// The composer's "/" and "@" lists.
// "/": the skills and slash commands a Claude seat really has, read from the same places its claude reads them: the seat's CLAUDE_CONFIG_DIR
// (~/.claude-seats/<seat>: skills/, commands/, enabled plugins), the shared ~/.claude, and .claude/ in the conversation's folder and its parents.
// Measured 2026-11-24 on the ops seat: a plain "/caveman" sent over stream-json loads the skill (transcript: <command-name>/caveman</command-name> +
// the skill text as a meta message), so the page sends "/name args" as typed; nothing is rewritten.
// "@": saved snippets (<data>/snippets.json, the owner's own text, gitignored like settings.json); picking one puts its full text into the box.
import fs from 'node:fs';
import path from 'node:path';

// Frontmatter between the first two "---" lines: flat "key: value", folded/literal blocks (">", "|") and quoted values. Enough for SKILL.md / command .md.
export function frontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!m) return {};
  const out = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]); if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) {   // a block: the indented lines under the key
      const blk = []; while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) blk.push(lines[++i].trim());
      v = blk.join(v[0] === '>' ? ' ' : '\n').trim();
    } else if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
    out[kv[1]] = v;
  }
  return out;
}

const cache = new Map();   // file -> { mtimeMs, meta }: a file is parsed again only when it changed
function meta(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file); if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta;
  let fm = {}; try { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(8192), n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); fm = frontmatter(b.subarray(0, n).toString('utf8')); } catch {}
  const m = { description: String(fm.description || '').replace(/\s+/g, ' ').trim().slice(0, 240), hidden: fm['user-invocable'] === 'false' };
  cache.set(file, { mtimeMs: st.mtimeMs, meta: m }); return m;
}
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name); } catch { return []; } };
const mds = (d) => { try { return fs.readdirSync(d).filter((n) => n.endsWith('.md') && !n.startsWith('.')); } catch { return []; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };

// Skills (<dir>/skills/*/SKILL.md) and commands (<dir>/commands/*.md) of one root; prefix = "plugin:" for a plugin's own.
function scan(root, source, prefix, add) {
  for (const n of dirs(path.join(root, 'skills'))) { const m = meta(path.join(root, 'skills', n, 'SKILL.md')); if (m && !m.hidden) add(prefix + n, m.description, source, 'skills'); }   // the folder name is the command (claude's init list: graphify/, whose SKILL.md says graphify-windows, is /graphify)
  for (const f of mds(path.join(root, 'commands'))) { const m = meta(path.join(root, 'commands', f)); if (m && !m.hidden) add(prefix + f.slice(0, -3), m.description, source, 'commands'); }
}

// Built-in commands that work in the console's headless claude: the console runs these itself (server.mjs runSlash), only while the chat is idle.
export const BUILTINS = [{ name: 'compact', key: 'slash.compact' }, { name: 'context', key: 'slash.context' }];

// configDir: the seat's CLAUDE_CONFIG_DIR; shared: ~/.claude; cwd: the conversation's folder (its .claude/ and its parents' up to home).
export function listSkills({ configDir, shared, cwd, home }) {
  const out = new Map(), off = readJson(path.join(configDir, 'settings.json'), {}).skillOverrides || {};
  const add = (name, description, source) => { if (!name || off[name] === 'off' || out.has(name)) return; out.set(name, { name, description, source }); };   // first one wins: project, seat, shared, plugin (claude's own order)
  // project: .claude/ in the folder and every parent below home (a repo's root .claude/ applies in its subfolders too)
  if (cwd) for (let d = path.resolve(cwd); d.startsWith(home + path.sep); d = path.dirname(d)) scan(path.join(d, '.claude'), 'project', '', add);   // + sep: /home/al2 is not under /home/al
  // skills/ and commands/ each: the seat's own folder, then ~/.claude ("shared"). A seat that only links both to ~/.claude reads them as shared.
  for (const sub of ['skills', 'commands']) {
    const pick = (root, source) => scan(root, source, '', (n, ds, s, kind) => kind === sub && add(n, ds, s));
    if (real(path.join(configDir, sub)) !== path.join(real(shared), sub)) pick(configDir, 'seat');
    pick(shared, 'shared');
  }
  // plugins switched on in the seat's settings.json, at the path its installed_plugins.json names
  const on = readJson(path.join(configDir, 'settings.json'), {}).enabledPlugins || {}, inst = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {}).plugins || {};
  for (const [id, yes] of Object.entries(on)) {
    const p = yes === true && inst[id]?.[0]?.installPath; if (!p) continue;
    scan(p, 'plugin', id.split('@')[0] + ':', add);
  }
  for (const b of BUILTINS) if (!out.has(b.name)) out.set(b.name, { name: b.name, key: b.key, source: 'builtin' });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
// ---- "@" snippets ----
export const DEFAULT_SNIPPETS = [
  { name: 'status', label: 'Status', text: 'Give me a short status: what was done since my last message, what is still open, and what you need from me. Plain words, briefly.' },
  { name: 'handoff', label: 'Update HANDOFF', text: "Update the project's docs/HANDOFF.md: where things stand, what changed, what is left and what to know. Then tell me in one line what you changed." },
  { name: 'summary', label: 'Summarise the chat', text: 'Summarise this conversation so far in 5 short points: decisions, results, and what is still open.' },
];
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// The whole list, as the Settings page sends it. Throws with the first problem; returns the clean list.
export function validateSnippets(list, seatNames) {
  if (!Array.isArray(list)) throw new Error('snippets: a list is expected');
  if (list.length > 100) throw new Error('snippets: at most 100');
  const seen = new Set();
  return list.map((s, i) => {
    const name = String(s?.name ?? '').trim().toLowerCase(), label = String(s?.label ?? '').trim(), text = String(s?.text ?? '').replace(/\r\n?/g, '\n');
    if (!NAME.test(name)) throw new Error(`snippet ${i + 1}: name "${name}" must be 1-32 letters a-z, digits, - or _`);
    if (seen.has(name)) throw new Error(`snippet ${i + 1}: name "${name}" is used twice`); seen.add(name);
    if (!text.trim()) throw new Error(`snippet "${name}": the text is empty`);
    if (text.length > 8000 || label.length > 80) throw new Error(`snippet "${name}": too long (text 8000, label 80 characters)`);
    const seats = Array.isArray(s.seats) ? [...new Set(s.seats.map(String).filter(Boolean))] : [];
    for (const n of seats) if (!seatNames.includes(n)) throw new Error(`snippet "${name}": unknown seat ${n}`);
    return { name, label, text, ...(seats.length ? { seats } : {}) };
  });
}
// Missing file = the defaults (the owner edits or deletes them in Settings > Snippets; a saved empty list stays empty).
export function readSnippets(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d.snippets) ? d.snippets : DEFAULT_SNIPPETS; } catch { return DEFAULT_SNIPPETS; }   // a hand-broken file: the defaults, until the next save
}
