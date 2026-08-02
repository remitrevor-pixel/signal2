// ScraperAPI (api.scraperapi.com) — Multi-Key Rotation. Same rotation pattern as
// serper-multi.js / firecrawl-multi.js / scrapedo-multi.js — supports up to 10 keys via
// SCRAPERAPI_API_KEY_1 through SCRAPERAPI_API_KEY_10 (or a single SCRAPERAPI_API_KEY).
// Distinct service from Scrape.do (scrapedo-multi.js) — different endpoint/auth format
// (api_key + url + render + country_code, vs. Scrape.do's token + url + render + geoCode).
//
// This supersedes the old single-key providers/scraperapi.js, which was never actually
// wired up anywhere (dead code) — safe to delete that file once this is in place.
//
// Used two ways:
//   1. As the primary fetch layer for old.reddit.com scraping (reddit-scrape.js) — every
//      request routes through here proactively when keys are configured, matching
//      redditintel's proxy.js behavior (route via the configured proxy on every request,
//      not just ones that got blocked).
//   2. As a fallback step in fetchChain.js's generic fetch chain, for craigslist expand /
//      general web fetch / X / LinkedIn / Facebook expand, when Firecrawl and Scrape.do
//      both fail or are unconfigured.
const KeyRotator = require('./keyRotator');
const quota = require('../quota');

function initScraperApiKeys() {
  const keys = [];

  const singleKey = process.env.SCRAPERAPI_API_KEY;
  if (singleKey) keys.push(singleKey);

  for (let i = 1; i <= 10; i++) {
    const key = process.env[`SCRAPERAPI_API_KEY_${i}`];
    if (key) keys.push(key);
  }

  if (keys.length === 0) {
    console.warn('⚠️ ScraperAPI: No API keys configured (SCRAPERAPI_API_KEY or SCRAPERAPI_API_KEY_1, SCRAPERAPI_API_KEY_2, etc.)');
    return null;
  }

  console.log(`✓ ScraperAPI: Loaded ${keys.length} API key(s)`);
  return new KeyRotator(keys);
}

const scraperApiRotator = initScraperApiKeys();

// Lets callers (reddit-scrape.js) check "is this even set up" before deciding whether to
// route through here proactively or just fetch direct.
function isConfigured() {
  return Boolean(scraperApiRotator && scraperApiRotator.getAllKeys().length);
}

async function fetchRaw(url, { render = true, countryCode } = {}) {
  if (!isConfigured()) {
    throw new Error('ScraperAPI not configured (SCRAPERAPI_API_KEY or SCRAPERAPI_API_KEY_1, SCRAPERAPI_API_KEY_2, etc.)');
  }

  const q1 = quota.check('scraperapi');
  if (!q1.allowed) {
    throw new Error(`ScraperAPI monthly budget exhausted (${q1.used}/${q1.budget}). You have ${scraperApiRotator.getAllKeys().length} key(s) loaded.`);
  }

  let lastError;
  for (let attempt = 0; attempt < scraperApiRotator.getAllKeys().length; attempt++) {
    const key = scraperApiRotator.getNext();
    if (!key) throw new Error('No ScraperAPI keys available');

    try {
      const params = new URLSearchParams({ api_key: key, url, render: render ? 'true' : 'false' });
      if (countryCode) params.set('country_code', countryCode.toLowerCase());

      const res = await fetch(`https://api.scraperapi.com/?${params.toString()}`);

      // Rate limited / out of credits / bad key on this one — mark it and try the next.
      if (res.status === 429 || res.status === 401) {
        scraperApiRotator.markFailed(key);
        console.log(`[ScraperAPI] Key ${key.substring(0, 8)}... failed (${res.status}), trying next key...`);
        lastError = new Error(`ScraperAPI request failed: ${res.status}`);
        continue;
      }

      if (!res.ok) {
        lastError = new Error(`ScraperAPI request failed: ${res.status}`);
        throw lastError;
      }

      quota.increment('scraperapi', 1);
      const html = await res.text();
      return { html, sourceUrl: url };
    } catch (error) {
      lastError = error;
      console.error(`[ScraperAPI] Error with key ${key.substring(0, 8)}...:`, error.message);
    }
  }

  throw lastError || new Error('All ScraperAPI keys exhausted or failed');
}

function getStats() {
  if (!scraperApiRotator) return { status: 'not configured' };
  return { provider: 'scraperapi', ...scraperApiRotator.getStats() };
}

module.exports = { fetchRaw, isConfigured, getStats };
