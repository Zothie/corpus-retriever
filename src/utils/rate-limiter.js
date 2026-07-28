// Per-source outbound-request rate limiter for the public academic APIs
// (CrossRef, PubMed/NCBI eutils, arXiv, bioRxiv).
//
// Why this lives here (the outbound-HTTP layer): a single search fans out across
// every selected source, and callers issue those searches concurrently. Without
// pacing, N queries => up to N concurrent requests per source, flooding the public
// hosts. Because every caller reaches the same fetcher functions in
// academic-apis.js inside ONE process, a module-level limiter keyed by source id
// is shared across all of them and is the correct, complete choke point. A limiter
// at any one call site would miss the others and would not protect the hosts.
//
// Design: per-source min-interval reservation with additive jitter.
//   slot = max(now, nextSlotAt[source]); nextSlotAt[source] = slot + baseInterval + jitter
// The reservation is computed SYNCHRONOUSLY (no await before the read-modify-write of
// nextSlotAt), so under the single-threaded event loop any number of concurrent
// acquire() calls get strictly increasing, non-colliding slots and nextSlotAt never
// moves backwards. Each source has an independent clock + FIFO queue, so a saturated
// source (e.g. crossref) never delays another (e.g. arxiv).
//
// Jitter is only ADDED (never subtracted) to baseInterval, so spacing is always
// >= baseInterval: the instantaneous rate can never exceed the ceiling, and the
// randomized component de-synchronizes what would otherwise be a fixed grid so
// requests don't align into bursts.
//
// Dependency-free (Promise + setTimeout only) so it ships via the esbuild
// copyMcpServer whole-src copy with no install step.

// ---- Tunable constants (env-overridable, matching the marginalia/fetch-pages style) ----

// Base spacing between requests to a single source. 250ms => hard ceiling of 4 rps.
const BASE_INTERVAL_MS = Number(process.env.PAPER_RATE_BASE_INTERVAL_MS) || 250;

// Additive jitter, uniform in [0, JITTER_MS], applied to EVERY reserved slot.
// Default 150 => mean added 75ms => mean spacing 325ms => ~3.08 rps steady-state,
// still above 3 rps, never below the 250ms floor, and wide enough to break bursts.
const JITTER_MS = Number(process.env.PAPER_RATE_JITTER_MS) || 150;

// PubMed/NCBI eutils documents 3 requests/second without an API key. Respect the
// stricter of {NCBI 3 rps, our 3-4 rps target}: floor pubmed's base interval at
// 334ms (1000/334 = 2.99 rps) so even before jitter we stay <= 3 rps.
const PUBMED_MIN_INTERVAL_MS = Number(process.env.PAPER_RATE_PUBMED_MIN_INTERVAL_MS) || 334;

// Backpressure: cap the number of waiters queued per source. Past this, acquire()
// rejects immediately instead of growing the queue unbounded if a host stalls.
const MAX_QUEUE = Number(process.env.PAPER_RATE_MAX_QUEUE) || 200;

// Per-acquire safety cap: if the computed wait for a reserved slot exceeds this,
// reject rather than let a single request hang behind a huge backlog.
const MAX_WAIT_MS = Number(process.env.PAPER_RATE_MAX_WAIT_MS) || 120000;

// arXiv's API manual asks callers to "play nice and incorporate a 3 second delay"
// between requests, and enforces it: at the default ~325ms spacing arXiv starts
// answering with HTTP 429, and then with connection timeouts, so the source
// appears broken while the real problem is that we were hammering it.
const ARXIV_MIN_INTERVAL_MS = Number(process.env.PAPER_RATE_ARXIV_MIN_INTERVAL_MS) || 3000;

// Per-source base interval override map. Add entries here for any source with its
// own documented stricter limit.
const PER_SOURCE_MIN_INTERVAL_MS = {
  pubmed: PUBMED_MIN_INTERVAL_MS,
  arxiv: ARXIV_MIN_INTERVAL_MS,
  // Abstract-enrichment aggregators. Europe PMC is queried once per DOI, so it
  // sees the highest request count of any host here and gets the default
  // spacing; OpenAlex asks politely for <=10 rps in its docs, which the shared
  // default already satisfies. Both are listed explicitly so the keys are
  // documented rather than silently falling through.
  europepmc: BASE_INTERVAL_MS,
  openalex: BASE_INTERVAL_MS,
};

function defaultNow() {
  return Date.now();
}

