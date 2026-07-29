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
  const settled = await Promise.allSettled([
    resolveOaCandidates(doi, { email, coreApiKey }),
    ...names.map((name) => probeMirror(name, doi)),
  ]);

  const [oa, ...mirrors] = settled;
  if (oa.status === 'fulfilled' && Array.isArray(oa.value)) {
    for (const c of oa.value) {
      if (c && c.source && c.pdfUrl) hints.has[c.source] = c.pdfUrl;
    }
  }
  mirrors.forEach((r, i) => {
    // A rejected probe is `unknown` by omission -- see the asymmetry note above.
    if (r.status !== 'fulfilled') return;
    if (r.value === 'present') hints.has[names[i]] = true;
    else if (r.value === 'absent') hints.ruledOut.push(names[i]);
  });
  return hints;
}
