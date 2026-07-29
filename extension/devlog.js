// The retrieval trace: what happened, what the page looked like, and WHY each decision went
// the way it did.
//
// WHY THIS EXISTS, and why it is ON by default.
//
// Every investigation of this extension so far has been a guess dressed up as a diagnosis.
// A download reported "no sci-hub mirror served it" and the only way to learn what the page
// actually contained was to re-fetch it by hand, minutes later, in a different profile, and
// hope it looked the same. It usually did not: Sci-Hub alternates between a challenge and
// the article for the same url, so the evidence was gone by the time anyone looked. Wrong
// conclusions followed -- "upstream throttling" that was really a test timeout, a captcha
// marker that also appears on good pages, a duplicate file blamed on double-downloading.
//
// So the rule this file enforces is: NEVER RECONSTRUCT, RECORD. Every fetch records its
// status, size and the markers that were tested. Every tab records what the page looked like
// when it was opened, while it was waited on, and when it was given up. Every skip records
// the test that caused it. Reading one trace should answer "why did this fail" without
// running anything.
//
// Cost is a few hundred small objects per download, capped. That is cheaper than one wrong
// diagnosis.
//
// Read it from the worker console:
//   devDump()                      the whole trace, formatted
//   devReport()                    the raw events
//   devlog.enabled = false         turn it off for this worker

export const devlog = {
  enabled: true,
  events: [],
  t0: 0,
  // Ring buffer. A stuck retrieval polls a page every few hundred ms for a minute, so an
  // uncapped log would grow without bound in a worker that may live for hours.
  max: 800,
};

function push(ev) {
  if (!devlog.enabled) return;
  if (!devlog.t0) devlog.t0 = Date.now();
  ev.at = Date.now() - devlog.t0;
  devlog.events.push(ev);
  if (devlog.events.length > devlog.max) devlog.events.splice(0, devlog.events.length - devlog.max);
}

/** Start a timed span. Returns the label so callers can pass it straight to `devEnd`. */
export function devStart(label) {
  push({ kind: 'start', label });
  return label;
}

/** Close a span opened with `devStart`, recording how long it took. */
export function devEnd(label, detail) {
  if (!devlog.enabled) return;
  const started = [...devlog.events].reverse().find((e) => e.label === label && e.kind === 'start');
  const at = Date.now() - devlog.t0;
  push({ kind: 'end', label, ms: started ? at - started.at : null, detail });
}

/** A point event: a decision taken, a source skipped, a tab opened. */
export function devMark(label, detail) {
  push({ kind: 'mark', label, detail });
}

/**
 * A DECISION, with the evidence that drove it.
 *
 * This is the one that ends arguments. `verdict` is what was decided, `because` is the test
 * that decided it, and `evidence` is the values that test saw. A skip recorded without its
 * evidence is indistinguishable from a source that was never tried -- which is precisely
 * what made several of these bugs so expensive to find.
 */
export function devDecide(label, verdict, because, evidence) {
  push({ kind: 'decide', label, verdict, because, evidence });
}

/**
 * What came back from the network, before anything interpreted it.
 *
 * Records the shape of the response rather than its body: status, byte count, the first few
 * bytes, and the content type. Enough to tell a PDF from a challenge page from an html
 * error, which is the distinction every one of these bugs turned on.
 */
export function devHttp(label, { url, status, bytes, magic, contentType, finalUrl, error }) {
  push({
    kind: 'http',
    label,
    detail: {
      url: short(url),
      status,
      bytes,
      magic,
      contentType,
      // Only when it differs -- a redirect is the whole story on some hosts and noise on the
      // rest.
      redirectedTo: finalUrl && finalUrl !== url ? short(finalUrl) : undefined,
      error,
    },
  });
}

/** A page's state at a moment, as captured by inPageSnapshot in the tab. */
export function devSnap(label, snap) {
  push({ kind: 'snap', label, detail: snap });
}

function short(u) {
  if (typeof u !== 'string') return u;
  return u.length > 110 ? `${u.slice(0, 107)}...` : u;
}

/** Everything recorded, for a test or the console to read back. */
export function devReport() {
  return { totalMs: devlog.t0 ? Date.now() - devlog.t0 : 0, events: devlog.events };
}

export function devReset() {
  devlog.events = [];
  devlog.t0 = 0;
}

/**
 * The trace as one readable table.
 *
 * Formatted rather than raw because the point is to be read at a glance. A decision line
 * carries its verdict and the evidence on the same row, so "why did it skip this" never
 * requires cross-referencing two other lines.
 */
export function devDump() {
  const rows = devlog.events.map((e) => {
    const t = `${(e.at / 1000).toFixed(2)}s`.padStart(8);
    if (e.kind === 'decide') {
      const ev = e.evidence ? ` ${JSON.stringify(e.evidence)}` : '';
      return `${t}  ${e.label.padEnd(22)} ${String(e.verdict).toUpperCase().padEnd(9)} ${e.because}${ev}`;
    }
    if (e.kind === 'http') {
      const d = e.detail;
      const red = d.redirectedTo ? ` -> ${d.redirectedTo}` : '';
      const err = d.error ? ` ERROR ${d.error}` : '';
      return `${t}  ${e.label.padEnd(22)} http=${String(d.status ?? '-').padEnd(4)} `
        + `${String(d.bytes ?? '-').padStart(8)}B ${JSON.stringify(d.magic ?? '')} ${d.url}${red}${err}`;
    }
    if (e.kind === 'snap') {
      const d = e.detail || {};
      return `${t}  ${e.label.padEnd(22)} PAGE  ${JSON.stringify(d)}`;
    }
    if (e.kind === 'end') {
      return `${t}  ${e.label.padEnd(22)} ${`${e.ms}ms`.padEnd(9)} ${e.detail ? JSON.stringify(e.detail) : ''}`;
    }
    if (e.kind === 'start') return `${t}  ${e.label.padEnd(22)} ...`;
    return `${t}  ${e.label.padEnd(22)} ${e.detail ? JSON.stringify(e.detail) : ''}`;
  });
  return rows.join('\n');
}
