// The User-Agent the Node-side resolvers send.
//
// Windows is deliberate, and the version is the REAL installed Chrome major: the story the
// header tells has to match the browser the same machine would present, or the two request
// styles contradict each other and the mismatch is itself a signal.
//
// This replaced an 813-line Puppeteer profile-launcher that was imported solely for this one
// constant. The extension does its own fetching inside the user's Chrome, so none of that
// machinery was reachable here -- it only had to be carried around.

import { execSync } from 'child_process';

function detectChromeMajor() {
  try {
    const out = execSync('google-chrome-stable --version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = out.match(/(\d+)\./);
    if (m) return parseInt(m[1], 10);
  } catch {
    // No Chrome on PATH, or it refused to answer. A recent major is a better guess than
    // failing: this only shapes a header, and a stale-but-plausible one still works.
  }
  return 146;
}

export const CHROME_MAJOR = detectChromeMajor();

export const REALISTIC_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
