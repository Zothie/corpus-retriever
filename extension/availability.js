// "Who has this paper?", asked of every tab-free source at once.
//
// This exists to make the DOWNLOAD faster, not to report to the user. Today a paper the
// mirrors do not have costs three sequential probe walks before open access is tried at
// all; this asks everyone simultaneously and lets the ladder skip what it can.
//
// TAB-FREE ONLY. Publishers are deliberately absent: Mendeley, OUP and ACS can answer only
// by opening a real tab, and several tabs at once is the exact behaviour the user reported
// as a bug. Five publisher resolvers also funnel through doi.org, and the extension's rate
// limiter is a no-op stub, so parallelising them would concentrate load on one host.
//
// THE HINTS ARE NOT TRUTH. `ruledOut` means a source gave a DEFINITIVE negative -- a page
// that says outright it does not hold the paper, or an OA API that resolved with no pdf. A
// timeout, a 429 or a dead host is `unknown`, never `absent`. That asymmetry is what makes
// probing unpaced safe: a false negative then costs latency, because the ladder re-checks
// everything.
//
// This file names no mirror. It is inlined OUTSIDE the store build's fence, so a mirror name
// written here would survive the strip and the build would refuse to zip; the list is read
// from the fenced module at call time and is simply absent in the store package.

/** @returns {string[]} the probeable non-OA sources, empty when that tier is not built in. */
function probeableMirrors() {
  return typeof MIRROR_PROBE_NAMES === 'undefined' ? [] : MIRROR_PROBE_NAMES;
}

/**
 * @returns {Promise<{has: Record<string,string|true>, ruledOut: string[]}>} never throws
 */
export async function probeAvailability(doi, { email, coreApiKey } = {}) {
  const hints = { has: {}, ruledOut: [] };
  if (!doi) return hints;

  const names = probeableMirrors();
  // Return on the FIRST usable hint, and let the stragglers finish in the background.
  //
  // Waiting for all of them is waiting for the slowest, and the whole point of the hint is
  // to start the download sooner. Measured live: the first source answered "present" at 1452ms
  // while the group did not settle until 2258ms, so 806ms of the probe cost bought an answer
  // nobody was going to act on -- the ladder was always going to try that first source next.
  //
  // The stragglers are NOT cancelled. They are cheap GET requests already in flight, they
  // populate the same `hints` object if they land in time to matter, and aborting them would
  // buy nothing while adding a cancellation path to get wrong. What changes is only that
  // nobody WAITS for them.
  const settle = [];
  let resolveFirst;
  const firstUsable = new Promise((r) => { resolveFirst = r; });

  const noteOa = (list) => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (c && c.source && c.pdfUrl) {
        hints.has[c.source] = c.pdfUrl;
        resolveFirst();
      }
    }
  };
  const noteMirror = (name, verdict) => {
    if (verdict === 'present') {
      hints.has[name] = true;
      resolveFirst();
    } else if (verdict === 'absent') {
      hints.ruledOut.push(name);
    }
  };

  settle.push(
    resolveOaCandidates(doi, { email, coreApiKey }).then(noteOa, () => {}),
    ...names.map((name) => probeMirror(name, doi).then((v) => noteMirror(name, v), () => {})),
  );

  // Whichever comes first: a source that says it HAS the paper, or every source finishing.
  // The second arm is what makes a total miss still return -- and return with the negatives
  // the ladder needs in order to skip anything.
  await Promise.race([firstUsable, Promise.allSettled(settle)]);
  return hints;
}
