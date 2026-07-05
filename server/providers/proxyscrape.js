// ProxyScrape — raw proxy list provider. Unlike Firecrawl/ScraperAPI/ScrapingBot (managed
// services that make the request on their own infrastructure), this hands YOU a proxy IP and
// you make the request through it. That's a materially different, higher-risk pattern:
// routing your own traffic through rotating IPs specifically to reach a site is the exact
// fact pattern courts have penalized in the Craigslist scraping cases (3Taps, RadPad both
// turned partly on proxy use to route around an IP block).
//
// This provider is wired in but the config default is OFF (ENABLE_PROXYSCRAPE=false).
// Turning it on is a deliberate choice you make in .env, not something the app does for you.
const { KEYS, ENABLE } = require('../config');
const quota = require('../quota');

async function getProxy() {
  if (!ENABLE.proxyscrape) throw new Error('ProxyScrape is disabled by default. Set ENABLE_PROXYSCRAPE=true in .env to opt in (see README for the risk tradeoff first).');
  if (!KEYS.proxyscrape) throw new Error('ProxyScrape not configured (PROXYSCRAPE_API_KEY)');
  const q1 = quota.check('proxyscrape');
  if (!q1.allowed) throw new Error(`ProxyScrape monthly budget exhausted (${q1.used}/${q1.budget}).`);

  const res = await fetch(`https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&format=json`, {
    headers: { 'Authorization': `Bearer ${KEYS.proxyscrape}` },
  });
  quota.increment('proxyscrape', 1);
  if (!res.ok) throw new Error(`ProxyScrape request failed: ${res.status}`);
  const json = await res.json();
  const list = json.proxies || [];
  if (!list.length) throw new Error('ProxyScrape returned no proxies');
  const p = list[Math.floor(Math.random() * list.length)];
  return `${p.ip}:${p.port}`;
}

module.exports = { getProxy };
