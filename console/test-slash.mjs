// slash.mjs: the "/" list (frontmatter, sources and their order, dedupe, overrides "off", hidden skills, plugins, project .claude/ up the tree,
// mtime cache) and the "@" snippets (validation, defaults when the file is missing or broken, an empty saved list stays empty).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { frontmatter, listSkills, validateSnippets, readSnippets, DEFAULT_SNIPPETS } from './slash.mjs';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-'));
const put = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const skill = (rel, desc, extra = '') => put(rel, `---\nname: ${path.basename(path.dirname(rel))}\ndescription: ${desc}\n${extra}---\n\n# body\n`);
try {
  // frontmatter
  assert.deepEqual(frontmatter('---\nname: a\ndescription: "quoted: yes"\n---\nx'), { name: 'a', description: 'quoted: yes' });
  assert.equal(frontmatter('---\ndescription: >\n  folded\n  lines\nother: 1\n---\n').description, 'folded lines');
  assert.equal(frontmatter('---\ndescription: |\n  one\n  two\n---\n').description, 'one\ntwo');
  assert.deepEqual(frontmatter('no frontmatter here'), {});

  const shared = path.join(home, '.claude'), cfg = path.join(home, '.claude-seats', 's1'), plug = path.join(home, 'plugcache', 'pl');
  skill('.claude/skills/a/SKILL.md', 'shared a');
  skill('.claude/skills/b/SKILL.md', 'shared b');
  skill('.claude/skills/quiet/SKILL.md', 'never typed', 'user-invocable: false\n');
  skill('.claude/skills/offone/SKILL.md', 'switched off');
  put('.claude/skills/folder-name/SKILL.md', '---\nname: other-name\ndescription: x\n---\n');   // claude uses the folder name (graphify/ vs graphify-windows)
  put('.claude/commands/cmd1.md', '---\ndescription: a shared command\n---\nDo it.');
  skill('.claude-seats/s1/skills/a/SKILL.md', 'seat a');   // the seat's own folder (not a link): wins over shared
  fs.symlinkSync(path.join(shared, 'commands'), path.join(cfg, 'commands'), 'junction');   // junction: no admin right needed on Windows   // linked to ~/.claude: reads as shared
  put('.claude-seats/s1/settings.json', JSON.stringify({ skillOverrides: { offone: 'off' }, enabledPlugins: { 'pl@market': true, 'gone@market': false } }));
  put('.claude-seats/s1/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'pl@market': [{ installPath: plug }], 'gone@market': [{ installPath: path.join(home, 'nope') }] } }));
  skill('plugcache/pl/skills/x/SKILL.md', 'plugin skill'); put('plugcache/pl/commands/y.md', '---\ndescription: plugin command\n---\n');
  skill('proj/.claude/skills/b/SKILL.md', 'project b');   // the repo root's .claude/ applies in its subfolder
  fs.mkdirSync(path.join(home, 'proj', 'sub'), { recursive: true });

  const list = listSkills({ configDir: cfg, shared, cwd: path.join(home, 'proj', 'sub'), home }), by = Object.fromEntries(list.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'b', 'cmd1', 'compact', 'context', 'folder-name', 'pl:x', 'pl:y'].sort());
  assert.equal(by.a.source, 'seat'); assert.equal(by.a.description, 'seat a');   // deduped: one row, the seat's
  assert.equal(by.b.source, 'project'); assert.equal(by.b.description, 'project b');
  assert.equal(by.cmd1.source, 'shared'); assert.equal(by['pl:x'].source, 'plugin'); assert.equal(by['pl:y'].description, 'plugin command');
  assert.equal(by.compact.source, 'builtin'); assert.equal(by.compact.key, 'slash.compact');
  assert.ok(!by.quiet && !by.offone && !by['other-name'], 'hidden, switched-off and frontmatter-named entries are not listed');
  // a seat whose skills/ is a link to ~/.claude: every skill reads as shared
  const cfg2 = path.join(home, '.claude-seats', 's2'); fs.mkdirSync(cfg2, { recursive: true }); fs.symlinkSync(path.join(shared, 'skills'), path.join(cfg2, 'skills'), 'junction');
  const l2 = listSkills({ configDir: cfg2, shared, cwd: '', home });
  assert.equal(l2.find((x) => x.name === 'a').source, 'shared'); assert.ok(l2.find((x) => x.name === 'offone'), 'no override in that seat');
  // mtime cache: a changed file is read again
  const f = path.join(shared, 'skills', 'b', 'SKILL.md'); fs.writeFileSync(f, '---\ndescription: changed\n---\n'); fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.equal(listSkills({ configDir: cfg2, shared, cwd: '', home }).find((x) => x.name === 'b').description, 'changed');

  // snippets
  const seats = ['ops', 'dev'];
  assert.deepEqual(validateSnippets([{ name: ' Status ', label: ' S ', text: 'a\r\nb', seats: ['ops', 'ops'] }], seats), [{ name: 'status', label: 'S', text: 'a\nb', seats: ['ops'] }]);
  assert.deepEqual(validateSnippets([{ name: 'x', text: 'y', seats: [] }], seats), [{ name: 'x', label: '', text: 'y' }]);
  assert.throws(() => validateSnippets({}, seats), /a list/);
  assert.throws(() => validateSnippets([{ name: 'bad name', text: 'x' }], seats), /must be/);
  assert.throws(() => validateSnippets([{ name: 'a', text: 'x' }, { name: 'A', text: 'y' }], seats), /twice/);
  assert.throws(() => validateSnippets([{ name: 'a', text: '  ' }], seats), /empty/);
  assert.throws(() => validateSnippets([{ name: 'a', text: 'x', seats: ['nope'] }], seats), /unknown seat/);
  assert.throws(() => validateSnippets([{ name: 'a', text: 'x'.repeat(8001) }], seats), /too long/);
  const sf = path.join(home, 'snippets.json');
  assert.equal(readSnippets(sf), DEFAULT_SNIPPETS);   // missing: the defaults
  assert.deepEqual(DEFAULT_SNIPPETS.map((s) => s.name), ['status', 'handoff', 'summary']); validateSnippets(DEFAULT_SNIPPETS, seats);
  fs.writeFileSync(sf, JSON.stringify({ snippets: [] })); assert.deepEqual(readSnippets(sf), []);   // deleted them all: stays empty
  fs.writeFileSync(sf, '{broken'); assert.equal(readSnippets(sf), DEFAULT_SNIPPETS);
  console.log('test-slash: all passed');
} finally { fs.rmSync(home, { recursive: true, force: true }); }
