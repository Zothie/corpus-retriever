// Run one retrieval through the user's own Chrome and print its trace.
//
// The trace comes back WITH the result, in the same session, because these hosts alternate
// between a challenge and the article for the same url -- a second run to "check what
// happened" is a different experiment.
import net from 'node:net';
import { readdirSync } from 'node:fs';

const dir = `/tmp/ssrn-bridge-${process.env.USER}`;
const pick = () => `${dir}/${readdirSync(dir).filter((f) => f.endsWith('.sock')).pop()}`;

function send(msg, capMs = 330000) {
  return new Promise((res) => {
    const c = net.createConnection(pick());
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
    setTimeout(() => { c.end(); res({ ok: false, error: 'cap' }); }, capMs);
  });
}

await send({ kind: 'reload' }, 10000);
await new Promise((r) => setTimeout(r, 2500));

const doi = process.argv[2];
const t0 = Date.now();
const r = await send({ kind: 'retrieve', doi, email: 'corpus.retriever.test@gmail.com' });
console.log(`\n### ${doi} :: ${r.ok ? `OK ${r.source}` : 'FAIL'} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const d = await send({ kind: 'devlog' }, 20000);
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
