#!/usr/bin/env node
// Native-messaging host bridging a local desktop client to the Corpus Retriever extension.
//
//   desktop client --unix socket--> [this host] --stdio native messaging--> extension
//
// Chrome spawns this process when the extension calls connectNative(), so stdin
// and stdout belong to the native-messaging protocol and NOTHING else may write
// to stdout. All diagnostics go to stderr, which Chrome routes to its own log.
//
// The extension streams a successful result as a header plus N base64 chunks
// (see chrome-extension/README.md); this host reassembles them and answers the
// socket client that asked.
//
// Two request kinds cross the socket, selected by the request's `kind` field
// (absent means "pdf"):
//   pdf   -> fetch_pdf   -> fetch_pdf_result header + fetch_pdf_chunk frames
//   links -> fetch_links -> a single fetch_links_result frame carrying hrefs
// Both share the pending-request table, the load shedding and the timeout; only
// the reassembly belongs to the pdf kind.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { isAllowedUrl } from './allowed-hosts.js';

// Chrome's own extension-to-host cap is 64 MiB. Anything claiming more than
// that is either a bug or an attempt to make this process allocate wildly, so
// refuse before reading it.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
// 80 MB PDF ceiling in the extension inflates to ~107 MB of base64. Cap the
// reassembly buffer a little above that: a buggy or hostile extension must not
// be able to grow a pending request without bound.
const MAX_BASE64_CHARS = 120 * 1024 * 1024;
// Same 256 KiB slice the extension uses, so a declared `chunks` count can be
// sanity-checked against the payload it is supposed to carry.
const CHUNK_CHARS = 256 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_BASE64_CHARS / CHUNK_CHARS) + 1;
// Must stay ABOVE the client's DEFAULT_TIMEOUT_MS (src/tools/ssrn-extension-client.js),
// with room for the transfer on top. Otherwise the host gives up first and the client's
// budget is inert -- which is exactly what raising the client to 180s against this at 120s
// produced, silently capping every publisher at 120s again. The client is the layer that
// decides how long a publisher is worth waiting for; this is only a backstop against a
// wedged extension, so it must never be the binding constraint.
//
// The client now allows an hour so a human can solve a captcha, so this is that hour plus a
// transfer margin. Whenever one of these two moves, the other must move with it.
const DEFAULT_REQUEST_TIMEOUT_MS = 3900000;
// A single newline-delimited request is a small JSON object. Anything larger is
// a client that will never send a newline, so drop it rather than buffer it.
const MAX_SOCKET_LINE_BYTES = 64 * 1024;
// Bounding the request LINE is not enough: a client can pipeline lines faster
// than Chrome answers them, and every accepted one holds a pending entry, a
// timer and eventually a reassembly buffer. Cap the count too.
const MAX_PENDING_TOTAL = 64;
const MAX_PENDING_PER_CLIENT = 16;
// Mirrors the extension's own fetch_links bounds. Re-applied here because the
// extension is the far side of a channel this process does not control, and the
// The client downstream would otherwise trust whatever arrives.
const MAX_LINKS = 50;
const MAX_LINK_CHARS = 2048;

/**
 * The two request kinds a socket client may ask for. `pdf` streams a header plus
 * base64 chunks back; `links` is answered by a single small frame. They are kept
 * apart in `pending` by req.kind so a reply of the wrong shape for an id can
 * never be folded into the other one's state machine.
 */
const REQUEST_KINDS = new Set(['pdf', 'links', 'reload', 'search', 'retrieve', 'download', 'devlog']);

/**
 * True when both are parseable URLs with the same scheme, host and port. Used to
 * re-check the extension's same-origin rule on the way back: a link harvested
 * from a credentialed page must not be able to point anywhere but that page's
 * own origin. Anything unparseable is false.
 */
