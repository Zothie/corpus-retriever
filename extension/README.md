# Repository paper bridge (Chrome MV3 extension)

Downloads paper PDFs from allowlisted publishers using the browser's own logged-in,
already-challenge-cleared session, and hands the bytes to the MCP server through a
native-messaging host.

## Why this exists

Do not "simplify" this into a plain HTTP client. Every simpler option was measured and
fails:

- `papers.ssrn.com` is behind a Cloudflare **managed JS challenge** (`cf-mitigated: challenge`,
  `_cf_chl_opt`, no Turnstile widget).
- The user's Chrome holds a valid `cf_clearance` cookie for `.ssrn.com`.
- Exporting that cookie into any other HTTP client (fetch, axios, curl) returns **403**. The
  cookie is bound to the TLS/JA3 fingerprint, User-Agent and IP that earned it.
- Launching headless Chrome on a copy of the real profile, carrying the same valid cookie,
  also returns **403** -- the headless UA and runtime signals get re-challenged.

Only code running inside the user's real, already-cleared Chrome presents the right
fingerprint, UA, IP and cookies simultaneously. That is this extension.

The download itself is a two-hop flow that must complete in-page:

```
GET papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID<id>.pdf?abstractid=<id>&mirid=1
  -> 302 https://download.ssrn.com/.../ssrn_id<id>_code<code>.pdf?X-Amz-Signature=...
  -> 200 application/pdf
```

The S3 URL is presigned with a one-shot STS token and a 300 second TTL, so it cannot be
constructed, cached, or passed to another process. `redirect: 'follow'` walks it immediately.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this directory.
4. Confirm the ID Chrome shows is exactly:

   ```
   bndnaabeiejhlmpoijlemjgaonlagdgf
   ```

   The `key` field in `manifest.json` pins this. Unpacked extensions normally get a
   path-derived ID, but the native-messaging host manifest's `allowed_origins` needs a fixed
   one. If the ID differs, the `key` was altered and the host will refuse the connection.
5. Restart Chrome so the service worker reconnects cleanly.

**The extension does nothing on its own.** The native-messaging host
(`com.repository.paper_bridge`) must also be installed; until then the service worker just
retries the connection with capped exponential backoff (1s doubling to a 5 minute ceiling)
and logs a disconnect warning. Retries below 30s use `setTimeout`; longer ones switch to
`chrome.alarms`, because an idle MV3 service worker is torn down after roughly 30s and its
pending timers die with it. Without the alarm the extension would go permanently dead after
the fourth failed attempt.

## Permissions

`host_permissions` lists every publisher the bridge fetches from, granted at install time.

They are NOT `optional_host_permissions`: `chrome.permissions.request()` requires a user
gesture, and every fetch here is triggered by a native message that has none, so an optional
grant could never actually be obtained and `executeScript` would fail on those hosts.

The manifest only decides what Chrome will permit at all. The real security boundary is
`ALLOWED_HOSTS` / `PATH_CONSTRAINED_HOSTS` in `background.js`, kept byte-identical to
`src/bridge/allowed-hosts.js` and enforced by `tests/allowed-hosts.test.mjs`.

DigitalCommons instances are enumerated host by host because bepress has no single domain.
An open `.edu` rule was rejected deliberately: it would grant credentialed fetches against
every university host the user has a session with, including library proxies and IP-gated
resources whose authenticated responses legitimately are PDFs.

## Security boundary

The unix socket behind the native host is the trust boundary: any local process reaching it
could otherwise make authenticated requests as the user to any site they are logged into.
`isAllowedUrl` in `background.js` is therefore a second, independent copy of the check in
`src/bridge/allowed-hosts.js` and must stay in sync with it. It requires https, rejects
embedded credentials, pins the default port, and validates the hostname against a strict
label pattern so that `.ssrn.com`, `ssrn.com.`, IPv6 literals and non-string input all fail
closed.

There are two grants. `ALLOWED_HOSTS` is suffix-matched over the whole subdomain tree with no
path restriction, and holds only publisher-owned domains (`ssrn.com`, `cell.com`,
`data.mendeley.com`, `sciencedirect.com`). `PATH_CONSTRAINED_HOSTS` is exact-host plus an
explicit path list, and holds DigitalCommons/bepress instances, which run on university
domains we have no authority over -- those get `/cgi/viewcontent.cgi` and `/context/` and
nothing else. DigitalCommons is an explicit host list rather than an open `.edu` pattern; the
reasoning is in the header comment of `src/bridge/allowed-hosts.js`.

