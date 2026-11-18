// Codex account calls through `codex app-server` (JSON-RPC over stdio, the same channel the Codex TUI uses):
// account/rateLimits/read -> the 5-hour + weekly windows and the free "rate limit reset" credits;
// account/rateLimitResetCredit/consume -> spends ONE credit (a full reset of both windows). Only on the user's tap (with a confirm) in the console.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';

function rpc(method, params, { bin = process.env.CODEX_BIN || 'codex', timeout = 20000, env = {} } = {}) {   // env: { CODEX_HOME } of the seat's account
  return new Promise((resolve, reject) => {
    const cmd = /\.m?js$/.test(bin) ? [process.execPath, bin] : [bin];   // a .mjs CODEX_BIN (a test fake) runs under this node
    const p = spawn(cmd[0], [...cmd.slice(1), 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
    const done = (fn, v) => { clearTimeout(t); p.kill('SIGTERM'); fn(v); };
    const t = setTimeout(() => done(reject, new Error(`codex ${method}: no answer in ${timeout / 1000} s`)), timeout);
    p.on('error', (e) => done(reject, e));
    p.stdin.on('error', () => {});   // app-server gone before we wrote: the exit below answers
    p.on('exit', (code) => done(reject, new Error(`codex app-server exited (${code}) before answering ${method}`)));
    readline.createInterface({ input: p.stdout }).on('line', (l) => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m.id === 1) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n'); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(params ? { params } : {}) }) + '\n'); }
      else if (m.id === 2) m.error ? done(reject, new Error(`codex ${method}: ${m.error.message || JSON.stringify(m.error)}`)) : done(resolve, m.result);
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'seat-console', version: '1' } } }) + '\n');
  });
}

// -> { windows: { five_hour, seven_day } (console shape), resets: { available, credits: [{ id, title, expiresAt }] } }
export async function readCodexAccount(opts) {
  const r = await rpc('account/rateLimits/read', null, opts), rl = r?.rateLimits || {};
  const win = (w) => (w && typeof w.usedPercent === 'number' && w.resetsAt ? { utilization: w.usedPercent / 100, resetsAt: w.resetsAt } : undefined);
  const credits = (r?.rateLimitResetCredits?.credits || []).filter((c) => c.status === 'available').map((c) => ({ id: c.id, title: c.title || 'Reset', expiresAt: c.expiresAt || null }))
    .sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
  const windows = {}; if (win(rl.primary)) windows.five_hour = win(rl.primary); if (win(rl.secondary)) windows.seven_day = win(rl.secondary);
  return { windows, resets: { available: credits.length, credits } };
}

// Spends the credit that expires first (or the given one).
export async function consumeCodexReset(creditId, opts = {}) {
  if (!creditId) { const a = await readCodexAccount(opts); creditId = a.resets.credits[0]?.id; if (!creditId) throw new Error('no reset left'); }
  // Same seat + credit = same key: a repeated tap cannot spend a second credit.
  const h = crypto.createHash('sha256').update(`${opts.key || ''}:${creditId}`).digest('hex'), idempotencyKey = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  return rpc('account/rateLimitResetCredit/consume', { creditId, idempotencyKey }, opts);
}

// The models this login may use, as the Codex TUI lists them: [{ id, name, default }].
export async function codexModels(opts) {
  const r = await rpc('model/list', {}, opts);
  return (r?.data || r?.models || []).map((m) => ({ id: m.id || m.model, name: (m.displayName || m.id || '').trim(), default: !!m.isDefault })).filter((m) => m.id);
}
