// Firecrawl — turns a single URL into clean text/markdown (handles JS rendering).
// Used ON-DEMAND ONLY (when the user clicks "expand" on a specific result), never as an
// automatic bulk crawl. This keeps request volume low and mirrors ordinary human browsing
// rather than continuous automated collection, which is the fact pattern that's actually
// been litigated against Craigslist scrapers.
const { KEYS } = require('../config');
const quota = require('../quota');

// Simple in-memory + on-disk cache so repeated expands of the same URL within a day
// don't burn additional Firecrawl credits.
const fs = require('fs');
const path = require('path');
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'fetch-cache.json');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveCache(c) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
}

async function fetchClean(url, { countryCode } = {}) {
  const cacheKey = countryCode ? `${countryCode}::${url}` : url;
  const cache = loadCache();
  const hit = cache[cacheKey];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.data, fromCache: true };
  }

  if (!KEYS.firecrawl) throw new Error('Firecrawl not configured (FIRECRAWL_API_KEY)');
  const q1 = quota.check('firecrawl');
  if (!q1.allowed) throw new Error(`Firecrawl monthly budget exhausted (${q1.used}/${q1.budget}).`);

  const body = { url, formats: ['markdown'] };
  if (countryCode) body.location = { country: countryCode.toUpperCase() };

  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEYS.firecrawl}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  quota.increment('firecrawl', 1);
  if (!res.ok) throw new Error(`Firecrawl request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const data = {
    title: json.data && json.data.metadata && json.data.metadata.title,
    markdown: (json.data && json.data.markdown) || '',
    sourceUrl: url,
  };
  cache[cacheKey] = { at: Date.now(), data };
  saveCache(cache);
  return { ...data, fromCache: false };
}

module.exports = { fetchClean };
