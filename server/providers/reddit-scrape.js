// Direct Reddit scraper via old.reddit.com — real-time, real data straight from Reddit itself,
// instead of going through Google's index (serper-multi's platformDiscovery) which has crawl
// lag and can miss recent/low-engagement posts, or the public /search.json endpoint (which gets
// blocked outright, see reddit-public.js history).
//
// Adapted from a similar approach used in the "redditintel" project: old.reddit.com serves much
// lighter, less bot-protected HTML than new reddit.com, is throttled to stay under Reddit's
// radar, and falls back to a proxy (here: your existing Scrape.do key rotation) if Reddit blocks
// the request outright — which does happen to Render's shared IP ranges from time to time.
//
// Fragility tradeoff, by design: this depends on old Reddit's HTML structure via CSS selectors.
// If Reddit changes that markup, parsing breaks. getRedditResults() in routes.js catches that
// and falls back to the Serper-based platformDiscovery approach automatically, so a selector
// break degrades gracefully instead of taking Reddit results down entirely.
const cheerio = require('cheerio');
const scrapedo = require('./scrapedo-multi');

const BASE_URL = 'https://old.reddit.com';
// Reddit's own guidance for scrapers is to identify yourself with a real contact — update the
// email below to something you actually monitor.
const USER_AGENT = 'signal-research-console/1.0 (contact: you@example.com)';
const MIN_REQUEST_GAP_MS = 1500;
const CACHE_TTL_MS = 60 * 1000;

let lastRequestAt = 0;
let queue = Promise.resolve();
const cache = new Map();

async function fetchOldRedditHtml(url) {
  // Direct attempt first — works fine most of the time.
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return await res.text();
    if (res.status !== 403 && res.status !== 429) {
      throw new Error(`old.reddit.com request failed: ${res.status}`);
    }
    // 403/429 — Reddit is blocking this IP for this request. Fall through to proxy fallback.
  } catch (directErr) {
    // Network-level failure (timeout, DNS, etc.) — also try the proxy fallback below.
  }

  // Proxy fallback — reuses your existing Scrape.do keys rather than requiring a separate,
  // dedicated proxy API key just for this one provider.
  try {
    const proxied = await scrapedo.fetchRaw(url, { render: false });
    return proxied.html;
  } catch (proxyErr) {
    throw new Error(`old.reddit.com blocked this request and the Scrape.do fallback also failed: ${proxyErr.message}`);
  }
}

function throttledFetch(url) {
  queue = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fetchOldRedditHtml(url);
  });
  return queue;
}

async function cachedFetch(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.html;
  const html = await throttledFetch(url);
  cache.set(url, { html, at: Date.now() });
  return html;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parses "thing"-style listing rows (subreddit hot/new/top/rising pages). */
function parseListingThings($, limit) {
  const posts = [];
  $('div.thing[data-fullname]').each((_, el) => {
    if (posts.length >= limit) return;
    const $el = $(el);
    posts.push({
      id: $el.attr('data-fullname'),
      title: $el.find('a.title').first().text().trim(),
      url: $el.attr('data-url'),
      permalink: $el.attr('data-permalink'),
      author: $el.attr('data-author'),
      score: Number($el.attr('data-score')) || 0,
      numComments: Number($el.attr('data-comments-count')) || 0,
      createdUtc: Number($el.attr('data-timestamp')) / 1000 || null,
      subreddit: $el.attr('data-subreddit'),
    });
  });
  return posts;
}

/** Parses search-results-page rows, which use a different wrapper than listings. */
function parseSearchResults($, limit) {
  const results = [];
  $('div.search-result-link').each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    const titleLink = $el.find('a.search-title').first();
    const href = titleLink.attr('href') || '';
    const scoreText = $el.find('.search-score').first().text().trim(); // e.g. "42 points"
    const commentsText = $el.find('.search-comments').first().text().trim(); // e.g. "13 comments"

    results.push({
      id: $el.attr('data-fullname') || href,
      title: titleLink.text().trim(),
      permalink: href,
      author: $el.attr('data-author') || $el.find('.search-author a').first().text().trim() || null,
      score: parseInt(scoreText, 10) || 0,
      numComments: parseInt(commentsText, 10) || 0,
      subreddit: $el.attr('data-subreddit') || ($el.find('.search-subreddit-link').first().text().trim() || '').replace(/^r\//, ''),
    });
  });
  return results;
}

function parseComments($, container) {
  const comments = [];
  container.children('div.comment').each((_, el) => {
    const $c = $(el);
    if ($c.hasClass('deleted')) return;
    const body = $c.find('> .entry .usertext-body .md').first().text().trim();
    const childContainer = $c.find('> .child > .sitetable').first();
    comments.push({
      id: $c.attr('data-fullname'),
      author: $c.attr('data-author'),
      score: Number($c.attr('data-score')) || 0,
      body,
      replies: childContainer.length ? parseComments($, childContainer) : [],
    });
  });
  return comments;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function fetchSubreddit(subreddit, sort = 'hot', limit = 25, timeRange = '') {
  let url = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/${sort}/`;
  if (timeRange && (sort === 'top' || sort === 'controversial')) {
    url += `?t=${encodeURIComponent(timeRange)}`;
  }
  const html = await cachedFetch(url);
  const $ = cheerio.load(html);
  return parseListingThings($, limit);
}

async function searchReddit(query, { subreddit, sort = 'relevance', limit = 25, timeRange = '' } = {}) {
  const base = subreddit ? `${BASE_URL}/r/${encodeURIComponent(subreddit)}` : BASE_URL;
  let url = `${base}/search/?q=${encodeURIComponent(query)}&sort=${sort}&restrict_sr=${subreddit ? 'on' : 'off'}`;
  if (timeRange) url += `&t=${encodeURIComponent(timeRange)}`;
  const html = await cachedFetch(url);
  const $ = cheerio.load(html);
  return parseSearchResults($, limit);
}

async function fetchPost(permalinkOrUrl) {
  const url = permalinkOrUrl.startsWith('http')
    ? permalinkOrUrl.replace('https://www.reddit.com', BASE_URL).replace('https://reddit.com', BASE_URL)
    : `${BASE_URL}${permalinkOrUrl}`;
  const html = await cachedFetch(url);
  const $ = cheerio.load(html);
  const postEl = $('div.thing[data-fullname]').first();
  const post = {
    id: postEl.attr('data-fullname'),
    title: $('a.title').first().text().trim(),
    author: postEl.attr('data-author'),
    score: Number(postEl.attr('data-score')) || 0,
    selftext: $('.usertext-body .md').first().text().trim(),
    subreddit: postEl.attr('data-subreddit'),
    url: postEl.attr('data-url'),
    permalink: url,
  };
  const topLevelContainer = $('.commentarea > .sitetable').first();
  post.comments = parseComments($, topLevelContainer);
  return post;
}

// True if a URL points at Reddit in any of its common host forms — used by routes.js to decide
// whether to route an /api/expand request through fetchPost() instead of the generic fetchChain.
function isRedditUrl(url) {
  return /^https?:\/\/(old\.|www\.)?reddit\.com\//i.test(url);
}

module.exports = { fetchSubreddit, searchReddit, fetchPost, isRedditUrl };