export function sameOrigin(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Encodes one native message: 4-byte little-endian length, then UTF-8 JSON. */
export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Pure incremental decoder. Takes { buffer, messages } and a new chunk and
 * returns a fresh state whose `messages` are only the ones completed by this
 * chunk. The input state is never mutated, so a caller can keep the old one.
 */
export function decodeFrames(state, chunk) {
  let buffer = state.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.buffer, chunk]);
  const messages = [];
  for (;;) {
    if (buffer.length < 4) break;
    const len = buffer.readUInt32LE(0);
    if (len > MAX_FRAME_BYTES) {
      // The stream is desynchronised or the peer is hostile; the caller cannot
      // recover a frame boundary from here.
      const err = new Error(`frame too large: ${len} bytes`);
      err.code = 'FRAMING';
      throw err;
    }
    if (buffer.length < 4 + len) break;
    const body = buffer.subarray(4, 4 + len).toString('utf8');
    buffer = buffer.subarray(4 + len);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (cause) {
      // A well-framed frame with a bad body is NOT a desync: the buffer has
      // already advanced past it and the next frame starts cleanly. Carry the
      // recoverable state on the error so the caller can drop just this
      // message instead of tearing down every concurrent transfer.
      const err = new Error(`invalid json in frame: ${cause.message}`);
      err.code = 'INVALID_JSON';
      err.state = { buffer, messages };
      throw err;
    }
    messages.push(parsed);
  }
  return { buffer, messages };
}

// --- runtime ----------------------------------------------------------------

function log(...parts) {
  // stderr only. Writing to stdout would be interpreted as a native message and
  // Chrome would kill the connection.
  process.stderr.write(`[ssrn-native-host] ${parts.join(' ')}\n`);
}

/**
 * The directory both sides of the bridge must agree on. Exported so the client
 * client derives it from this one definition instead of a copy that can drift.
 */
export function socketDirFor() {
  if (process.env.SSRN_BRIDGE_SOCKET_DIR) return process.env.SSRN_BRIDGE_SOCKET_DIR;
  // userInfo().username rather than $USER: Chrome does not necessarily pass a
  // useful environment to the host it spawns.
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {
    // Fall through to the placeholder; the pid still makes the socket unique.
  }
  // Literal /tmp, not os.tmpdir(): that honours TMPDIR, and Chrome's
  // environment is not the client's. The socket has to live at an address
  // both sides can derive independently.
  return path.join('/tmp', `ssrn-bridge-${user}`);
}

/**
 * Removes <pid>.sock files whose owning process is gone. A SIGKILLed host
 * cannot unlink its own socket, and the client discovers the bridge by
 * scanning this directory: a stale entry would make it connect to nothing.
 */
function sweepStaleSockets(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = /^(\d+)\.sock$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      // Signal 0 checks for existence without delivering anything.
      process.kill(pid, 0);
      continue;
    } catch (err) {
      // EPERM means the pid exists but belongs to someone else; leave it.
      if (err.code === 'EPERM') continue;
    }
    try {
      fs.unlinkSync(path.join(dir, name));
      log(`removed stale socket ${name}`);
    } catch {
      // Raced with another host doing the same sweep.
    }
  }
}

