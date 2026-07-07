// Scrape.do — generic fetcher fallback (handles proxies + optional JS rendering + geo-targeting).
// This is a DIFFERENT service from ScraperAPI.com (different endpoint, different auth param),
// so it needs its own provider rather than reusing scraperapi.js, which was built for the other
// service and will 401 forever against a Scrape.do token no matter how correct the token is.
const quota = require('../quota');

function getKey() {
  // Prefer a properly-named var; fall back to SCRAPERAPI_API_KEY since that's where this key
  // may already be sitting from earlier setup.
  return process.env.SCRAPE_DO_API_KEY || process.env.SCRAPERAPI_API_KEY || '';
}

async function fetchRaw(url, { render = true, countryCode } = {}) {
  const token = getKey();
  if (!token) throw new Error('Scrape.do not configured (SCRAPE_DO_API_KEY)');

  const q1 = quota.check('scraperapi'); // reuses the existing "scraperapi" budget bucket/name
  if (!q1.allowed) throw new Error(`Scrape.do monthly budget exhausted (${q1.used}/${q1.budget}).`);

  const params = new URLSearchParams({ token, url, render: render ? 'true' : 'false' });
  if (countryCode) params.set('geoCode', countryCode.toLowerCase());

  const res = await fetch(`https://api.scrape.do/?${params.toString()}`);
  quota.increment('scraperapi', 1);
  if (!res.ok) throw new Error(`Scrape.do request failed: ${res.status}`);
  const html = await res.text();
  return { html, sourceUrl: url };
}

module.exports = { fetchRaw };
