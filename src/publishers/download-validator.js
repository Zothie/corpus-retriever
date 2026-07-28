import axios from 'axios';

/**
 * Validates if a paper is downloadable by checking various sources
 * Returns a detailed availability status
 */
export async function validateDownloadAvailability({ doi, arxivId, pdfUrl }) {
  const result = {
    available: false,
    sources: [],
    primary_source: null,
    checked_at: new Date().toISOString(),
  };

  try {
    // ArXiv papers are always available
    if (arxivId) {
      const cleanArxivId = arxivId.replace('arXiv:', '').trim();
      result.available = true;
      result.primary_source = 'arxiv';
      result.sources.push({
        name: 'arxiv',
        url: `https://arxiv.org/pdf/${cleanArxivId}.pdf`,
        available: true,
        checked: true,
      });
      return result;
    }

    // PMC identifiers/URLs cannot be validated with a plain HEAD/GET: the public
    // PMC pdf endpoint returns HTTP 200 for a reCAPTCHA wall, so it always looks
    // "available" even when the PDF is unreachable. Verify open-access status via
    // the NCBI OA service instead, which is the same source the downloader uses.
    const pmcId = extractPmcId(pdfUrl) || extractPmcId(doi);
    if (pmcId) {
      const pmcStatus = await checkPmcOpenAccess(pmcId);
      result.sources.push(pmcStatus);
      if (pmcStatus.available) {
        result.available = true;
        result.primary_source = 'pmc_oa';
        return result;
      }
      // Not open access via PMC; fall through to unpaywall/anna's on the DOI.
    }

    // Check direct PDF URL
    if (pdfUrl && !pmcId) {
      const isAvailable = await checkUrlAccessibility(pdfUrl);
      result.sources.push({
        name: 'direct_pdf',
        url: pdfUrl,
        available: isAvailable,
        checked: true,
      });
      if (isAvailable) {
        result.available = true;
        result.primary_source = 'direct_pdf';
        return result;
      }
    }

    // Check DOI-based sources
    if (doi) {
      const cleanDoi = doi.replace(/v\d+$/, '');

      // Check Unpaywall (fast API call)
      const unpaywallStatus = await checkUnpaywall(cleanDoi);
      result.sources.push(unpaywallStatus);
      if (unpaywallStatus.available) {
        result.available = true;
        result.primary_source = 'unpaywall';
        return result;
      }

      // Check Anna's Archive using search_counts API
      const annasArchiveStatus = await checkAnnasArchive(cleanDoi);
      result.sources.push(annasArchiveStatus);
      if (annasArchiveStatus.available) {
        result.available = true;
        result.primary_source = 'annas_archive';
      }
    }

    return result;
  } catch (error) {
    console.error('Download validation error:', error);
    return {
      available: false,
      sources: [],
      primary_source: null,
      error: error.message,
      checked_at: new Date().toISOString(),
    };
  }
}

/**
 * Extract a PMC id (e.g. "PMC13370116") from an identifier or URL.
 */
