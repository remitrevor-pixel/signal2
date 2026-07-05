// ScrapingBot — another generic fetch fallback. Small free tier, so it's last in the
// on-demand fetch chain (see fetchChain.js). Disabled automatically if no key is set.
const { KEYS } = require('../config');
const quota = require('../quota');

async function fetchRaw(url, { countryCode } = {}) {
  const { user, key } = KEYS.scrapingbot;
  if (!user || !key) throw new Error('ScrapingBot not configured (SCRAPINGBOT_USER / SCRAPINGBOT_API_KEY)');
  const q1 = quota.check('scrapingbot');
  if (!q1.allowed) throw new Error(`ScrapingBot monthly budget exhausted (${q1.used}/${q1.budget}).`);

  const auth = Buffer.from(`${user}:${key}`).toString('base64');
  const payload = { url };
  // NOTE: verify the current proxy-country field name in ScrapingBot's dashboard/docs before
  // relying on this — their premium-proxy geotargeting option name may differ by plan.
  if (countryCode) payload.proxyCountry = countryCode.toUpperCase();
  const res = await fetch('https://api.scrapingbot.io/scrape/raw-html', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  quota.increment('scrapingbot', 1);
  if (!res.ok) throw new Error(`ScrapingBot request failed: ${res.status}`);
  const html = await res.text();
  return { html, sourceUrl: url };
}

module.exports = { fetchRaw };
