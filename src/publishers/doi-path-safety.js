// Is a DOI safe to paste into a URL path?
//
// Springer, Wiley and ACS all address an article by embedding the DOI whole in a path
// (/content/pdf/<doi>.pdf, /doi/pdfdirect/<doi>, /doi/<doi>). A DOI is attacker-influenced
// -- whatever reaches the bridge socket supplies it -- and the resulting URL is fetched
// with the user's real cookies, so the embedding has to be checked rather than trusted.
//
// The prefix check alone is not enough. Measured: "10.1007/../../x" satisfies /^10\.1007\//
// and builds https://link.springer.com/content/pdf/10.1007/../../x.pdf, which the URL
// parser normalises to /content/x.pdf. "10.1007/a/../../../etc" reaches /content/etc.pdf,
// and the percent-encoded form "10.1007/%2e%2e/x" is left encoded here but is decoded by
// some origins. None of these leave the granted host, so this is not a cross-origin
// escape, but each defeats the path the publisher entry intended to request and turns a
// paper download into "fetch an arbitrary path on this publisher as the user".
//
// Refused rather than normalised on purpose: a DOI containing a dot segment is not a real
// DOI, so there is nothing to preserve by rewriting it, and rewriting invites a mismatch
// between what was validated and what is later built.

// Percent-encoded separators and dot segments. URL leaves these encoded, so a check on the
// parsed pathname would not see them while the far end may still decode them -- the same
// reasoning as ENCODED_PATH_SEPARATOR in src/bridge/allowed-hosts.js.
const ENCODED_SEPARATOR = /%(2f|5c|2e)/i;

/**
 * True when a DOI can be embedded in a URL path without changing which path is requested.
 *
 * Rejects whitespace and the query/fragment delimiters (which would smuggle parameters
 * onto the request), any dot segment, doubled or trailing slashes, backslashes, and any
 * percent-encoding of those. Accepts an ordinary DOI, whose single "/" separates the
 * registrant prefix from the suffix.
 */
export function isSafeDoiPathSegment(doi) {
  if (typeof doi !== 'string') return false;
  const value = doi.trim();
  if (!value) return false;
  if (/[?#\s\\]/.test(value)) return false;
  if (ENCODED_SEPARATOR.test(value)) return false;
  if (value.includes('//')) return false;
  if (value.endsWith('/')) return false;
  // Any "." that stands alone as a path segment. A DOI has plenty of dots INSIDE segments
  // ("10.1007", "acs.est.0c02765"), so this must match the segment, not the character.
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  return true;
}
