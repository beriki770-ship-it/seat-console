// Crash bookkeeping for the Seat Console, kept free of server side effects so test-recovery.mjs can import it.
// state.cleanShutdown is false while the server runs and true only after a normal exit (SIGINT/SIGTERM/exit), so a
// value other than true at startup means the previous run died hard (power loss, kill -9).
// A conversation persisted as working has no process any more whichever way the server went down: it becomes `interrupted`.
// `liveHosts` = ids whose host process (host.mjs) is still alive: their claude kept running, so they stay `working`.
// Exit code 0 is a clean shutdown. So is the exit(1) of the uncaughtException handler: the process ended on purpose and its hosts kept running, so the next start must not
// send the "PC crashed, recover?" message for it (the error itself is still in the log).
export const isCleanExit = (code, uncaught) => code === 0 || !!uncaught;
export function markInterrupted(state, liveHosts = new Set()) {
  const crashed = state.cleanShutdown !== true;
  state.cleanShutdown = false;
  for (const c of Object.values(state.conversations)) if (c.working && !liveHosts.has(c.id)) { c.working = false; c.turns = 0; c.interrupted = true; }
  return crashed;
}
// An uncaught-exception exit counts as clean (hosts keep running), but one that follows a start less than a minute old is a crash loop that someone has to look at.
export const crashLoop = (state, now) => state.lastExit === 'uncaught' && !!state.lastStartAt && now - state.lastStartAt < 60000;
// The supervisor restarts a persistently failing server ~6 times a minute: the Telegram warning goes out at most once per 30 min (state.lastCrashWarnAt is persisted, so it survives those restarts). Marks the warning as sent when it returns true.
export function crashWarnDue(state, now, gapMs = 30 * 60000) {
  if (state.lastCrashWarnAt && now - state.lastCrashWarnAt < gapMs) return false;
  state.lastCrashWarnAt = now; return true;
}
