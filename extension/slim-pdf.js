// Recompress a downloaded PDF with qpdf compiled to WebAssembly, before it reaches
// the user's Downloads folder.
//
// THE FLAGS BELOW ARE A CONTRACT, NOT A STARTING POINT. Corpus Studio chose qpdf over
// ghostscript on measured evidence: across 20 test papers ghostscript MOVED ITEM
// GEOMETRY in 19 of them, while qpdf moved it in 0. Geometry is what every
// evidence-span highlight is anchored to, so an optimiser that shifts text silently
// breaks the feature the corpus exists for. Every edit qpdf declines to make -- image
// downsampling, dropping thumbnails, stripping structure trees -- is in that same
// class. Do NOT add --remove-metadata, downsampling, or anything else here without
// re-running that measurement.
//
// The slimmer is also OPTIONAL BY CONSTRUCTION: a download must never fail because an
// optimisation did. Every failure path returns the original bytes untouched, which is
// the same guard src/main/pipeline/stages/optimize.ts applies on the app side.

const QPDF_ARGS = [
  '--object-streams=generate',
  '--recompress-flate',
  '--compression-level=9',
  '--optimize-images',
  '--remove-unreferenced-resources=yes'
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function looksLikePdf(bytes) {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Recompress `bytes`, or return `bytes` unchanged.
 *
 * NEVER throws and never returns anything but a Uint8Array: callers hand the result
 * straight to the download, so a rejection here would cost the user a paper they had
 * already waited for.
 */
export async function slimPdf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return bytes;

  let out;
  try {
    out = await runQpdf(bytes, QPDF_ARGS);
  } catch (err) {
    console.warn('[slim-pdf] qpdf failed, keeping the original:', err && err.message);
    return bytes;
  }

  if (!(out instanceof Uint8Array) || out.length === 0) return bytes;

  // Not smaller means there was nothing to win. Handing back a LARGER file for no gain
  // is a regression, so the original stands.
  if (out.length >= bytes.length) return bytes;

  // Output that is not a PDF means the run went wrong in a way its exit code did not
  // report. Saving that would corrupt the user's file.
  if (!looksLikePdf(out)) {
    console.warn('[slim-pdf] qpdf output is not a PDF, keeping the original');
    return bytes;
  }

  return out;
}
