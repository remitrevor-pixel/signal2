// Firecrawl — turns a single URL into clean text/markdown with Multi-Key Rotation
// Supports multiple API keys for load balancing and quota distribution
// Used ON-DEMAND ONLY (when user clicks "expand")

const KeyRotator = require('./keyRotator');
const quota = require('../quota');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'fetch-cache.json');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Initialize key rotator with Firecrawl keys from environment
function initFirecrawlKeys() {
  const keys = [];
  
  // Support both single key (FIRECRAWL_API_KEY) and multiple keys (FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2, etc.)
  const singleKey = process.env.FIRECRAWL_API_KEY;
  if (singleKey) keys.push(singleKey);
  
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`FIRECRAWL_API_KEY_${i}`];
    if (key) keys.push(key);
  }
  
  if (keys.length === 0) {
    console.warn('⚠️ Firecrawl: No API keys configured (FIRECRAWL_API_KEY or FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2, etc.)');
    return null;
  }
  
  console.log(`✓ Firecrawl: Loaded ${keys.length} API key(s)`);
  return new KeyRotator(keys);
}

const firecrawlRotator = initFirecrawlKeys();

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
  
  // Return from cache if fresh
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.data, fromCache: true };
  }

  // Check if keys are configured
  if (!firecrawlRotator || firecrawlRotator.getAllKeys().length === 0) {
    throw new Error('Firecrawl not configured (FIRECRAWL_API_KEY or FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2, etc.)');
  }

  // Check quota
  const q1 = quota.check('firecrawl');
  if (!q1.allowed) {
    throw new Error(`Firecrawl monthly budget exhausted (${q1.used}/${q1.budget}). You have ${firecrawlRotator.getAllKeys().length} key(s) loaded.`);
  }

  const body = { url, formats: ['markdown'] };
  if (countryCode) body.location = { country: countryCode.toUpperCase() };

  // Try with each available key
  let lastError;
  for (let attempt = 0; attempt < firecrawlRotator.getAllKeys().length; attempt++) {
    const apiKey = firecrawlRotator.getNext();
    if (!apiKey) throw new Error('No Firecrawl API keys available');

    try {
      const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify(body),
      });

      // If rate limited, mark key as failed and try next
      if (res.status === 429) {
        firecrawlRotator.markFailed(apiKey);
        console.log(`[Firecrawl] Rate limited on key ${apiKey.substring(0, 8)}..., trying next key...`);
        lastError = new Error(`Firecrawl rate limited: ${res.status}`);
        continue;
      }

      if (!res.ok) {
        lastError = new Error(`Firecrawl request failed: ${res.status}`);
        throw lastError;
      }

      quota.increment('firecrawl', 1);
      const json = await res.json();
      
      const data = {
        title: json.data && json.data.metadata && json.data.metadata.title,
        markdown: (json.data && json.data.markdown) || '',
        sourceUrl: url,
      };
      
      // Cache successful response
      cache[cacheKey] = { at: Date.now(), data };
      saveCache(cache);
      
      return { ...data, fromCache: false };
    } catch (error) {
      lastError = error;
      console.error(`[Firecrawl] Error with key ${apiKey.substring(0, 8)}...:`, error.message);
      // Continue to next key
    }
  }

  // All keys failed
  throw lastError || new Error('All Firecrawl keys exhausted or failed');
}

// Get key rotation stats
function getStats() {
  if (!firecrawlRotator) return { status: 'not configured' };
  return {
    provider: 'firecrawl',
    ...firecrawlRotator.getStats()
  };
}

module.exports = { fetchClean, getStats };