function main() {
  const requestTimeoutMs = Number(process.env.SSRN_BRIDGE_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS;
  const socketDir = socketDirFor();
  const socketPath = path.join(socketDir, `${process.pid}.sock`);

  // 0700 both on create and afterwards: mkdir honours the umask, so an
  // inherited 022 would otherwise leave it group/world readable, and the socket
  // is the trust boundary for "fetch as the logged-in user".
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  sweepStaleSockets(socketDir);

  /**
   * Pending requests keyed by the id THIS host minted for Chrome. Socket
   * clients pick their own ids and two of them can easily collide (a client is
   * not the only possible client), so the client id is only ever echoed back,
   * never used for routing.
   */
  const pending = new Map();

  function finish(hostId, reply) {
    const req = pending.get(hostId);
    if (!req) return;
    pending.delete(hostId);
    clearTimeout(req.timer);
    req.socketState.pending.delete(hostId);
    if (req.socket.destroyed || !req.socket.writable) return;
    req.socket.write(`${JSON.stringify({ id: req.clientId, ...reply })}\n`);
  }

  function fail(hostId, error, extra) {
    // `extra` carries the per-source attempt log for a retrieval. Dropping it made a total
    // failure undiagnosable: "no source produced a valid pdf" with no indication of which
    // sources ran or why each declined.
    finish(hostId, { ok: false, error, ...(extra || {}) });
  }

  // --- Chrome side ---------------------------------------------------------

  let stdinState = { buffer: Buffer.alloc(0), messages: [] };

  function sendToChrome(obj) {
    process.stdout.write(encodeFrame(obj));
  }

  function onChromeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const hostId = msg.id;
    const req = pending.get(hostId);
    // Unknown or already-settled id: the request timed out, its client went
    // away, or the extension is confused. Dropping is the only safe response;
    // buffering would be an unbounded memory sink keyed by attacker choice.
    if (!req) return;

    if (msg.type === 'devlog_result') {
      finish(hostId, { ok: true, report: msg.report });
      return;
    }
    if (msg.type === 'reload_extension_result') {
      finish(hostId, { ok: msg.ok === true });
      return;
    }
    if (msg.type === 'download_result') {
      if (req.kind !== 'download') {
        fail(hostId, `unexpected ${msg.type} for a ${req.kind} request`);
        return;
      }
      if (!msg.ok) {
        fail(
          hostId,
          typeof msg.error === 'string' ? msg.error : 'extension reported failure',
          Array.isArray(msg.attempts)
            ? { attempts: msg.attempts.slice(0, 40).map((a) => ({
              source: typeof a?.source === 'string' ? a.source.slice(0, 40) : 'unknown',
              error: typeof a?.error === 'string' ? a.error.slice(0, 300) : 'unknown',
            })) }
            : undefined,
        );
        return;
      }
      // No bytes cross this boundary: the file went straight to Chrome's Downloads. Only
      // the facts the caller needs to report it come back.
      finish(hostId, {
        ok: true,
        filename: typeof msg.filename === 'string' ? msg.filename.slice(0, 300) : 'paper.pdf',
        bytes: Number.isFinite(msg.bytes) ? msg.bytes : null,
        source: typeof msg.source === 'string' ? msg.source.slice(0, 40) : 'unknown',
        title: typeof msg.title === 'string' ? msg.title.slice(0, 500) : null,
      });
      return;
    }

    if (msg.type === 'retrieve_result') {
      if (req.kind !== 'retrieve') {
        fail(hostId, `unexpected ${msg.type} for a ${req.kind} request`);
        return;
      }
      if (!msg.ok) {
        fail(
          hostId,
          typeof msg.error === 'string' ? msg.error : 'extension reported failure',
          Array.isArray(msg.attempts)
            ? { attempts: msg.attempts.slice(0, 40).map((a) => ({
              source: typeof a?.source === 'string' ? a.source.slice(0, 40) : 'unknown',
              error: typeof a?.error === 'string' ? a.error.slice(0, 300) : 'unknown',
            })) }
            : undefined,
        );
        return;
      }
      // A file Chrome saved ITSELF carries no bytes, and that is a success, not an empty
      // failure. Some hosts answer a navigation with a Content-Disposition, so the browser
      // takes the response over and writes the file directly -- measured, a 2.8 MB paper
      // landed correctly in Downloads while this line reported "carried no pdf" and the
      // caller retried, which is where the duplicate copies came from.
      if (msg.savedByBrowser === true) {
        finish(hostId, {
          ok: true,
          savedByBrowser: true,
          filename: typeof msg.filename === 'string' ? msg.filename.slice(0, 200) : null,
          bytes: Number.isFinite(msg.bytes) ? msg.bytes : null,
          source: typeof msg.source === 'string' ? msg.source.slice(0, 40) : 'unknown',
        });
        return;
      }
      if (typeof msg.base64 !== 'string' || !msg.base64) {
        fail(hostId, 'retrieve_result carried no pdf');
        return;
      }
      finish(hostId, {
        ok: true,
        base64: msg.base64,
        bytes: Number.isFinite(msg.bytes) ? msg.bytes : null,
        source: typeof msg.source === 'string' ? msg.source.slice(0, 40) : 'unknown',
      });
      return;
    }

    if (msg.type === 'search_result') {
      // Same kind guard as below: a search reply landing on a pdf request would drive the
      // wrong state machine.
      if (req.kind !== 'search') {
        fail(hostId, `unexpected ${msg.type} for a ${req.kind} request`);
        return;
      }
      if (!msg.ok) {
        fail(hostId, typeof msg.error === 'string' ? msg.error : 'extension reported failure');
        return;
      }
      if (!Array.isArray(msg.groups)) {
        fail(hostId, 'search_result carried no groups array');
        return;
      }
      // Search results are METADATA, not URLs this process will fetch, so there is no
      // allowlist to re-apply here -- the extension already chose its own endpoints. What
      // is re-applied is shape: only the fields the client expects survive, so a buggy or
      // replaced extension cannot smuggle extra keys into the studio's records.
      const groups = msg.groups.slice(0, 16).map((g) => ({
        source: typeof g.source === 'string' ? g.source.slice(0, 40) : 'unknown',
        error: typeof g.error === 'string' ? g.error.slice(0, 300) : undefined,
        results: Array.isArray(g.results)
          ? g.results.slice(0, 200).map((r) => ({
            title: typeof r.title === 'string' ? r.title.slice(0, 500) : '',
            doi: typeof r.doi === 'string' ? r.doi.slice(0, 200) : null,
            url: typeof r.url === 'string' ? r.url.slice(0, 500) : null,
            pdfUrl: typeof r.pdfUrl === 'string' ? r.pdfUrl.slice(0, 500) : null,
            authors: Array.isArray(r.authors)
              ? r.authors.filter((a) => typeof a === 'string').slice(0, 50).map((a) => a.slice(0, 120))
              : [],
            year: typeof r.year === 'string' ? r.year.slice(0, 10) : null,
            abstract: typeof r.abstract === 'string' ? r.abstract.slice(0, 8000) : null,
            // Both were missing from this re-shaper, so the adapters populated them and the
            // host silently dropped them -- the field allowlist is deliberate, but an
            // omission here is indistinguishable from an index not sending the data.
            venue: typeof r.venue === 'string' ? r.venue.slice(0, 300) : null,
            citationCount: Number.isFinite(r.citationCount) ? r.citationCount : null,
            source: typeof r.source === 'string' ? r.source.slice(0, 40) : 'unknown',
          }))
          : [],
      }));
      finish(hostId, { ok: true, groups });
      return;
    }

    if (msg.type === 'fetch_links_result') {
      // A links reply for a pdf request (or the reverse) means the extension is
      // confused or something else is on the port. Fail the id rather than let
      // one kind's frames drive the other's state.
      if (req.kind !== 'links') {
        fail(hostId, `unexpected ${msg.type} for a ${req.kind} request`);
        return;
      }
      if (!msg.ok) {
        fail(hostId, typeof msg.error === 'string' ? msg.error : 'extension reported failure');
        return;
      }
      if (!Array.isArray(msg.links)) {
        fail(hostId, 'fetch_links_result carried no links array');
        return;
      }
      // Re-apply the whole contract, not just the size caps. The extension is the
      // far side of a channel this process does not control, so the same-origin
      // and allowlist rules are enforced again here: without that, an extension
      // that is buggy or has been replaced could hand the client arbitrary URLs
      // harvested from a page the user's cookies opened.
      const links = msg.links
        .filter((l) => typeof l === 'string' && l.length > 0 && l.length <= MAX_LINK_CHARS)
        .filter((l) => sameOrigin(l, req.url) && isAllowedUrl(l))
        .slice(0, MAX_LINKS);
      finish(hostId, { ok: true, links });
      return;
    }

    // Everything below is the pdf transfer state machine. A pdf-shaped frame for
    // a links request has no reassembly state to land in, so refuse it here
    // rather than reading req.chunks on a request that never had any. An
    // unrecognised type is still ignored, exactly as before.
    const PDF_TYPES = ['fetch_pdf_result', 'fetch_pdf_chunk', 'fetch_pdf_abort'];
    if (!PDF_TYPES.includes(msg.type)) return;
    if (req.kind !== 'pdf') {
      fail(hostId, `unexpected ${msg.type} for a ${req.kind} request`);
      return;
    }

    if (msg.type === 'fetch_pdf_result') {
      if (!msg.ok) {
        fail(hostId, typeof msg.error === 'string' ? msg.error : 'extension reported failure');
        return;
      }
      if (req.chunks !== null) {
        fail(hostId, 'duplicate fetch_pdf_result header');
        return;
      }
      const chunks = Number(msg.chunks);
      if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) {
        fail(hostId, `invalid chunk count ${msg.chunks}`);
        return;
      }
      const bytes = Number(msg.bytes);
      if (!Number.isInteger(bytes) || bytes < 0) {
        fail(hostId, `invalid byte count ${msg.bytes}`);
        return;
      }
      req.chunks = chunks;
      req.bytes = bytes;
      req.parts = new Array(chunks).fill(null);
      maybeComplete(hostId, req);
      return;
    }

    if (msg.type === 'fetch_pdf_chunk') {
      if (req.chunks === null) {
        fail(hostId, 'chunk arrived before its header');
        return;
      }
      const seq = Number(msg.seq);
      if (!Number.isInteger(seq) || seq < 0 || seq >= req.chunks) {
        fail(hostId, `chunk seq ${msg.seq} outside declared range 0..${req.chunks - 1}`);
        return;
      }
      if (req.parts[seq] !== null) {
        fail(hostId, `duplicate chunk seq ${seq}`);
        return;
      }
      if (typeof msg.base64 !== 'string') {
        fail(hostId, `chunk seq ${seq} carries no base64 string`);
        return;
      }
      req.received += msg.base64.length;
      if (req.received > MAX_BASE64_CHARS) {
        fail(hostId, 'reassembly buffer exceeded');
        return;
      }
      req.parts[seq] = msg.base64;
      req.filled += 1;
      maybeComplete(hostId, req);
      return;
    }

    if (msg.type === 'fetch_pdf_abort') {
      fail(hostId, `transfer aborted: ${typeof msg.error === 'string' ? msg.error : 'unknown'}`);
    }
  }

  function maybeComplete(hostId, req) {
    if (req.chunks === null || req.filled !== req.chunks) return;
    const base64 = req.parts.join('');
    // Guard the vault against a truncated or mismatched transfer: the declared
    // byte count and the payload must agree before anything is written.
    const decodedBytes = Buffer.byteLength(base64, 'base64');
    if (decodedBytes !== req.bytes) {
      fail(hostId, `payload length ${decodedBytes} does not match declared ${req.bytes}`);
      return;
    }
    finish(hostId, { ok: true, base64, bytes: decodedBytes });
  }

  function dispatch(messages) {
    for (const msg of messages) {
      try {
        onChromeMessage(msg);
      } catch (err) {
        log('error handling extension message:', err.message);
      }
    }
  }

  process.stdin.on('data', (chunk) => {
    let input = chunk;
    for (;;) {
      try {
        stdinState = decodeFrames(stdinState, input);
      } catch (err) {
        if (err.code === 'INVALID_JSON') {
          // Recoverable: dispatch what did decode, discard the bad frame, and
          // resume from the bytes after it.
          log('discarding unparseable frame:', err.message);
          dispatch(err.state.messages);
          stdinState = { buffer: err.state.buffer, messages: [] };
          input = Buffer.alloc(0);
          continue;
        }
        // Desynchronised stream; nothing after this point is trustworthy.
        log('fatal stdin framing error:', err.message);
        shutdown(1);
        return;
      }
      break;
    }
    dispatch(stdinState.messages);
  });

  // Chrome closes stdin when the extension disconnects or the browser exits.
  process.stdin.on('end', () => {
    log('stdin closed, exiting');
    shutdown(0);
  });
  process.stdin.on('error', (err) => {
    log('stdin error:', err.message);
    shutdown(1);
  });

  // --- socket side ---------------------------------------------------------

  const server = net.createServer((socket) => {
    const socketState = { pending: new Set(), buffer: '' };

    const reply = (obj) => {
      if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(obj)}\n`);
    };

    socket.on('data', (data) => {
      socketState.buffer += data.toString('utf8');
      if (socketState.buffer.length > MAX_SOCKET_LINE_BYTES && !socketState.buffer.includes('\n')) {
        reply({ id: null, ok: false, error: 'request line too long' });
        socket.destroy();
        return;
      }
      let nl;
      while ((nl = socketState.buffer.indexOf('\n')) !== -1) {
        const line = socketState.buffer.slice(0, nl);
        socketState.buffer = socketState.buffer.slice(nl + 1);
        if (!line.trim()) continue;

        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          reply({ id: null, ok: false, error: `invalid json: ${err.message}` });
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reply({ id: null, ok: false, error: 'invalid json: expected an object' });
          continue;
        }
        const clientId = parsed.id ?? null;
        // Absent kind means the original pdf request, which is the only shape
        // that existed before fetch_links and still the overwhelming majority.
        const kind = parsed.kind === undefined ? 'pdf' : parsed.kind;
        if (!REQUEST_KINDS.has(kind)) {
          reply({ id: clientId, ok: false, error: `unknown request kind ${JSON.stringify(parsed.kind)}` });
          continue;
        }
        // reload restarts the extension so a code change takes effect. It names no
        // resource, so it skips the url checks below -- and it can reach nothing: the
        // extension's handler ignores any payload and only calls chrome.runtime.reload().
        // The retrieval trace, read back from the worker. Same plumbing as reload: register a
        // pending id, ack, and let the extension's reply resolve it.
        if (kind === 'devlog') {
          if (socketState.pending.size >= MAX_PENDING_PER_CLIENT || pending.size >= MAX_PENDING_TOTAL) {
            reply({ id: clientId, ok: false, error: 'too many requests in flight' });
            continue;
          }
          const hostId = crypto.randomUUID();
          const timer = setTimeout(() => fail(hostId, 'timed out'), requestTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
          pending.set(hostId, {
            clientId, socket, socketState, kind, chunks: null, parts: null, timer,
          });
          socketState.pending.add(hostId);
          reply({ id: clientId, ack: true });
          sendToChrome({ type: 'devlog', id: hostId });
          continue;
        }
        if (kind === 'reload') {
          // Shed load here too. Skipping it let a local process queue unlimited reloads
          // and keep the extension permanently restarting, which is the one denial of
          // service this bridge can inflict on the user's browser.
          if (socketState.pending.size >= MAX_PENDING_PER_CLIENT || pending.size >= MAX_PENDING_TOTAL) {
            reply({ id: clientId, ok: false, error: 'too many requests in flight' });
            continue;
          }
          const hostId = crypto.randomUUID();
          const timer = setTimeout(() => fail(hostId, 'timed out'), requestTimeoutMs);
          // Do not hold the process open for a reload that never answers.
          if (typeof timer.unref === 'function') timer.unref();
          pending.set(hostId, {
            clientId, socket, socketState, kind, chunks: null, parts: null, timer,
          });
          socketState.pending.add(hostId);
          reply({ id: clientId, ack: true });
          sendToChrome({ type: 'reload_extension', id: hostId });
          continue;
        }
        // search carries a QUERY, not a url: the extension picks the endpoints itself from
        // its own allowlist, so there is nothing here for a caller to point anywhere. It
        // still passes through the load shedding below, because a flood of searches costs
        // the same pending state as a flood of fetches.
        // download is retrieve plus "hand it to Chrome's download manager", so it takes the
        // same arguments and the same validation.
        if (kind === 'retrieve' || kind === 'download') {
          if (typeof parsed.doi !== 'string' && typeof parsed.pdfUrl !== 'string') {
            reply({ id: clientId, ok: false, error: `${kind} needs a doi or a pdfUrl` });
            continue;
          }
          if (socketState.pending.size >= MAX_PENDING_PER_CLIENT || pending.size >= MAX_PENDING_TOTAL) {
            reply({ id: clientId, ok: false, error: 'too many requests in flight' });
            continue;
          }
          const hostId = crypto.randomUUID();
          const timer = setTimeout(() => fail(hostId, 'timed out'), requestTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
          pending.set(hostId, {
            clientId, socket, socketState, kind, chunks: null, parts: null, timer,
          });
          socketState.pending.add(hostId);
          reply({ id: parsed.id, ack: true });
          sendToChrome({
            type: kind,
            id: hostId,
            doi: typeof parsed.doi === 'string' ? parsed.doi.slice(0, 200) : undefined,
            pdfUrl: typeof parsed.pdfUrl === 'string' ? parsed.pdfUrl.slice(0, 2000) : undefined,
            email: typeof parsed.email === 'string' ? parsed.email.slice(0, 200) : undefined,
            coreApiKey: typeof parsed.coreApiKey === 'string' ? parsed.coreApiKey.slice(0, 200) : undefined,
          });
          continue;
        }
        if (kind === 'search') {
          if (typeof parsed.query !== 'string' || !parsed.query.trim()) {
            reply({ id: clientId, ok: false, error: 'search needs a query' });
            continue;
          }
          if (socketState.pending.size >= MAX_PENDING_PER_CLIENT || pending.size >= MAX_PENDING_TOTAL) {
            reply({ id: clientId, ok: false, error: 'too many requests in flight' });
            continue;
          }
          const hostId = crypto.randomUUID();
          const timer = setTimeout(() => fail(hostId, 'timed out'), requestTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
          pending.set(hostId, {
            clientId, socket, socketState, kind, chunks: null, parts: null, timer,
          });
          socketState.pending.add(hostId);
          reply({ id: parsed.id, ack: true });
          // Filters are re-shaped rather than forwarded whole: this is the trust boundary,
          // and an unbounded object from the socket would reach the extension untouched.
          // Only the fields the adapters understand survive, with types enforced.
          const f = (parsed.filters && typeof parsed.filters === 'object') ? parsed.filters : {};
          const filters = {};
          if (typeof f.author === 'string' && f.author.trim()) filters.author = f.author.slice(0, 120);
          if (Number.isFinite(f.yearFrom)) filters.yearFrom = Math.trunc(f.yearFrom);
          if (Number.isFinite(f.yearTo)) filters.yearTo = Math.trunc(f.yearTo);
          if (f.titleOnly === true) filters.titleOnly = true;
          if (typeof f.doi === 'string' && f.doi.trim()) filters.doi = f.doi.slice(0, 200);
          sendToChrome({
            type: 'search',
            id: hostId,
            query: parsed.query,
            sources: Array.isArray(parsed.sources) ? parsed.sources : undefined,
            limit: Number.isFinite(parsed.limit) ? parsed.limit : undefined,
            page: Number.isFinite(parsed.page) ? parsed.page : undefined,
            filters,
          });
          continue;
        }
        if (typeof parsed.url !== 'string' || !parsed.url) {
          reply({ id: clientId, ok: false, error: 'missing url' });
          continue;
        }
        // The socket is the trust boundary. Validate before Chrome ever sees
        // the URL, so a local process cannot turn this into a general
        // "fetch anything with my cookies" primitive.
        if (!isAllowedUrl(parsed.url)) {
          reply({ id: clientId, ok: false, error: 'url host not allowed' });
          continue;
        }
        // Shed load rather than let a pipelining client accumulate timers and
        // reassembly buffers faster than Chrome can retire them.
        if (socketState.pending.size >= MAX_PENDING_PER_CLIENT || pending.size >= MAX_PENDING_TOTAL) {
          reply({ id: clientId, ok: false, error: 'too many requests in flight' });
          continue;
        }

        const hostId = crypto.randomUUID();
        const req = {
          kind,
          // Kept so a links reply can be re-checked against the origin it was
          // supposed to come from. Already isAllowedUrl-validated above.
          url: parsed.url,
          clientId,
          socket,
          socketState,
          // Reassembly state. Unused by a links request, which is answered by a
          // single frame, but kept on the shared shape so finish/fail/cleanup
          // and the timeout stay one code path for both kinds.
          chunks: null,
          bytes: NaN,
          parts: null,
          filled: 0,
          received: 0,
          timer: setTimeout(() => fail(hostId, `timed out after ${requestTimeoutMs} ms`), requestTimeoutMs),
        };
        req.timer.unref();
        pending.set(hostId, req);
        socketState.pending.add(hostId);

        // Acknowledge immediately, before Chrome has done anything. The client uses a
        // first-byte deadline to tell a live host from one that is listen()ing but
        // wedged, and a challenged publisher can legitimately produce no result for
        // minutes while the user solves a Turnstile widget. Without this ack the client
        // would abandon exactly the case the bridge exists to serve.
        reply({ id: parsed.id, ack: true });

        if (kind === 'links') {
          sendToChrome({ type: 'fetch_links', id: hostId, url: parsed.url });
          continue;
        }
        const referer = typeof parsed.referer === 'string' ? parsed.referer : undefined;
        sendToChrome({ type: 'fetch_pdf', id: hostId, url: parsed.url, referer });
      }
    });

    const cleanup = () => {
      // Drop every request this client was waiting on. Late frames for these
      // ids then hit the unknown-id path and are discarded.
      for (const hostId of socketState.pending) {
        const req = pending.get(hostId);
        if (req) {
          clearTimeout(req.timer);
          pending.delete(hostId);
        }
      }
      socketState.pending.clear();
    };
    socket.on('close', cleanup);
    socket.on('error', (err) => {
      log('socket client error:', err.message);
      cleanup();
    });
  });

  server.on('error', (err) => {
    log('socket server error:', err.message);
    shutdown(1);
  });

  let shuttingDown = false;
  function shutdown(code, reason = 'host shutting down') {
    if (shuttingDown) return;
    shuttingDown = true;
    // Tell every waiting client explicitly. A bare EOF would leave the client to
    // guess whether its request failed or the reply is still coming.
    for (const hostId of [...pending.keys()]) fail(hostId, reason);
    try {
      server.close();
    } catch {
      // Already closed.
    }
    cleanupSocketPath();
    process.exit(code);
  }

  function cleanupSocketPath() {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Never created, or already gone.
    }
    try {
      // Only succeeds once the last host sharing the directory has exited,
      // which is exactly when it should go.
      fs.rmdirSync(socketDir);
    } catch {
      // Another host still owns a socket in here, or it is already gone.
    }
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  // Last-resort cleanup for paths that bypass shutdown (an uncaught throw).
  process.on('exit', cleanupSocketPath);

  // stdout IS the native messaging channel. A write failure means Chrome is
  // gone, and it surfaces asynchronously here rather than as a throw from
  // write(), so without this handler an EPIPE is an uncaught exception that
  // kills the process without telling anyone waiting on the socket.
  process.stdout.on('error', (err) => {
    log('stdout error, extension is gone:', err.message);
    shutdown(1, `cannot reach the extension: ${err.message}`);
  });

  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    log(`listening on ${socketPath}`);
  });

  process.stdin.resume();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