Sync is test-enforced, not comment-enforced. Both copies bracket the shared code in
`// ---8<--- allowlist parity region` markers; `tests/allowed-hosts.test.mjs` extracts the
extension's block, evaluates it standalone, runs one shared adversarial vector table through
both implementations, asserts the two blocks are textually identical apart from `export`, and
checks that nothing outside the region redeclares or mutates the gate. Edit both or neither.

Responses are additionally rejected unless they begin with the `%PDF-` magic, which keeps
challenge HTML and paywall interstitials out of the vault.

## Transfer framing

Chrome caps a single native message at 64 MiB extension-to-host (and 1 MiB host-to-extension).
Base64 inflates a PDF by 4/3, so the 80 MB `MAX_PDF_BYTES` ceiling would be ~107 MB of payload
and exceed the cap on its own. The result is therefore sent as:

```
{ type: 'fetch_pdf_result', id, ok: true, bytes, chunks }
{ type: 'fetch_pdf_chunk',  id, seq: 0, base64: '...' }   // CHUNK_CHARS = 256 KiB
{ type: 'fetch_pdf_chunk',  id, seq: 1, base64: '...' }
...
```

Failures are a single `{ type: 'fetch_pdf_result', id, ok: false, error }` with no chunks.
`chunks` is always at least 1 on success, since a body shorter than the `%PDF-` magic is
rejected outright.

The host must collect `chunks` frames, order them by `seq`, and concatenate before decoding.
Two termination cases it must handle besides the happy path:

- `{ type: 'fetch_pdf_abort', id, error }` -- the transfer failed partway through the chunk
  loop. Discard whatever was buffered for that id.
- `onDisconnect` with a transfer still open -- same, discard. The host should also keep its
  own per-request timeout, since a torn-down service worker can drop a transfer without
  sending anything.

### fetch_links

A second capability, added for Mendeley Data. `data.mendeley.com` renders its file list
client-side after hydration -- the served HTML has zero `.pdf` urls, no `/public-files/` paths,
no `__NEXT_DATA__` and the string "download" appears 0 times -- and `api.data.mendeley.com`
answers 401/404 unauthenticated. So the file URLs exist only in the rendered DOM.

```
host -> extension: { type: 'fetch_links', id, url }
extension -> host: { type: 'fetch_links_result', id, ok: true, links: [...] }
                   { type: 'fetch_links_result', id, ok: false, error }
```

No chunking: the reply is capped at 50 hrefs of at most 2048 characters, ~100 kB worst case,
two orders of magnitude below the 1 MiB host-facing cap.

It is deliberately not a DOM-scraping primitive:

- the anchor query is **hardcoded** to `a[href]` in the extension. There is no caller-supplied
  selector, and only hrefs are returned -- never text, attributes or innerHTML.
- only anchors whose **path** ends in `.pdf` are collected (query string ignored, so
  `archive.zip?name=paper.pdf` is not a PDF).
- `url` must pass `isAllowedUrl`, exactly as for `fetch_pdf`.
- every returned link must be same-origin with `url` **and** pass `isAllowedUrl` itself.
  Enforced independently in all three layers -- extension, native host, MCP client -- because
  each is the far side of a channel the next one does not control.
- the extension polls for links (the page hydrates asynchronously, so a single read on load
  finds nothing), bounded by the same `CHALLENGE_TIMEOUT_MS` budget as a challenge clear.

The `.pdf` filter lives in the page rather than on the MCP side because it is also the poll's
termination condition. Mendeley's *pre*-hydration HTML already carries a dozen same-origin
navigation anchors (`/`, `/about`, `/faq`, ...), all allowlisted; a "stop when the list is
non-empty" loop would return those on the first read, never wait for the file table, and spend
cap slots the real file links then fall off the end of.

The caller picks a link and fetches it with the ordinary `fetch_pdf` path, so the `%PDF-`,
size and chunking guarantees still apply. There is no second byte path.

## Known limitation

`Referer` is a forbidden request header and Chrome silently drops it when set via `headers`.
The code uses the `referrer` fetch option instead, but per the Fetch standard a referrer whose
origin differs from the caller's is downgraded to `client`, and this worker's origin is
`chrome-extension://`. A publisher-origin referrer therefore will not reach the wire. SSRN's
`Delivery.cfm` does not require one -- only the cookies -- so this is recorded rather than
worked around.
