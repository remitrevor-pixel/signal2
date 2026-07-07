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

  // Get next key in rotation
  const apiKey = serperRotator.getNext();
  if (!apiKey) throw new Error('No Serper API keys available');

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const error = `Serper request failed: ${res.status}`;
      
      // If 429 (rate limit), mark this key as failed temporarily
      if (res.status === 429) {
        serperRotator.markFailed(apiKey);
        throw new Error(`${error} - Rate limited. Trying next key...`);
      }
      
      throw new Error(error);
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
    // Log error but don't throw immediately — let caller decide what to do
    console.error(`[Serper] Error with key ${apiKey.substring(0, 8)}...:`, error.message);
    throw error;
  }
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
