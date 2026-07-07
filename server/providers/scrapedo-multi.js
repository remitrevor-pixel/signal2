// Scrape.do — generic fetcher fallback with Multi-Key Rotation (handles proxies + optional JS
// rendering + geo-targeting). Same rotation pattern as serper-multi.js / firecrawl-multi.js —
// supports up to 10 keys via SCRAPE_DO_API_KEY_1 through SCRAPE_DO_API_KEY_10 (or a single
// SCRAPE_DO_API_KEY). Distinct service from ScraperAPI.com — different endpoint/auth format.
const KeyRotator = require('./keyRotator');
const quota = require('../quota');

function initScrapeDoKeys() {
  const keys = [];

  // Single-key form, plus legacy fallback to the old (mis-named) SCRAPERAPI_API_KEY slot in
  // case that's where a Scrape.do token is still sitting from earlier setup.
  const singleKey = process.env.SCRAPE_DO_API_KEY || process.env.SCRAPERAPI_API_KEY;
  if (singleKey) keys.push(singleKey);

  for (let i = 1; i <= 10; i++) {
    const key = process.env[`SCRAPE_DO_API_KEY_${i}`];
    if (key) keys.push(key);
  }

  if (keys.length === 0) {
    console.warn('⚠️ Scrape.do: No API keys configured (SCRAPE_DO_API_KEY or SCRAPE_DO_API_KEY_1, SCRAPE_DO_API_KEY_2, etc.)');
    return null;
  }

  console.log(`✓ Scrape.do: Loaded ${keys.length} API key(s)`);
  return new KeyRotator(keys);
}

const scrapeDoRotator = initScrapeDoKeys();

async function fetchRaw(url, { render = true, countryCode } = {}) {
  if (!scrapeDoRotator || scrapeDoRotator.getAllKeys().length === 0) {
    throw new Error('Scrape.do not configured (SCRAPE_DO_API_KEY or SCRAPE_DO_API_KEY_1, SCRAPE_DO_API_KEY_2, etc.)');
  }

  const q1 = quota.check('scraperapi'); // reuses the existing "scraperapi" budget bucket/name
  if (!q1.allowed) {
    throw new Error(`Scrape.do monthly budget exhausted (${q1.used}/${q1.budget}). You have ${scrapeDoRotator.getAllKeys().length} key(s) loaded.`);
  }

  let lastError;
  for (let attempt = 0; attempt < scrapeDoRotator.getAllKeys().length; attempt++) {
    const token = scrapeDoRotator.getNext();
    if (!token) throw new Error('No Scrape.do API keys available');

    try {
      const params = new URLSearchParams({ token, url, render: render ? 'true' : 'false' });
      if (countryCode) params.set('geoCode', countryCode.toLowerCase());

      const res = await fetch(`https://api.scrape.do/?${params.toString()}`);

      // Rate limited or out of credits on this key — mark it and try the next one
      if (res.status === 429 || res.status === 401) {
        scrapeDoRotator.markFailed(token);
        console.log(`[Scrape.do] Key ${token.substring(0, 8)}... failed (${res.status}), trying next key...`);
        lastError = new Error(`Scrape.do request failed: ${res.status}`);
        continue;
      }

      if (!res.ok) {
        lastError = new Error(`Scrape.do request failed: ${res.status}`);
        throw lastError;
      }

      quota.increment('scraperapi', 1);
      const html = await res.text();
      return { html, sourceUrl: url };
    } catch (error) {
      lastError = error;
      console.error(`[Scrape.do] Error with key ${token.substring(0, 8)}...:`, error.message);
    }
  }

  throw lastError || new Error('All Scrape.do keys exhausted or failed');
}

function getStats() {
  if (!scrapeDoRotator) return { status: 'not configured' };
  return {
    provider: 'scrapedo',
    ...scrapeDoRotator.getStats()
  };
}

module.exports = { fetchRaw, getStats };
