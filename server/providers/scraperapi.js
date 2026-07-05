// ScraperAPI — fallback generic fetcher (handles proxies + optional JS rendering).
// Only used when Firecrawl fails or its budget is exhausted, and only on-demand (see firecrawl.js
// for the "why on-demand, not automatic" reasoning — same logic applies here).
const { KEYS } = require('../config');
const quota = require('../quota');

async function fetchRaw(url, { render = true, countryCode } = {}) {
  if (!KEYS.scraperapi) throw new Error('ScraperAPI not configured (SCRAPERAPI_API_KEY)');
  const q1 = quota.check('scraperapi');
  if (!q1.allowed) throw new Error(`ScraperAPI monthly budget exhausted (${q1.used}/${q1.budget}).`);

  const params = new URLSearchParams({ api_key: KEYS.scraperapi, url, render: render ? 'true' : 'false' });
  if (countryCode) params.set('country_code', countryCode.toLowerCase());
  const res = await fetch(`https://api.scraperapi.com/?${params.toString()}`);
  quota.increment('scraperapi', 1);
  if (!res.ok) throw new Error(`ScraperAPI request failed: ${res.status}`);
  const html = await res.text();
  return { html, sourceUrl: url };
}

module.exports = { fetchRaw };