function extractPmcId(str) {
  if (!str) return null;
  const match = String(str).match(/PMC\d+/i);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Check whether a PMC article is genuinely open-access (and thus downloadable)
 * via the NCBI OA service. Returns a source-status object. Unlike a HEAD on the
 * reCAPTCHA-walled pdf endpoint, this reflects real downloadability.
 */
async function checkPmcOpenAccess(pmcId) {
  const status = { name: 'pmc_oa', available: false, checked: true };
  try {
    const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${pmcId}`;
    const { data } = await axios.get(url, { timeout: 5000, responseType: 'text' });
    const xml = String(data);
    if (/error code="idIsNotOpenAccess"/.test(xml)) {
      status.note = 'Not open access';
      return status;
    }
    const pdfMatch = xml.match(/format="pdf"[^>]*href="([^"]+)"/i);
    if (pdfMatch) {
      status.available = true;
      status.url = pdfMatch[1].replace(/^ftp:\/\//i, 'https://');
    } else {
      // Open access but only a package (.tar.gz), no standalone PDF link.
      status.note = 'Open access package only (no standalone PDF)';
    }
  } catch (error) {
    status.checked = false;
    status.error = error.message;
  }
  return status;
}

/**
 * Check if a URL is accessible with HEAD request
 */
async function checkUrlAccessibility(url) {
  try {
    const response = await axios.head(url, {
      timeout: 3000,
      maxRedirects: 3,
      validateStatus: (status) => status < 500, // Accept anything except server errors
    });
    return response.status >= 200 && response.status < 400;
  } catch (error) {
    // If HEAD fails, try a quick GET with minimal data
    try {
      const response = await axios.get(url, {
        timeout: 3000,
        maxRedirects: 3,
        responseType: 'stream',
        validateStatus: (status) => status < 500,
      });
      // Abort the request after checking status
      response.data.destroy();
      return response.status >= 200 && response.status < 400;
    } catch {
      return false;
    }
  }
}

/**
 * Check Unpaywall API for open access availability
 */
async function checkUnpaywall(doi) {
  const result = {
    name: 'unpaywall',
    available: false,
    checked: true,
  };

  try {
    // Unpaywall 422-rejects placeholder emails; read the real contact email from
    // UNPAYWALL_EMAIL (server .env) and fall back to a real address, never user@example.com.
    const email = process.env.UNPAYWALL_EMAIL || 'varingaitishe@gmail.com';
    const url = `https://api.unpaywall.org/v2/${doi}?email=${email}`;
    const { data } = await axios.get(url, { timeout: 3000 });

    if (data.is_oa && data.best_oa_location) {
      result.available = true;
      result.url = data.best_oa_location.url_for_pdf || data.best_oa_location.url;
      result.oa_status = data.oa_status;
      result.version = data.best_oa_location.version;
    } else {
      result.url = `https://api.unpaywall.org/v2/${doi}?email=${email}`;
      result.note = 'Not open access';
    }
  } catch (error) {
    result.checked = false;
    result.error = error.message;
  }

  return result;
}

/**
 * Check Anna's Archive using search_counts API
 */
async function checkAnnasArchive(doi) {
  const result = {
    name: 'annas_archive',
    available: false,
    checked: true,
  };

  try {
    const mirrors = [
      'https://annas-archive.org',
      'https://annas-archive.li',
      'https://annas-archive.se'
    ];

    // Try each mirror until we get a successful response
    for (const mirror of mirrors) {
      try {
        const searchCountsUrl = `${mirror}/dyn/search_counts?q=${encodeURIComponent(`"doi:${doi}"`)}`;
        const { data } = await axios.get(searchCountsUrl, { timeout: 5000 });

        // Check if any records were found in any collection
        const hasRecords = (data.aarecords && data.aarecords.value > 0) ||
                          (data.aarecords_journals && data.aarecords_journals.value > 0) ||
                          (data.aarecords_digital_lending && data.aarecords_digital_lending.value > 0);

        result.url = `${mirror}/scidb/${encodeURIComponent(doi)}`;
        result.available = hasRecords;
        result.mirror = mirror;
        result.counts = {
          aarecords: data.aarecords?.value || 0,
          journals: data.aarecords_journals?.value || 0,
          digital_lending: data.aarecords_digital_lending?.value || 0,
        };

        // Success - return result
        return result;
      } catch (error) {
        // Try next mirror
        continue;
      }
    }

    // All mirrors failed
    result.checked = false;
    result.error = 'All Anna\'s Archive mirrors failed';
    result.url = `https://annas-archive.org/scidb/${encodeURIComponent(doi)}`;
  } catch (error) {
    result.checked = false;
    result.error = error.message;
    result.url = `https://annas-archive.org/scidb/${encodeURIComponent(doi)}`;
  }

  return result;
}

/**
 * Batch validate multiple papers
 */
export async function batchValidateDownloads(papers) {
  const validations = await Promise.all(
    papers.map(async (paper) => {
      const validation = await validateDownloadAvailability({
        doi: paper.doi,
        arxivId: paper.arxiv_id,
        pdfUrl: paper.pdf_url,
      });
      return {
        ...paper,
        download_status: validation,
      };
    })
  );

  return validations;
}
