// The toolbar panel.
//
// It asks the WORKER to download and does nothing itself. That split is not stylistic: a
// popup is destroyed the instant it loses focus, and a retrieval can run for a minute or an
// hour when a human is solving a challenge. Work started here would die when the user looked
// away. The worker outlives the panel, so the worker owns the download.
//
// The consequence is visible in the UI: closing the panel mid-download is safe and says so.
// What is lost is only the report, not the file.

const $ = (id) => document.getElementById(id);
const form = $('form');
const field = $('identifier');
const button = $('go');
const working = $('working');
const done = $('done');
const failed = $('failed');
const attempts = $('attempts');
const attemptsLabel = $('attempts-label');
const email = $('email');
const saved = $('saved');

/** Only one state is ever visible; a status line that accumulates is a status line that lies. */
function show(which, text) {
  for (const el of [working, done, failed]) el.hidden = true;
  attempts.hidden = true;
  attemptsLabel.hidden = true;
  attempts.replaceChildren();
  if (!which) return;
  if (text !== undefined) which.textContent = text;
  which.hidden = false;
}

/**
 * Say what went wrong in words, not in protocol.
 *
 * The raw strings are written for whoever debugs the ladder -- "http 403", "AbortError:
 * signal timed out", "not a pdf (starts with \"<!DOC\")". To a researcher who pasted a DOI
 * they are noise that reads as breakage, and the difference that actually matters to them is
 * only ever one of three: nobody has a free copy, the site refused us, or it took too long.
 */
function friendlyError(raw) {
  const t = String(raw || '').toLowerCase();
  if (/403|401|forbidden|unauthor|paywall|access denied/.test(t)) return 'needs a subscription';
  if (/timed out|timeout|aborterror|deadline|budget/.test(t)) return 'took too long to answer';
  if (/not a pdf|<!doc|html|no file link|no pdf/.test(t)) return 'no PDF there';
  if (/no oa|no open-access|not on |no such doi|404|no result/.test(t)) return 'no free copy';
  if (/network|failed to fetch|dns|econn|unreachable|offline/.test(t)) return 'could not be reached';
  if (/not allowlisted/.test(t)) return 'not a site this add-on can use';
  return 'no copy available';
}

/** A source name a person would recognise, rather than the internal key. */
const SOURCE_NAMES = {
  unpaywall: 'Unpaywall',
  openalex: 'OpenAlex',
  pmc: 'PubMed Central',
  core: 'CORE',
  arxiv: 'arXiv',
  direct: 'The link you pasted',
  crossref: 'Crossref',
};

function friendlySource(name) {
  if (SOURCE_NAMES[name]) return SOURCE_NAMES[name];
  // Publisher keys are already their own names; just give them a capital.
  return String(name || 'A source').replace(/^./, (c) => c.toUpperCase());
}

/** Where it looked, in plain words. Kept short -- this is a footnote, not a report. */
function showAttempts(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  attempts.replaceChildren(...list.map((a) => {
    const li = document.createElement('li');
    // textContent, never innerHTML: these strings originate in publisher responses.
    li.textContent = `${friendlySource(a.source)} — ${friendlyError(a.error)}`;
    return li;
  }));
  attempts.hidden = false;
  attemptsLabel.hidden = false;
}

function humanSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  return bytes >= 1024 * 1024
    ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)`
    : ` (${Math.round(bytes / 1024)} KB)`;
}

// The contact address the open-access APIs require. Persisted in sync storage so it survives
// a reload and follows the profile -- without it Unpaywall and PMC are skipped entirely and
// the ladder silently loses its cheapest rungs.
//
// Hidden once it is set. It is answered once and never again, so leaving it on screen would
// spend the panel's only vertical space on a solved problem. It reappears only if the value
// is cleared, which is the one moment it becomes actionable again.
const settings = $('settings');

function syncSettingsVisibility() {
  const has = email.value.trim() !== '';
  settings.hidden = has;
  if (!has) settings.open = true;
}

chrome.storage.sync.get({ email: '' }).then(({ email: stored }) => {
  email.value = stored;
  syncSettingsVisibility();
});

let saveTimer = null;
email.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.sync.set({ email: email.value.trim() });
    saved.hidden = false;
    setTimeout(() => { saved.hidden = true; }, 1500);
  }, 400);
});

// Collapsed on BLUR, not on input: hiding the field the moment it holds a plausible address
// would snatch it away mid-word, and half a typed email is worse than none.
email.addEventListener('blur', syncSettingsVisibility);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const identifier = field.value.trim();
  if (!identifier) return;

  button.disabled = true;
  field.disabled = true;
  show(working);

  let reply;
  try {
    reply = await chrome.runtime.sendMessage({
      type: 'popup_download',
      identifier,
      email: email.value.trim() || undefined,
    });
  } catch (err) {
    // The worker was evicted or is starting up. Chrome revives it on the next message, so
    // this is worth retrying rather than reporting as a dead extension.
    reply = { ok: false, error: `The extension did not answer (${err.message}). Try again.` };
  }

  button.disabled = false;
  field.disabled = false;

  if (reply?.ok) {
    show(done, `Saved to Downloads — ${reply.filename}${humanSize(reply.bytes)}`);
    field.value = '';
    field.focus();
    return;
  }

  // One short sentence, and it must be ACTIONABLE. "no source produced a valid pdf" tells a
  // researcher nothing they can act on; "couldn't find a free copy" tells them to try their
  // library. The technical detail is not hidden, it moves to the list underneath.
  const raw = String(reply?.error || '');
  let headline;
  if (/enter a doi|identifier/i.test(raw)) {
    headline = 'That does not look like a paper ID. Try a DOI, like 10.1038/nature12373.';
  } else if (/did not answer|extension/i.test(raw)) {
    headline = 'The add-on was waking up. Please try again.';
  } else if (Array.isArray(reply?.attempts) && reply.attempts.length > 0) {
    headline = 'Could not find a copy to download.';
  } else {
    headline = 'Could not download this paper.';
  }
  show(failed, headline);
  showAttempts(reply?.attempts);
});