// Injectable timer so tests can drive a fake clock. Returns a cancel function.
function defaultSetTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

export class RateLimitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RateLimitError';
    this.code = code;
  }
}

export class SourceRateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.baseIntervalMs]
   * @param {number} [opts.jitterMs]
   * @param {number} [opts.maxQueue]
   * @param {number} [opts.maxWaitMs]
   * @param {Record<string,number>} [opts.perSourceMinIntervalMs]
   * @param {() => number} [opts.now] injectable clock (ms) for tests
   * @param {(fn: () => void, ms: number) => (() => void)} [opts.setTimer] injectable timer for tests; must return a cancel fn
   * @param {() => number} [opts.random] injectable RNG in [0,1) for tests
   */
  constructor(opts = {}) {
    this.baseIntervalMs = opts.baseIntervalMs ?? BASE_INTERVAL_MS;
    this.jitterMs = opts.jitterMs ?? JITTER_MS;
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE;
    this.maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
    this.perSourceMinIntervalMs = opts.perSourceMinIntervalMs ?? PER_SOURCE_MIN_INTERVAL_MS;
    this.now = opts.now ?? defaultNow;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.random = opts.random ?? Math.random;
    // key -> { nextSlotAt, pending } ; lazily created so any new source id just works.
    this._sources = new Map();
  }

  _stateFor(key) {
    let s = this._sources.get(key);
    if (!s) {
      s = { nextSlotAt: 0, pending: 0 };
      this._sources.set(key, s);
    }
    return s;
  }

  _intervalFor(key) {
    // baseInterval, but never below a source's documented stricter floor.
    const floor = this.perSourceMinIntervalMs[key] ?? 0;
    return Math.max(this.baseIntervalMs, floor);
  }

  /**
   * Wait until this caller is allowed to make one request to `key`.
   * Resolves when the reserved slot is due. Rejects on backpressure, over-cap
   * wait, or abort.
   * @param {string} key source id (crossref|pubmed|arxiv|biorxiv|...)
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<void>}
   */
  acquire(key, { signal } = {}) {
    const state = this._stateFor(key);

    // Fast-fail an already-aborted signal before reserving a slot.
    if (signal?.aborted) {
      return Promise.reject(this._abortError(signal));
    }

    // Backpressure: refuse to grow the per-source queue without bound.
    if (state.pending >= this.maxQueue) {
      return Promise.reject(
        new RateLimitError(
          `rate limiter queue full for source "${key}" (${state.pending} pending, max ${this.maxQueue})`,
          'RATE_LIMIT_BACKPRESSURE'
        )
      );
    }

    // --- SYNCHRONOUS reservation: no await between reading and writing nextSlotAt,
    // so concurrent acquires cannot collide and nextSlotAt is monotonic. ---
    const now = this.now();
    const interval = this._intervalFor(key);
    const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
    const slot = Math.max(now, state.nextSlotAt);
    state.nextSlotAt = slot + interval + jitter;
    const wait = slot - now;

    if (wait <= 0) {
      // Slot is due immediately; nothing to queue.
      return Promise.resolve();
    }

    // Reject rather than hang if the backlog would make this caller wait too long.
    if (wait > this.maxWaitMs) {
      return Promise.reject(
        new RateLimitError(
          `rate limiter wait ${wait}ms exceeds max ${this.maxWaitMs}ms for source "${key}"`,
          'RATE_LIMIT_MAX_WAIT'
        )
      );
    }

    state.pending += 1;

    return new Promise((resolve, reject) => {
      let cancelTimer = null;
      let onAbort = null;
      let settled = false;

      const cleanup = () => {
        state.pending -= 1;
        if (cancelTimer) cancelTimer();
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      if (signal) {
        onAbort = () => fail(this._abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }

      cancelTimer = this.setTimer(finish, wait);
    });
  }

  _abortError(signal) {
    // Prefer the signal's own reason when available (Node >=17.2 provides it).
    if (signal?.reason instanceof Error) return signal.reason;
    const err = new Error('rate limiter acquire aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    return err;
  }

  /** Test/introspection helper: number of waiters currently queued for a source. */
  pendingFor(key) {
    return this._sources.get(key)?.pending ?? 0;
  }
}

// Process-wide shared limiter used by the academic API fetchers. In-memory pacing
// is the right scope: a process restart resets the clock, which at worst emits one
// small initial burst -- far below any ban threshold and not worth persisting.
export const paperRateLimiter = new SourceRateLimiter();
