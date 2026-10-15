// Run: node console/test-paths.mjs. Asserts the preview detector finds the paths agents actually print.
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { findPaths } = createRequire(import.meta.url)('./public/paths.js');
const abs = 'C:\\Users\\you\\projects\\video\\demo\\build\\ep17\\out\\short2.mp4';
assert.deepEqual(findPaths('| 1. The straw | build\\ep17\\out\\short1.mp4 | 52 s |'), ['build\\ep17\\out\\short1.mp4']);
assert.deepEqual(findPaths(abs), [abs]);
assert.deepEqual(findPaths('see `out/a.png`, and **C:/x/y.pdf**.'), ['out/a.png', 'C:/x/y.pdf']);
assert.deepEqual(findPaths('https://example.com/a/b.png and notes.md'), []);
assert.deepEqual(findPaths('wrote /home/b/out/a.png and `/tmp/b.pdf`, not ~/d/e.png or and/or', true), ['/home/b/out/a.png', '/tmp/b.pdf']);   // POSIX host (Linux / macOS): absolute paths
assert.deepEqual(findPaths('wrote /c/b/out/a.png and C:/x/y.pdf'), ['C:/x/y.pdf']);   // Windows host: a `/`-rooted path is not a file there (unchanged)
console.log('paths ok');
