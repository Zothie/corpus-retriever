// Run one retrieval through the user's own Chrome and print its trace.
//
// The trace comes back WITH the result, in the same session, because these hosts alternate
// between a challenge and the article for the same url -- a second run to "check what
// happened" is a different experiment.
import net from 'node:net';
import { readdirSync } from 'node:fs';

// USER is not always set (cron, sandboxes, some shells), and `/tmp/ssrn-bridge-undefined`
// fails with an ENOENT that looks like "the extension is not running".
import os from 'node:os';
const dir = `/tmp/ssrn-bridge-${process.env.USER || process.env.LOGNAME || os.userInfo().username}`;
// Newest socket wins: a reload leaves the old one behind for a moment.
// A reload kills the host, which removes its socket and sometimes the directory with it, so
// "not there" is a NORMAL mid-reload state rather than an error. The readiness loop keeps
// polling until Chrome respawns the host and a new socket appears.
function pick() {
  let socks = [];
  try {
    socks = readdirSync(dir).filter((f) => f.endsWith('.sock'));
  } catch {
    return null;
  }
  return socks.length ? `${dir}/${socks.sort().pop()}` : null;
}

// Retry a request while the bridge is between sockets.
//
// Chrome respawns the native host LAZILY -- on the next connection from the extension -- so
// there is a window after any reload where the old socket is gone and the new one does not
// exist yet. A readiness check cannot close that window: it can pass and the socket still be
// replaced before the next request goes out. Retrying at the point of use is what actually
// works, and it costs nothing when the bridge is healthy.
async function sendRetrying(msg, capMs, waitMs = 20000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await send(msg, capMs);
    const transient = r && !r.ok
      && (r.error === 'no socket yet' || r.error === 'closed' || /ECONNREFUSED|ENOENT/.test(r.error || ''));
    if (!transient || Date.now() > until) return r;
    await new Promise((res) => { const t = setTimeout(res, 100); t.unref?.(); });
  }
}

function send(msg, capMs = 330000) {
  return new Promise((res) => {
    const sock = pick();
    if (!sock) { res({ ok: false, error: 'no socket yet' }); return; }
    let c;
    try {
      c = net.createConnection(sock);
    } catch (e) {
      res({ ok: false, error: e.message }); return;
    }
    let buf = '';
    c.on('connect', () => c.write(`${JSON.stringify(msg)}\n`));
    c.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!l.trim()) continue;
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.ack) continue;
        c.end(); res(m); return;
      }
    });
    c.on('error', (e) => res({ ok: false, error: e.message }));
    // A socket that closes without ever answering is a dead host, not a slow one. Without
    // this the promise hangs until the cap, and a readiness poll built on it never advances.
    c.on('close', () => res({ ok: false, error: 'closed' }));
    const t = setTimeout(() => { c.destroy(); res({ ok: false, error: 'cap' }); }, capMs);
    if (typeof t.unref === 'function') t.unref();
  });
}

// Reload, then wait for the extension to be BACK -- not for an arbitrary number of seconds.
//
// A reload tears down the worker and the native host with it, so the socket this script was
// using dies and a new one appears under a new pid. Sleeping "long enough" is a guess that is
// either too short (the next request lands on a dead socket) or wasted time. Polling the
// bridge for an answer is the actual readiness signal.
// Reload only when asked (`--reload`), because a reload tears down the worker AND the native
// host, and the socket this script talks to dies with it. Chrome respawns the host lazily --
// on the next connection from the extension -- so a retrieve fired straight after a reload
// lands on a socket that no longer exists.
//
// Steady state, the extension is already running the code on disk, so most runs need no
// reload at all. Pass --reload after editing extension source.
if (process.argv.includes('--reload')) {
  await send({ kind: 'reload' }, 10000).catch(() => {});
  const readyBy = Date.now() + 30000;
  for (;;) {
    // The readiness signal is a devlog that actually answers -- not a sleep, which is either
    // too short (dead socket) or wasted time.
    const probe = await send({ kind: 'devlog' }, 4000);
    if (probe && probe.ok) break;
    if (Date.now() > readyBy) {
      console.error(`bridge did not come back within 30s (last: ${probe && probe.error})`);
      process.exit(1);
    }
    await new Promise((r) => { const t = setTimeout(r, 100); t.unref?.(); });
  }
}

const doi = process.argv[2];

// Aim the run at specific sources, so testing one does not mean hunting for a DOI that
// happens to reach it:
//   node scripts/trace.mjs <doi> annas           only annas
//   node scripts/trace.mjs <doi> annas,libgen    only those
//   node scripts/trace.mjs <doi> -scihub         everything except scihub
//   node scripts/trace.mjs <doi> annas --reload  reload the extension first
const sel = process.argv.slice(3).find((a) => !a.startsWith('--'));
const only = sel && !sel.startsWith('-') ? sel.split(',') : undefined;
const skip = sel && sel.startsWith('-') ? sel.slice(1).split(',') : undefined;
if (only) console.log(`(only: ${only.join(', ')})`);
if (skip) console.log(`(skipping: ${skip.join(', ')})`);

const t0 = Date.now();
const r = await sendRetrying({
  // Unpaywall and PMC REJECT placeholder domains (example.com gets a 422), so a hardcoded
  // fake address silently removes two sources from every test run -- which read as "the
  // filter is broken" rather than "the email was refused". Set CONTACT_EMAIL to a real
  // address to exercise them; without it those two sources are skipped, as they would be
  // for a user who has not filled the setting in.
  kind: 'retrieve', doi, email: process.env.CONTACT_EMAIL, only, skip,
});
console.log(`\n### ${doi} :: ${r.ok ? `OK ${r.source}` : 'FAIL'} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const d = await sendRetrying({ kind: 'devlog' }, 20000);
if (d && d.report && d.report.events) {
  for (const e of d.report.events) {
    const t = `${(e.at / 1000).toFixed(2)}s`.padStart(8);
    if (e.kind === 'decide') {
      console.log(`${t}  ${e.label.padEnd(20)} ${String(e.verdict).toUpperCase().padEnd(9)} ${e.because} ${e.evidence ? JSON.stringify(e.evidence).slice(0, 80) : ''}`);
    } else if (e.kind === 'http') {
      const x = e.detail;
      console.log(`${t}  ${e.label.padEnd(20)} http=${x.status ?? '-'} ${String(x.bytes ?? '-').padStart(8)}B ${JSON.stringify(x.magic ?? '').slice(0, 18)} ${x.error ? `ERR ${x.error}` : ''}`);
    } else if (e.kind === 'snap') {
      console.log(`${t}  ${e.label.padEnd(20)} PAGE ${JSON.stringify(e.detail).slice(0, 130)}`);
    } else if (e.kind === 'end') {
      console.log(`${t}  ${e.label.padEnd(20)} ${e.ms}ms ${e.detail ? JSON.stringify(e.detail).slice(0, 60) : ''}`);
    } else if (e.kind === 'mark') {
      console.log(`${t}  ${e.label.padEnd(20)} ${e.detail ? JSON.stringify(e.detail).slice(0, 90) : ''}`);
    }
  }
} else {
  console.log('no trace:', JSON.stringify(d).slice(0, 150));
}
