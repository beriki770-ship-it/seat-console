// Unit tests for the context meter: node console\test-context.mjs
// Event shapes and the /context text are the ones a real claude 2.1.x stream carries (fixtures/context-reply.md is a trimmed real reply, neutral text).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyCtx, parseTokens, parseContextReply, autoCompactAt, ctxLevel } from './context.mjs';

const asst = (usage, extra = {}) => ({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage }, parent_tool_use_id: null, ...extra });
const result = (mu) => ({ type: 'result', subtype: 'success', modelUsage: mu });

// usage -> used: input + cache read + cache creation + output of the LAST main-thread assistant message
{
  const ctx = {};
  assert.ok(applyCtx(ctx, { type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }, 1000));
  assert.ok(applyCtx(ctx, asst({ input_tokens: 10, cache_creation_input_tokens: 22367, cache_read_input_tokens: 23186, output_tokens: 4 }), 1001));
  assert.equal(ctx.used, 45567);
  assert.equal(ctx.window, undefined);                      // the window is only known once a result arrives
  assert.ok(applyCtx(ctx, result({ 'claude-haiku-4-5': { contextWindow: 200000 } }), 1002));
  assert.equal(ctx.window, 200000);
  assert.equal(ctx.autoCompactAt, 167000);
  assert.equal(ctx.updatedAt, 1002);
  console.log('ok  used = last assistant usage (incl. output), window from result.modelUsage, auto-compact = window - 33k');
}

// a later, bigger message replaces the number (it is NOT a running sum)
{
  const ctx = { model: 'claude-haiku-4-5', window: 200000, used: 45567 };
  applyCtx(ctx, asst({ input_tokens: 5, cache_read_input_tokens: 60000, cache_creation_input_tokens: 100, output_tokens: 50 }));
  assert.equal(ctx.used, 60155);
  console.log('ok  used replaces, never accumulates');
}

// events that must NOT move the number
{
  const ctx = { model: 'claude-haiku-4-5', window: 200000, used: 45567, updatedAt: 5 };
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.equal(applyCtx(ctx, { type: 'assistant', message: { model: '<synthetic>', usage: zero } }), false);   // /context and /compact replies
  assert.equal(applyCtx(ctx, asst({ input_tokens: 9, cache_read_input_tokens: 999999 }, { parent_tool_use_id: 'toolu_x' })), false); // a subagent has its own context
  assert.equal(applyCtx(ctx, { type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 0 } } }), false);
  assert.equal(applyCtx(ctx, asst({ input_tokens: 10, cache_read_input_tokens: 23186, cache_creation_input_tokens: 22367, output_tokens: 4 })), false); // same value again: no change, no broadcast
  assert.equal(applyCtx(ctx, { type: 'system', subtype: 'status', status: 'compacting' }), false);
  assert.equal(ctx.updatedAt, 5);
  console.log('ok  synthetic replies, subagent messages, zero usage and repeats leave ctx untouched');
}

// window: with several models in modelUsage the entry of the conversation's own model wins; a single entry is taken when the model is unknown
{
  const mu = { 'claude-sonnet-5-5': { contextWindow: 1000000 }, 'claude-haiku-4-5': { contextWindow: 200000 } };
  const a = { model: 'claude-haiku-4-5-20251001' }; applyCtx(a, result(mu)); assert.equal(a.window, 200000);
  const b = { model: 'claude-sonnet-5-5' }; applyCtx(b, result(mu)); assert.equal(b.window, 1000000);
  const c = {}; applyCtx(c, result({ 'claude-opus-5-5': { contextWindow: 1000000 } })); assert.equal(c.window, 1000000);
  const d = {}; assert.equal(applyCtx(d, result(mu)), false);   // ambiguous: no guess
  console.log('ok  window picked by model, never guessed when ambiguous');
}

// compaction: post_tokens right away, then the next assistant message takes over
{
  const ctx = { model: 'claude-haiku-4-5', window: 200000, used: 45801 };
  applyCtx(ctx, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 45801, post_tokens: 6136 } });
  assert.equal(ctx.used, 6136);
  console.log('ok  compact_boundary sets used to post_tokens');
}

assert.equal(autoCompactAt(1000000), 967000);
assert.equal(autoCompactAt(200000), 167000);
assert.equal(autoCompactAt(20000), null);
assert.equal(ctxLevel(59.9), 'green'); assert.equal(ctxLevel(60), 'yellow'); assert.equal(ctxLevel(80), 'yellow'); assert.equal(ctxLevel(80.1), 'red');
console.log('ok  auto-compact threshold and colour bands');

assert.deepEqual(['45.6k', '1M', '1.2M', '15k', '512', '< 20', '', null, 'abc'].map(parseTokens), [45600, 1000000, 1200000, 15000, 512, null, null, null, null]);
console.log('ok  parseTokens');

// the real /context reply
{
  const r = parseContextReply(fs.readFileSync(new URL('./fixtures/context-reply.md', import.meta.url), 'utf8'));
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.used, 45600); assert.equal(r.window, 200000); assert.equal(r.pct, 23);
  assert.equal(r.categories.length, 10);                    // the MCP / Skills tables after it are ignored
  assert.deepEqual(r.categories[0], { name: 'System prompt', tokens: 6600, pct: 3.3, deferred: false });
  assert.deepEqual(r.categories.find((c) => c.name === 'MCP tools (deferred)'), { name: 'MCP tools (deferred)', tokens: 39600, pct: 19.8, deferred: true });
  assert.equal(r.categories.at(-1).name, 'Free space');
  assert.equal(r.categories.at(-1).tokens, 154400);
  const counted = r.categories.filter((c) => !c.deferred && c.name !== 'Free space').reduce((s, c) => s + c.tokens, 0);
  assert.ok(Math.abs(counted - r.used) <= 2500, `categories (${counted}) add up to used (${r.used}) within rounding`);   // 43.1k vs 45.6k: the CLI's own estimate gap
  console.log('ok  /context reply parsed: model, tokens, window, 10 categories, deferred flagged, other tables ignored');
}
assert.equal(parseContextReply('hello'), null);
assert.equal(parseContextReply(undefined), null);
assert.deepEqual(parseContextReply('**Model:** m  \n**Tokens:** 597k / 1M (60%)\n').categories, []);
assert.equal(parseContextReply('**Tokens:** 597k / 1M (60%)').window, 1000000);
console.log('ok  parser rejects non-/context text, accepts a 1M window and a missing table');
