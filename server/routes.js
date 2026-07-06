const express = require('express');
const router = express.Router();

const { PLATFORMS, COUNTRIES } = require('./config');
const { parseQuery, matchesQuery, toSearchString } = require('./queryParser');
const reddit = require('./providers/reddit');
const redditPublic = require('./providers/reddit-public');
const serper = require('./providers/serper');
const fetchChain = require('./providers/fetchChain');
const quota = require('./quota');
const keywordStore = require('./keywordStore');

// ---- helpers ----

function minutesAgoFromUnix(sec) {
  return Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
}

// Best-effort parse of Google SERP's relative date strings ("3 days ago", "2 hours ago",
// "Jun 4, 2026"). Returns minutes-ago, or null if we genuinely can't tell — we do NOT
// fabricate a timestamp for real data; unknown stays unknown.
function parseRelativeDate(str) {
  if (!str) return null;
  const s = str.toLowerCase().trim();
  const rel = s.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const mult = { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200, year: 525600 }[unit];
    return n * mult;
  }
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) return Math.max(0, Math.round((Date.now() - parsed) / 60000));
  return null;
}

function timeRangeMaxMinutes(rangeId) {
  return { all: null, '1h': 60, '1d': 1440, '1w': 10080, '1m': 43200 }[rangeId] ?? null;
}

function withinTimeRange(minsAgo, rangeId) {
  const max = timeRangeMaxMinutes(rangeId);
  if (max === null) return true;          // "all time" — no filter
  if (minsAgo === null) return false;      // unknown date + a specific range requested -> exclude, don't guess
  return minsAgo <= max;
}

// ---- platform result builders ----

async function getRedditResults(parsed, searchString) {
  try {
    // Use public Reddit search endpoint — no authentication required
    const posts = await redditPublic.searchPublic(searchString || parsed.positiveWords.join(' OR ') || 'research study');
    return posts
      .filter(p => matchesQuery(parsed, p.title + ' ' + (p.snippet || '')))
      .map(p => ({
        id: p.id,
        platform: 'reddit',
        country: null, // Reddit content isn't reliably geo-taggable; shown regardless of country filter
        title: p.title,
        snippet: p.snippet,
        source: p.source,
        url: p.url,
        minsAgo: p.minsAgo,
        engagement: p.engagement || 0,
        discovery: false,
      }));
  } catch (e) {
    return { error: `Reddit: ${e.message}` };
  }
}

async function getSearchBackedResults(platformId, parsed, searchString, countries, timeRange) {
  const results = [];
  const errors = [];
  const plat = PLATFORMS[platformId];

  for (const cKey of countries) {
    const country = COUNTRIES[cKey];
    try {
      let raw;
      if (platformId === 'web') raw = await serper.generalWeb(searchString, country, timeRange);
      else if (platformId === 'university') raw = await serper.universityResearch(searchString, country, timeRange);
      else raw = await serper.platformDiscovery(searchString, plat.searchDomain, country, timeRange);

      raw.forEach((r, i) => {
        const text = `${r.title} ${r.snippet}`;
        if (!matchesQuery(parsed, text)) return;
        const minsAgo = parseRelativeDate(r.date);
        if (!withinTimeRange(minsAgo, timeRange)) return;
        results.push({
          id: `${platformId}_${cKey}_${i}_${Buffer.from(r.url).toString('base64').slice(0, 8)}`,
          platform: platformId,
          country: cKey,
          title: r.title,
          snippet: r.snippet,
          source: new URL(r.url).hostname,
          url: r.url,
          minsAgo,
          real: true,
        });
      });
    } catch (e) {
      errors.push(`${plat.name} (${country ? country.name : cKey}): ${e.message}`);
    }
  }
  return { results, errors };
}

// One discovery call per platform (not per country) for launcher-only platforms, to conserve budget
async function getLauncherDiscovery(platformId, parsed, searchString, countries, timeRange) {
  const plat = PLATFORMS[platformId];
  const firstCountry = countries[0] ? COUNTRIES[countries[0]] : null;
  try {
    const raw = await serper.platformDiscovery(searchString, plat.searchDomain, firstCountry, timeRange);
    return raw
      .filter(r => matchesQuery(parsed, `${r.title} ${r.snippet}`))
      .map((r, i) => {
        const minsAgo = parseRelativeDate(r.date);
        return {
          id: `${platformId}_disc_${i}_${Buffer.from(r.url).toString('base64').slice(0, 8)}`,
          platform: platformId,
          country: null, // discovery snippet, not reliably tied to one selected country
          title: r.title,
          snippet: r.snippet,
          source: new URL(r.url).hostname,
          url: r.url,
          minsAgo,
          real: true,
          discovery: true, // this is a Google-side snippet ABOUT the platform, not a direct API result
        };
      })
      .filter(r => withinTimeRange(r.minsAgo, timeRange));
  } catch (e) {
    return { error: `${plat.name} discovery: ${e.message}` };
  }
}

