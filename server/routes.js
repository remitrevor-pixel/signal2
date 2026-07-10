const express = require('express');
const router = express.Router();

const { PLATFORMS, COUNTRIES } = require('./config');
const { parseQuery, matchesQuery, toSearchString } = require('./queryParser');
const reddit = require('./providers/reddit');
const redditScrape = require('./providers/reddit-scrape');
const craigslistScrape = require('./providers/craigslist-scrape');
const serper = require('./providers/serper-multi');
const fetchChain = require('./providers/fetchChain');
const quota = require('./quota');
const keywordStore = require('./keywordStore');
const keywordBankStore = require('./keywordBankStore');
const aiAssist = require('./aiAssist');

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

async function getRedditResults(parsed, searchString, countryList, timeRange) {
  const query = searchString || parsed.positiveWords.join(' OR ') || 'research study';

  // Primary: direct old.reddit.com scrape — real-time data straight from Reddit, no Google
  // indexing lag, no missing recent/low-engagement posts. Reddit's own t= param does the time
  // filtering server-side here, which is why these results skip withinTimeRange() below —
  // re-checking an already-Reddit-filtered result against our own relative-date guesser would
  // just throw away good results whose exact timestamp we didn't parse.
  try {
    const redditTimeMap = { all: undefined, '1h': 'hour', '1d': 'day', '1w': 'week', '1m': 'month' };
    const posts = await redditScrape.searchReddit(query, { sort: 'relevance', limit: 40, timeRange: redditTimeMap[timeRange] });
    return posts
      .filter(p => matchesQuery(parsed, p.title))
      .map(p => {
        const permalink = p.permalink && p.permalink.startsWith('http') ? p.permalink : `https://reddit.com${p.permalink || ''}`;
        // Real timestamp when old.reddit.com's search page exposed one (via the outer .thing
        // wrapper — see reddit-scrape.js); null falls back to "date unknown" in the UI rather
        // than a guessed value.
        const minsAgo = p.createdUtc ? Math.max(0, Math.floor((Date.now() / 1000 - p.createdUtc) / 60)) : null;
        return {
          id: `reddit_${p.id || permalink}`,
          platform: 'reddit',
          country: null, // Reddit content isn't reliably geo-taggable; shown regardless of country filter
          title: p.title,
          snippet: `by u/${p.author || 'unknown'}${p.subreddit ? ' in r/' + p.subreddit : ''} · ${p.score} points · ${p.numComments} comments`,
          source: p.subreddit ? `r/${p.subreddit}` : 'reddit',
          url: permalink,
          minsAgo,
          discovery: false,
        };
      });
  } catch (scrapeErr) {
    console.error('Reddit direct scrape failed, falling back to Serper:', scrapeErr.message);
  }

  // Fallback: Serper-based platformDiscovery (Google's index of reddit.com) — only reached if
  // the direct scrape above threw (Reddit blocked it and the Scrape.do proxy fallback also
  // failed, or old Reddit's HTML structure changed and broke the selectors).
  try {
    const firstCountry = countryList && countryList[0] ? COUNTRIES[countryList[0]] : null;
    const raw = await serper.platformDiscovery(query, 'reddit.com', firstCountry, timeRange);
    return raw
      .filter(r => matchesQuery(parsed, `${r.title} ${r.snippet}`))
      .map((r, i) => {
        const minsAgo = parseRelativeDate(r.date);
        let subreddit = 'reddit';
        const match = r.url.match(/reddit\.com\/r\/([a-zA-Z0-9_]+)/);
        if (match) subreddit = match[1];
        return {
          id: `reddit_${i}_${Buffer.from(r.url).toString('base64').slice(0, 8)}`,
          platform: 'reddit',
          country: null,
          title: r.title,
          snippet: r.snippet,
          source: `r/${subreddit}`,
          url: r.url,
          minsAgo,
          discovery: false,
        };
      })
      .filter(r => withinTimeRange(r.minsAgo, timeRange));
  } catch (e) {
    return { error: `Reddit: ${e.message}` };
  }
}

