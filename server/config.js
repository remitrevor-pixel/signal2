require('dotenv').config();

const PLATFORMS = {
  reddit: {
    name: 'Reddit',
    mode: 'api',            // real official API
    country: 'global',      // reddit isn't country-partitioned; we tag by subreddit convention only
  },
  discord: {
    name: 'Discord',
    mode: 'bot',            // handled by the separate bot process, not this server
  },
  web: {
    name: 'General Web',
    mode: 'search',         // Serper (Google SERP)
  },
  university: {
    name: 'University Research',
    mode: 'search',         // Serper with site:edu bias
  },
  craigslist: {
    name: 'Craigslist',
    mode: 'search+fetch',   // Serper for discovery, Firecrawl/ScraperAPI only on explicit expand
    searchDomain: 'craigslist.org',
  },
  x: {
    name: 'X / Twitter',
    mode: 'launcher+search', // launcher always; Serper snippet as a bonus if available
    searchDomain: 'x.com',
  },
  linkedin: {
    name: 'LinkedIn',
    mode: 'launcher+search',
    searchDomain: 'linkedin.com',
  },
  facebook: {
    name: 'Facebook',
    mode: 'launcher+search',
    searchDomain: 'facebook.com',
  },
};

const COUNTRIES = {
  us: { name: 'United States', flag: '🇺🇸', craigslistCities: ['newyork', 'losangeles', 'chicago', 'austin'], gl: 'us' },
  uk: { name: 'United Kingdom', flag: '🇬🇧', craigslistCities: ['london'], gl: 'uk' },
  ca: { name: 'Canada', flag: '🇨🇦', craigslistCities: ['toronto', 'vancouver'], gl: 'ca' },
  au: { name: 'Australia', flag: '🇦🇺', craigslistCities: ['sydney', 'melbourne'], gl: 'au' },
};

// Monthly soft-budget targets for providers that burn paid/limited requests.
// These are targets for the quota tracker to warn against, not hard platform limits.
const PROVIDER_BUDGETS = {
  serper: parseInt(process.env.SERPER_MONTHLY_BUDGET || '1500', 10),
  firecrawl: parseInt(process.env.FIRECRAWL_MONTHLY_BUDGET || '600', 10),
  scraperapi: parseInt(process.env.SCRAPERAPI_MONTHLY_BUDGET || '400', 10),
  proxyscrape: parseInt(process.env.PROXYSCRAPE_MONTHLY_BUDGET || '0', 10), // off by default
  brightdata: parseInt(process.env.BRIGHTDATA_MONTHLY_BUDGET || '0', 10),   // off by default
  scrapingbot: parseInt(process.env.SCRAPINGBOT_MONTHLY_BUDGET || '0', 10), // off by default
};

const KEYS = {
  reddit: {
    clientId: process.env.REDDIT_CLIENT_ID || '',
    clientSecret: process.env.REDDIT_CLIENT_SECRET || '',
    userAgent: process.env.REDDIT_USER_AGENT || 'signal-console/1.0 (personal research tool)',
  },
  serper: process.env.SERPER_API_KEY || '',
  firecrawl: process.env.FIRECRAWL_API_KEY || '',
  scraperapi: process.env.SCRAPERAPI_API_KEY || '',
  proxyscrape: process.env.PROXYSCRAPE_API_KEY || '',
  brightdata: process.env.BRIGHTDATA_API_KEY || '',
  scrapingbot: {
    user: process.env.SCRAPINGBOT_USER || '',
    key: process.env.SCRAPINGBOT_API_KEY || '',
  },
};

// Explicit on/off switches per risky provider — default OFF even if a key is present,
// so nothing hits a higher-risk pathway without a deliberate opt-in in .env.
const ENABLE = {
  proxyscrape: process.env.ENABLE_PROXYSCRAPE === 'true',
  brightdata: process.env.ENABLE_BRIGHTDATA === 'true',
  craigslistFetch: process.env.ENABLE_CRAIGSLIST_FETCH !== 'false', // on-demand fetch, default true
};

module.exports = { PLATFORMS, COUNTRIES, PROVIDER_BUDGETS, KEYS, ENABLE };
