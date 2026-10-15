// Finds file paths a message names (absolute `C:\x\y.mp4`, POSIX `/home/x/y.mp4` or relative `out\y.mp4`, bare or inside backticks / tables).
// Kept apart from app.js so a plain Node test can load it without a DOM.
const FILE_EXT = 'mp4|webm|mov|png|jpe?g|gif|webp|svg|pdf|html|txt|md|srt|json';
// A relative path needs a folder part (a bare "notes.md" is usually prose); the lookbehind keeps URLs and word tails out.
const FILE_RE = new RegExp(`(?<![\\w:/\\\\.])(?:[A-Za-z]:[\\\\/]|[\\w.\\-]+[\\\\/])[^\\s|\`"'<>*?]*?\\.(?:${FILE_EXT})(?![\\w])`, 'gi');
// A Linux / macOS host also names `/`-rooted paths (`~/` ones stay out: not resolvable here). Only there: on Windows a `/c/...` or `/api/x.json` is no file.
const FILE_RE_POSIX = new RegExp(`(?<![\\w:/\\\\.~])(?:[A-Za-z]:[\\\\/]|/|[\\w.\\-]+[\\\\/])[^\\s|\`"'<>*?]*?\\.(?:${FILE_EXT})(?![\\w])`, 'gi');
function findPaths(text, posix) {
  return [...new Set(String(text).match(posix ? FILE_RE_POSIX : FILE_RE) || [])];
}
const fileKind = (p) => { const e = p.split('.').pop().toLowerCase(); return /^(mp4|webm|mov)$/.test(e) ? 'video' : /^(png|jpe?g|gif|webp|svg)$/.test(e) ? 'image' : 'doc'; };
if (typeof module !== 'undefined') module.exports = { findPaths, fileKind };
