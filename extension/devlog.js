// Timing and tracing for the worker, off by default.
//
// WHY THIS EXISTS. Every investigation so far has meant writing a throwaway harness to bolt
// timers onto the ladder, because the worker's 13 console calls carry no timings and no
// phase boundaries. That is how a 66-second download was reported as "works": the parts all
// passed and nobody could see where the seconds went. With this on, one run said probe=759ms
// / retrieve=58s and the real problem was obvious immediately.
//
// OFF BY DEFAULT, and the check is a plain boolean read, so a disabled call costs one branch.
// Turn it on from the worker console or a test:
//
//   chrome.storage.session.set({ devlog: true })   // survives worker eviction
//   devlog.enabled = true                          // this worker only, immediate
//
// Deliberately NOT wired to a build flag: the bug that matters is usually in the user's own
// browser with the shipped build, and asking them to reinstall a debug build to reproduce it
// is how a report goes cold.

export const devlog = {
  enabled: false,
  // Marks for the retrieval in progress, so a whole download reads as one table rather than
  // interleaved lines. Keyed by nothing: one retrieval at a time is the normal case, and a
  // second concurrent one simply appends -- its label carries the doi.
  marks: [],
  t0: 0,
};

/** Start a timed span. Returns the label so callers can pass it straight to `devEnd`. */
export function devStart(label) {
  if (!devlog.enabled) return label;
  if (!devlog.t0) devlog.t0 = Date.now();
  devlog.marks.push({ label, at: Date.now() - devlog.t0, phase: 'start' });
  return label;
}

/** Close a span opened with `devStart`, recording how long it took. */
export function devEnd(label, detail) {
  if (!devlog.enabled) return;
  const started = [...devlog.marks].reverse().find((m) => m.label === label && m.phase === 'start');
  const at = Date.now() - devlog.t0;
  devlog.marks.push({
    label, at, phase: 'end', ms: started ? at - started.at : null, detail,
  });
  const ms = started ? `${at - started.at}ms` : '?';
  console.log(`[devlog] ${label} ${ms}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
}

/** A point event -- a decision taken, a source skipped, a tab opened. */
export function devMark(label, detail) {
  if (!devlog.enabled) return;
  if (!devlog.t0) devlog.t0 = Date.now();
  const at = Date.now() - devlog.t0;
  devlog.marks.push({ label, at, phase: 'mark', detail });
  console.log(`[devlog] ${label} @${at}ms${detail ? ` ${JSON.stringify(detail)}` : ''}`);
}

/** Everything recorded since the last reset, for a test or the console to read back. */
export function devReport() {
  return { totalMs: devlog.t0 ? Date.now() - devlog.t0 : 0, marks: devlog.marks };
}

export function devReset() {
  devlog.marks = [];
  devlog.t0 = 0;
}
