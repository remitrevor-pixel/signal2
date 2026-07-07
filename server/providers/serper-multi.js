// Serper.dev — Google Search Results API with Multi-Key Rotation
// Supports multiple API keys for load balancing and quota distribution
// Automatically rotates through available keys

const KeyRotator = require('./keyRotator');
const quota = require('../quota');

// Initialize key rotator with Serper keys from environment
function initSerperKeys() {
  const keys = [];
  
  // Support both single key (SERPER_API_KEY) and multiple keys (SERPER_API_KEY_1, SERPER_API_KEY_2, etc.)
  const singleKey = process.env.SERPER_API_KEY;
  if (singleKey) keys.push(singleKey);
  
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`SERPER_API_KEY_${i}`];
    if (key) keys.push(key);
  }
  
  if (keys.length === 0) {
    console.warn('⚠️ Serper: No API keys configured (SERPER_API_KEY or SERPER_API_KEY_1, SERPER_API_KEY_2, etc.)');
    return null;
  }
  
  console.log(`✓ Serper: Loaded ${keys.length} API key(s)`);
  return new KeyRotator(keys);
}

const serperRotator = initSerperKeys();

async function rawSearch(q, { gl = 'us', num = 10, tbs } = {}) {
  if (!serperRotator || serperRotator.getAllKeys().length === 0) {
    throw new Error('Serper not configured (SERPER_API_KEY or SERPER_API_KEY_1, SERPER_API_KEY_2, etc.)');
  }

  const q1 = quota.check('serper');
  if (!q1.allowed) {
    throw new Error(`Serper monthly budget exhausted (${q1.used}/${q1.budget}). Raise SERPER_MONTHLY_BUDGET in .env if you have room left on your actual plan.`);
  }

  const body = { q, gl, num };
  if (tbs) body.tbs = tbs; // e.g. 'qdr:d' = past day, 'qdr:w' = past week, 'qdr:m' = past month

  // Try every available key before giving up — a single bad/exhausted/wrong-plan key should
  // never fail the whole search when other good keys are sitting right there in rotation.
  let lastError;
  for (let attempt = 0; attempt < serperRotator.getAllKeys().length; attempt++) {
    const apiKey = serperRotator.getNext();
    if (!apiKey) break;

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastError = new Error(`Serper request failed: ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
        // Any failure status (400/401/403/429/5xx) on this key — mark it and try the next one.
        serperRotator.markFailed(apiKey);
        console.log(`[Serper] Key ${apiKey.substring(0, 8)}... failed (${res.status}), trying next key...`);
        continue;
      }

      quota.increment('serper', 1);
      const json = await res.json();
      return (json.organic || []).map(r => ({
        title: r.title,
        snippet: r.snippet || '',
        url: r.link,
        date: r.date || null,
      }));
    } catch (error) {
      lastError = error;
      console.error(`[Serper] Error with key ${apiKey.substring(0, 8)}...:`, error.message);
    }
  }

  throw lastError || new Error('All Serper keys exhausted or failed');
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

// Discovery snippets for a platform we don't have a direct API for (X, LinkedIn, Facebook,
// Craigslist) — stays 100% on Google's side of the fence, never touches the target platform.
async function platformDiscovery(searchString, domain, country, timeRange) {
  const gl = (country && country.gl) || 'us';
  const q = `${searchString} site:${domain}`;
  return rawSearch(q, { gl, tbs: timeRangeToTbs(timeRange) });
}

// Get key rotation stats
function getStats() {
  if (!serperRotator) return { status: 'not configured' };
  return {
    provider: 'serper',
    ...serperRotator.getStats()
  };
}

module.exports = { 
  rawSearch, 
  generalWeb, 
  universityResearch, 
  platformDiscovery,
  timeRangeToTbs,
  getStats 
};
