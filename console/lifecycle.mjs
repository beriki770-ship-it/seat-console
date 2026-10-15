// Process lifecycle of a conversation (stop / lost host / start / make room), kept out of server.mjs (which starts a server on import) so test-lifecycle.mjs can run it
// against fakes. The one rule that matters: a stop and a start of the SAME conversation may overlap in time (the user stops and sends again at once).
// Every teardown therefore publishes `r.stopping` (a promise), ensureProc waits for it before it spawns, and a teardown only cleans the host files or touches the
// status when nothing new has been started in the meantime (`!r.proc && !r.starting`) - otherwise it would delete the NEW host's files or zero its turns.
export function createLifecycle(d) {
  const { R, convs, QUIET_MS, MAX_PER_SEAT } = d;

  // ---- who counts against the seat's cap ----
  // A silent host (alive, never answered after a console restart) owns a claude.exe too: it counts until it is killed.
  const hasProc = (c) => { const r = R(c); return !!(r.proc || r.starting || r.silent); };
  const liveOf = (seat) => convs().filter((c) => c.seat === seat && hasProc(c));
  // `r.done` = a finished-notification still pending: stopping the conversation now would drop it.
  const isBusy = (c) => { const r = R(c); return !!(c.working || c.bg?.length || r.perms.size || r.starting || r.done || (r.silent && !r.silentGaveUp) || Date.now() - r.activityAt < QUIET_MS); };
  const busyCount = (seat) => liveOf(seat).filter(isBusy).length;

  // Publish a teardown as `r.stopping`; it never rejects and clears itself when it is still the current one.
  function track(r, run) {
    const t = r.stopping = run.catch(() => {}).then(() => { if (r.stopping === t) r.stopping = null; });
    return t;
  }
  const cleanIfIdle = (c) => { const r = R(c); if (!r.proc && !r.starting) d.cleanHostFiles(c); };

  // The host of a conversation we are not connected to is still running: kill it (and its claude) by pid.
  function killSilent(c) {
    const r = R(c), hi = d.hostInfoOf(c);
    r.silent = false; r.silentGaveUp = false;
    if (!hi || !(hi.remote || d.pidAlive(hi.pid))) return Promise.resolve();   // a remote host's pid is not a local one: the guarded remote kill checks it there
    return track(r, (async () => { await d.killHostPid(hi.pid, c); await d.killClaudePid(hi.claudePid, c); cleanIfIdle(c); })());
  }

  function killProc(c) {
    const r = R(c), p = r.proc;
    if (!p) return r.stopping || (r.starting ? Promise.resolve() : killSilent(c));
    r.proc = null; c.baseCost = (c.baseCost || 0) + r.procCost; r.procCost = 0; r.perms.clear(); c.bg = []; // its background agents die with it
    p.link.close();
    return track(r, (async () => {
      await d.killHostPid(p.hostPid, c); // host first: a live host would write an exit file for the claude we kill next
      await d.killTree(p.pid, c);        // tree: claude's tools are children
      cleanIfIdle(c);                 // after the kills: a file still open in a dying host would stay "delete pending" and block the next spawn's files
    })());
  }

  // The host vanished while we were connected. The state change is made at once (nothing can have started yet), only the kills and the file cleanup wait.
  function hostLost(c) {
    const r = R(c), p = r.proc; if (!p) return Promise.resolve();
    r.proc = null; p.link.close(); r.perms.clear(); c.bg = []; r.clampAt = 0;
    if (c.working) { d.clearTurns(c); c.interrupted = true; d.pushEvent(c, { type: 'console_error', text: 'seat host stopped unexpectedly: the turn was interrupted, use recover to continue it' }); d.setStatus(c, 'interrupted'); }
    else d.setStatus(c, 'stopped');
    return track(r, (async () => { await Promise.all([d.killClaudePid(p.pid, c), d.killHostPid(p.hostPid, c)]); cleanIfIdle(c); d.log(`[host] seat=${c.seat} conv=${c.id.slice(0, 8)}: host lost`); })());
  }

  // Explicit Stop: wait for a start in progress (the process it creates is what gets stopped), then stop; status only if nothing new started meanwhile.
  async function stopConv(c) {
    const r = R(c);
    if (r.starting) await r.starting.catch(() => {});
    const was = c.working;
    await killProc(c);
    r.done = null; // an explicit Stop drops the pending "finished" message
    if (was) d.pushEvent(c, { type: 'console_error', text: 'Stopped by user' });
    if (!r.proc && !r.starting) { d.clearTurns(c); r.clampAt = 0; d.setStatus(c, 'stopped'); }
  }
  async function stopIdle(c, why) {
    const r = R(c);
    await killProc(c);
    if (!r.proc && !r.starting) { c.interrupted = false; d.setStatus(c, 'stopped'); }
    d.log(`[idle] ${why} seat=${c.seat} conv=${c.id.slice(0, 8)}`);
  }

  // Eviction is serialized per seat: two starts must not both pick the same idle conversation (the second would find it already gone and exceed the cap).
  const chains = new Map();
  function makeRoom(c) {
    const run = (chains.get(c.seat) || Promise.resolve()).then(() => makeRoomNow(c));
    chains.set(c.seat, run.catch(() => {}));
    return run;
  }
  async function makeRoomNow(c) {
    for (;;) {
      const live = liveOf(c.seat).filter((x) => x !== c);
      if (live.length < MAX_PER_SEAT) return;
      const idle = d.pickIdle(live, isBusy, (x) => R(x).lastAt);
      if (!idle) throw new Error(`Seat '${c.seat}' already has ${MAX_PER_SEAT} conversations with work in progress. Wait for one to finish or stop it.`);
      await stopIdle(idle, 'stopped to make room');
    }
  }

  // Concurrent callers (two messages at once, a routine and a reply) share one start. `starting` is set synchronously, so a teardown that finishes later sees it.
  function ensureProc(c) {
    const r = R(c);
    if (r.proc) return;
    if (r.starting) return r.starting;
    return r.starting = (async () => {
      try {
        await null; // first suspension: a throw below must not run `finally` before `r.starting` has been assigned (it would then stay set for ever)
        while (r.stopping) await r.stopping;
        const hi = d.hostInfoOf(c);
        if (hi && (hi.remote || d.pidAlive(hi.pid))) {   // remote: its local record exists only while the host may still run there (removed once it is known gone)
          // Silent host: while the console is still knocking, starting a second claude beside it would fork the session; once it gave up, the host is dead weight.
          if (!r.silentGaveUp) throw new Error('The seat host of this conversation is running but not answering yet; the console is retrying, try again in a minute.');
          await killSilent(c);
        }
        await makeRoom(c); await d.startProc(c);
      } finally { r.starting = null; }
    })();
  }

  return { hasProc, liveOf, isBusy, busyCount, killProc, killSilent, hostLost, stopConv, stopIdle, makeRoom, ensureProc };
}