function buildLauncherUrl(platformId, searchString, country) {
  const q = encodeURIComponent(searchString || '');
  switch (platformId) {
    case 'x': return `https://twitter.com/search?q=${q}&src=typed_query&f=live`;
    case 'linkedin': return `https://www.linkedin.com/search/results/content/?keywords=${q}`;
    case 'facebook': return `https://www.facebook.com/search/posts/?q=${q}`;
    case 'craigslist': {
      const city = (country && country.craigslistCities && country.craigslistCities[0]) || 'newyork';
      return `https://${city}.craigslist.org/search/gigs?query=${q}`;
    }
    default: return `https://www.google.com/search?q=${q}`;
  }
}

// ---- routes ----

router.get('/search', async (req, res) => {
  const { query = '', platforms = '', countries = '', timeRange = 'all', sort = 'relevance' } = req.query;
  const platformList = platforms ? platforms.split(',').filter(Boolean) : [];
  const countryList = countries ? countries.split(',').filter(Boolean) : [];

  if (platformList.length === 0 || countryList.length === 0) {
    return res.json({ results: [], errors: [], meta: { note: 'Select at least one platform and one country.' } });
  }

  const parsed = parseQuery(query);
  const searchString = toSearchString(parsed) || query.trim();

  let allResults = [];
  const errors = [];
  const launcherLinks = {};

  await Promise.all(platformList.map(async (platformId) => {
    const plat = PLATFORMS[platformId];
    if (!plat) return;

    if (plat.mode === 'api' && platformId === 'reddit') {
      const r = await getRedditResults(parsed, searchString);
      if (r.error) errors.push(r.error); else allResults.push(...r);
    }

    if (plat.mode === 'search') {
      const { results, errors: errs } = await getSearchBackedResults(platformId, parsed, searchString, countryList, timeRange);
      allResults.push(...results);
      errors.push(...errs);
    }

    if (plat.mode === 'search+fetch') {
      // craigslist: discovery via Serper (site:craigslist.org), full content only fetched on /expand
      const { results, errors: errs } = await getSearchBackedResults(platformId, parsed, searchString, countryList, timeRange);
      allResults.push(...results);
      errors.push(...errs);
      countryList.forEach(cKey => {
        launcherLinks[`craigslist_${cKey}`] = buildLauncherUrl('craigslist', searchString, COUNTRIES[cKey]);
      });
    }

    if (plat.mode === 'launcher+search') {
      const disc = await getLauncherDiscovery(platformId, parsed, searchString, countryList, timeRange);
      if (Array.isArray(disc)) allResults.push(...disc);
      else if (disc && disc.error) errors.push(disc.error);
      launcherLinks[platformId] = buildLauncherUrl(platformId, searchString, COUNTRIES[countryList[0]]);
    }

    if (plat.mode === 'bot') {
      // Discord is served by the separate bot process; the frontend calls it directly (see README).
    }
  }));

  // country filter (skip null-country results, e.g. Reddit / discovery snippets — always shown)
  allResults = allResults.filter(r => r.country === null || countryList.includes(r.country));

  if (sort === 'newest') {
    allResults.sort((a, b) => (a.minsAgo ?? Infinity) - (b.minsAgo ?? Infinity));
  } else {
    // relevance: real matched-word count against the query, recency as tiebreaker
    const score = (r) => {
      const text = `${r.title} ${r.snippet || ''}`.toLowerCase();
      const hits = parsed.positiveWords.filter(w => text.includes(w)).length;
      return hits * 1000 - (r.minsAgo ?? 999999) * 0.001;
    };
    allResults.sort((a, b) => score(b) - score(a));
  }

  res.json({
    results: allResults,
    errors,
    launcherLinks,
    meta: { searchString, quota: quota.summary() },
  });
});

// On-demand full content fetch — only called when the user clicks "expand" on a specific result.
// Pass the result's country so the fetch is geo-targeted (helps with geo-restricted content).
router.post('/expand', async (req, res) => {
  const { url, country } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const page = await fetchChain.fetchPage(url, country);
    res.json(page);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/quota', (req, res) => {
  res.json(quota.summary());
});

// ---- saved keywords / queries ----

router.get('/keywords', (req, res) => {
  res.json(keywordStore.list());
});

router.post('/keywords', (req, res) => {
  const { label, query } = req.body || {};
  try {
    const item = keywordStore.add(label, query);
    res.json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/keywords/:id', (req, res) => {
  const removed = keywordStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'not found' });
  res.json({ removed: true });
});

module.exports = router;
