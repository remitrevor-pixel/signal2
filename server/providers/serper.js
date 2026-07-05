// Serper.dev — Google Search Results API. This queries Google's index, not the target
// platform directly, so it stays out of platform-specific ToS entirely. Good for General Web,
// University Research (site:edu bias), and lightweight discovery snippets for platforms we
// otherwise only launcher-link to (X, LinkedIn, Facebook, Craigslist).
const { KEYS } = require('../config');
const quota = require('../quota');

async function rawSearch(q, { gl = 'us', num = 10, tbs } = {}) {
  if (!KEYS.serper) throw new Error('Serper not configured (SERPER_API_KEY)');
  const q1 = quota.check('serper');
  if (!q1.allowed) throw new Error(`Serper monthly budget exhausted (${q1.used}/${q1.budget}). Raise SERPER_MONTHLY_BUDGET in .env if you have room left on your actual plan.`);

  const body = { q, gl, num };
  if (tbs) body.tbs = tbs; // e.g. 'qdr:d' = past day, 'qdr:w' = past week, 'qdr:m' = past month, 'qdr:h' = past hour

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': KEYS.serper, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  quota.increment('serper', 1);
  if (!res.ok) throw new Error(`Serper request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.organic || []).map(r => ({
    title: r.title,
    snippet: r.snippet || '',
    url: r.link,
    date: r.date || null, // Serper sometimes returns a relative date string from the SERP snippet
  }));
}

function timeRangeToTbs(rangeId) {
  return { all: undefined, '1h': 'qdr:h', '1d': 'qdr:d', '1w': 'qdr:w', '1m': 'qdr:m' }[rangeId];
}

// General web search, optionally biased to a country
async function generalWeb(searchString, country, timeRange) {
  const gl = (country && country.gl) || 'us';
  return rawSearch(searchString, { gl, tbs: timeRangeToTbs(timeRange) });
}

// University / research-focused: bias toward .edu and common research-recruitment sites
async function universityResearch(searchString, country, timeRange) {
  const gl = (country && country.gl) || 'us';
  const q = `${searchString} (site:edu OR site:sona-systems.com OR site:researchmatch.org OR "focus group" OR "research study")`;
  return rawSearch(q, { gl, tbs: timeRangeToTbs(timeRange) });
}

// Discovery snippets for a platform we don't have a direct API for — stays 100% on Google's
// side of the fence, never touches the target platform.
async function platformDiscovery(searchString, domain, country, timeRange) {
  const gl = (country && country.gl) || 'us';
  const q = `${searchString} site:${domain}`;
  return rawSearch(q, { gl, tbs: timeRangeToTbs(timeRange) });
}

module.exports = { rawSearch, generalWeb, universityResearch, platformDiscovery, timeRangeToTbs };