async function getCraigslistResults(parsed, searchString, countryList, timeRange) {
  const cities = [...new Set(countryList.flatMap(cKey => (COUNTRIES[cKey] && COUNTRIES[cKey].craigslistCities) || []))];
  const query = searchString || parsed.positiveWords.join(' OR ') || 'research study';

  // Primary: Craigslist's own RSS feeds — real, sanctioned, structurally clean by construction
  // (an RSS <item> can't contain sidebar/nav bleed-in the way a scraped HTML page could).
  if (cities.length > 0) {
    try {
      const items = await craigslistScrape.searchCraigslist(cities, query, { limit: 25 });
      const results = items
        .filter(it => matchesQuery(parsed, `${it.title} ${it.description}`))
        .map((it, i) => {
          const minsAgo = it.createdUtc ? Math.max(0, Math.floor((Date.now() / 1000 - it.createdUtc) / 60)) : null;
          const cKey = Object.keys(COUNTRIES).find(k => (COUNTRIES[k].craigslistCities || []).includes(it.city)) || null;
          return {
            id: `craigslist_${i}_${Buffer.from(it.link).toString('base64').slice(0, 8)}`,
            platform: 'craigslist',
            country: cKey,
            title: it.title,
            snippet: it.description,
            source: `${it.city}.craigslist.org`,
            url: it.link,
            minsAgo,
            discovery: false,
          };
        })
        .filter(r => withinTimeRange(r.minsAgo, timeRange));
      return { results, errors: [] };
    } catch (scrapeErr) {
      console.error('Craigslist RSS search failed, falling back to Serper:', scrapeErr.message);
    }
  }

  // Fallback: Serper-based discovery (site:craigslist.org) — only reached if the RSS approach
  // above threw, or no country in the current selection has any mapped Craigslist cities.
  return getSearchBackedResults('craigslist', parsed, searchString, countryList, timeRange);
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
  const { query = '', platforms = '', countries = '', timeRange = 'all', sort = 'relevance', matchMode = 'phrase' } = req.query;
  const platformList = platforms ? platforms.split(',').filter(Boolean) : [];
  const countryList = countries ? countries.split(',').filter(Boolean) : [];

  if (platformList.length === 0 || countryList.length === 0) {
    return res.json({ results: [], errors: [], meta: { note: 'Select at least one platform and one country.' } });
  }

  const parsed = parseQuery(query, { exactPhrase: matchMode !== 'logic' });
  const searchString = toSearchString(parsed) || query.trim();

  let allResults = [];
  const errors = [];
  const launcherLinks = {};

  await Promise.all(platformList.map(async (platformId) => {
    const plat = PLATFORMS[platformId];
    if (!plat) return;

    if (plat.mode === 'api' && platformId === 'reddit') {
      const r = await getRedditResults(parsed, searchString, countryList, timeRange);
      if (r.error) errors.push(r.error); else allResults.push(...r);
    }

    if (plat.mode === 'search') {
      const { results, errors: errs } = await getSearchBackedResults(platformId, parsed, searchString, countryList, timeRange);
      allResults.push(...results);
      errors.push(...errs);
    }

    if (plat.mode === 'search+fetch') {
      // craigslist: real RSS-based search first (see craigslist-scrape.js), falls back to
      // Serper discovery only if that fails. Full posting content still only fetched on /expand.
      const { results, errors: errs } = await getCraigslistResults(parsed, searchString, countryList, timeRange);
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
// Formats a reddit-scrape.js fetchPost() result into the same kind of readable text the
// generic fetchChain produces, so the frontend's expand/detail views don't need special-casing.
function formatRedditPost(post) {
  const lines = [];
  lines.push(post.title || '(no title)');
  if (post.subreddit) lines.push(`r/${post.subreddit} · posted by u/${post.author || 'unknown'} · ${post.score} points`);
  if (post.selftext) { lines.push(''); lines.push(post.selftext); }
  if (post.comments && post.comments.length) {
    lines.push('');
    lines.push(`--- ${post.comments.length} top-level comments ---`);
    const renderComment = (c, depth) => {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}u/${c.author || '[deleted]'} (${c.score} pts): ${c.body}`);
      (c.replies || []).forEach(r => renderComment(r, depth + 1));
    };
    post.comments.forEach(c => renderComment(c, 0));
  }
  return lines.join('\n');
}

// Formats a craigslist-scrape.js fetchPosting() result into readable text, same purpose as
// formatRedditPost above.
function formatCraigslistPosting(p) {
  const lines = [];
  lines.push(p.title || '(no title)');
  const meta = [p.price, p.location].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (p.attrs && p.attrs.length) lines.push(p.attrs.join(' · '));
  lines.push('');
  lines.push(p.body || '(no posting text found)');
  return lines.join('\n');
}

router.post('/expand', async (req, res) => {
  const { url, country } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    // Reddit URLs get real post + full comment thread via the direct scraper instead of the
    // generic fetch chain, which has no special handling for Reddit's markup and tends to
    // return messy, hard-to-read raw HTML for it.
    if (redditScrape.isRedditUrl(url)) {
      try {
        const post = await redditScrape.fetchPost(url);
        return res.json({ provider: 'reddit-scrape', text: formatRedditPost(post), title: post.title, fromCache: false, sourceUrl: url, countryCode: null });
      } catch (redditErr) {
        console.error('Reddit direct post fetch failed, falling back to generic fetch chain:', redditErr.message);
        // fall through to the generic chain below
      }
    }
    // Same idea for Craigslist: scoped extraction of just the posting's own fields, instead of
    // the generic chain stripping the whole page (nav, "also see" related postings, footer).
    if (craigslistScrape.isCraigslistUrl(url)) {
      try {
        const posting = await craigslistScrape.fetchPosting(url);
        return res.json({ provider: 'craigslist-scrape', text: formatCraigslistPosting(posting), title: posting.title, fromCache: false, sourceUrl: url, countryCode: null });
      } catch (clErr) {
        console.error('Craigslist direct posting fetch failed, falling back to generic fetch chain:', clErr.message);
        // fall through to the generic chain below
      }
    }
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

router.get('/keywords', async (req, res) => {
  try {
    res.json(await keywordStore.list());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/keywords', async (req, res) => {
  const { label, query } = req.body || {};
  try {
    const item = await keywordStore.add(label, query);
    res.json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/keywords/:id', async (req, res) => {
  try {
    const removed = await keywordStore.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'not found' });
    res.json({ removed: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- keyword bank (individual reusable keywords, e.g. "survey", "compensation") ----

router.get('/keyword-bank', async (req, res) => {
  try {
    res.json(await keywordBankStore.list());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/keyword-bank', async (req, res) => {
  const { label, value } = req.body || {};
  try {
    const item = await keywordBankStore.add(label, value);
    res.json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/keyword-bank/:id', async (req, res) => {
  try {
    const removed = await keywordBankStore.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'not found' });
    res.json({ removed: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- AI assist: interest email generator + screener explainer ----
// Both accept { text?: string, image?: { base64: string, mimeType: string } } — at least one
// of text/image is required. Image is a raw base64 string (no "data:image/..." prefix).

router.post('/ai/interest-email', async (req, res) => {
  const { text, image } = req.body || {};
  try {
    const result = await aiAssist.generateInterestEmail({ text, image });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/ai/screener-explain', async (req, res) => {
  const { text, image } = req.body || {};
  try {
    const result = await aiAssist.explainScreener({ text, image });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
