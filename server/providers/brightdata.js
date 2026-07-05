// Bright Data — full scraping-browser / Web Unlocker infrastructure. Capable of handling the
// hardest targets (X, LinkedIn), but that's overkill and higher-exposure for a 2-3 person
// personal tool, and those are exactly the platforms with the most active litigation. Wired in
// as an opt-in fallback for the launcher+search platforms' discovery layer only if you
// explicitly want it — never targets Craigslist by default (see routes.js).
const { KEYS, ENABLE } = require('../config');
const quota = require('../quota');

async function fetchViaUnlocker(url, { countryCode } = {}) {
  if (!ENABLE.brightdata) throw new Error('Bright Data is disabled by default. Set ENABLE_BRIGHTDATA=true in .env to opt in.');
  if (!KEYS.brightdata) throw new Error('Bright Data not configured (BRIGHTDATA_API_KEY)');
  const q1 = quota.check('brightdata');
  if (!q1.allowed) throw new Error(`Bright Data monthly budget exhausted (${q1.used}/${q1.budget}).`);

  const payload = { zone: 'web_unlocker1', url, format: 'raw' };
  // NOTE: verify the current country-targeting field for your specific Bright Data zone type
  // in their dashboard — Web Unlocker zones typically take a `country` field, but this can
  // vary by zone configuration.
  if (countryCode) payload.country = countryCode.toLowerCase();

  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEYS.brightdata}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  quota.increment('brightdata', 1);
  if (!res.ok) throw new Error(`Bright Data request failed: ${res.status}`);
  const html = await res.text();
  return { html, sourceUrl: url };
}

module.exports = { fetchViaUnlocker };
