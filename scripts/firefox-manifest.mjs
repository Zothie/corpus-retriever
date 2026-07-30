// Turn the Chrome MV3 manifest into the Firefox MV3 one.
//
// This is a TRANSFORM, not a second manifest, and that is deliberate: host_permissions is
// 111 entries long and drifts every time a publisher is added. Two hand-maintained copies
// would diverge silently, and the failure mode is a source that works in one browser and
// not the other -- which looks like a broken publisher, not a stale file.
//
// Everything Firefox needs is derivable from the Chrome manifest, so nothing here is
// authored twice except the four Gecko-specific values below.

export const GECKO_ID = '{5b4e01ed-e5d0-41d0-b57d-409f183d0620}';

// The floor is set by two independent HARD requirements, not by caution. The higher wins.
//
//   127  host_permissions are first GRANTED at install time (and first even shown in the
//        install prompt). This extension fetches from ~110 hosts with no user interaction
//        at all, so on 126 every retrieval fails on a permission the user was never offered
//        a chance to give. There is no degraded mode worth shipping there.
//   140  browser_specific_settings.gecko.data_collection_permissions is understood. That key
//        is mandatory for new AMO submissions (since 2025-11-03), so it cannot be dropped to
//        lower the floor -- declaring it against an older floor is what addons-linter warns
//        about (KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION), and the fix is the floor, not the key.
//
// Android tracks separately and needs 142 for the same key; strict_min_version has no
// per-platform form, so 142 would be the number if Android support were claimed.
export const MIN_FIREFOX = '140.0';

// The qpdf glue, loaded ahead of the worker.
//
// Firefox MV3 has NO service worker (bug 1573659); the background is an event PAGE, and
// importScripts does not exist in one. slim-pdf.js guards its importScripts call on
// `typeof self.importScripts === 'function'`, so on Firefox that call is skipped and the
// glue must arrive some other way. background.scripts loads in ARRAY ORDER into one shared
// global, so listing the glue first leaves `Module` defined by the time background.js runs
// -- byte-identical to what importScripts achieves on Chrome.
const GLUE = 'vendor/qpdf.js';

/**
 * @param {object} chromeManifest  parsed extension/manifest.json
 * @returns {object} the Firefox manifest
 */
export function firefoxManifest(chromeManifest) {
  const manifest = structuredClone(chromeManifest);

  // `key` is a Chrome mechanism for pinning an extension id. Gecko does not read it, and an
  // unknown top-level key is noise in a review. The Firefox id comes from gecko.id below.
  delete manifest.key;

  // Replace the service worker outright rather than shipping both.
  //
  // Firefox 121+ ignores a `service_worker` key it cannot use, but 106-120 refuse to start
  // the background page AT ALL when one is present (bug 1860304). Emitting only `scripts`
  // costs nothing -- this manifest is never loaded by Chrome -- and keeps the floor at the
  // 127 that host_permissions already forces rather than raising it for an unrelated reason.
  const worker = chromeManifest.background?.service_worker;
  if (!worker) {
    throw new Error('chrome manifest has no background.service_worker -- update this script');
  }
  manifest.background = { scripts: [GLUE, worker] };

  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: MIN_FIREFOX,
      // Mandatory for new AMO submissions since 2025-11-03. "none" is the accurate answer:
      // the extension sends nothing anywhere. The one identifier it generates is random per
      // install, never transmitted to us, and exists only to fill the User-Agent contact
      // field that the Crossref and Unpaywall APIs ask politely for.
      data_collection_permissions: { required: ['none'] },
    },
  };

  return manifest;
}
