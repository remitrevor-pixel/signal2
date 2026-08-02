// Direct Reddit scraper via old.reddit.com. Parsing logic is a line-for-line match with
// redditintel's scraper.js (see parseSearchResults etc. below — unchanged from the previous
// revision of this file).
//
// FETCH LAYER: now routes through the shared scraperapi-multi.js (real ScraperAPI keys,
// SCRAPERAPI_API_KEY / SCRAPERAPI_API_KEY_1.._10) instead of the isolated
// reddit-proxy.js/reddit-proxy-pool.js/reddit-keys.js files from the previous revision —
// those three files are superseded by this and should be deleted. Behavior matches
// redditintel's proxy.js: if ScraperAPI keys are configured, EVERY request routes through
// ScraperAPI proactively (not just ones that got blocked); if not configured, requests go
// out direct. Either way, one blanket retry after a 1s wait on any failure.
//
// isRedditUrl() at the bottom is signal2-specific (routes.js uses it to route /api/expand
// requests here instead of the generic fetchChain) — no equivalent in redditintel.
const cheerio = require('cheerio');
const scraperapi = require('./scraperapi-multi');

const BASE_URL = 'https://old.reddit.com';
// Reddit's own guidance for scrapers is to identify yourself with a real contact — update the
// email below to something you actually monitor. Only used on the direct-fetch path;
// ScraperAPI handles its own request headers when that path is active.
const USER_AGENT = 'signal-research-console/1.0 (contact: you@example.com)';
const MIN_REQUEST_GAP_MS = 1500;
const CACHE_TTL_MS = 60 * 1000;

let lastRequestAt = 0;
let queue = Promise.resolve();
const cache = new Map();

async function fetchOldRedditHtmlOnce(url) {
  if (scraperapi.isConfigured()) {
    // Proactive routing — every request goes through ScraperAPI when keys are configured,
    // matching redditintel's proxy.js exactly (not a reactive on-403-only fallback).
    const { html } = await scraperapi.fetchRaw(url, { render: false });
    return html;
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`old.reddit.com request failed: ${res.status}`);
  return await res.text();
}

// Blanket retry: any failure -> wait 1s -> try the whole thing once more. Matches
// redditintel's fetchWithRetry in proxy.js.
async function fetchWithRetry(url) {
  try {
    return await fetchOldRedditHtmlOnce(url);
  } catch (err) {
    await new Promise((r) => setTimeout(r, 1000));
    return await fetchOldRedditHtmlOnce(url);
  }
}

function throttledFetch(url) {
  queue = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fetchWithRetry(url);
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
// Shared parsing helpers — unchanged from the previous revision (zip1-parity)
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
  // Old Reddit's search page wraps each hit in .search-result-link, not .thing —
  // this was the bug causing search to always return zero results.
  $('div.search-result-link').each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    const titleLink = $el.find('a.search-title').first();
    const titleHref = titleLink.attr('href') || '';
    const scoreText = $el.find('.search-score').first().text().trim(); // e.g. "42 points"
    const commentsText = $el.find('.search-comments').first().text().trim(); // e.g. "13 comments"
    const commentsHref = $el.find('.search-comments').first().attr('href') || '';

    // The title link's href is NOT reliably the comments page — for link
    // posts (anything submitting an external URL) it points to that
    // external URL instead, which is what caused clicking a result to load
    // the wrong thing (e.g. the subreddit's own front page/sidebar, if the
    // href happened to resolve there). data-permalink (when present) and
    // the "N comments" link are both reliably the actual thread URL
    // regardless of post type, so prefer those over the title's href.
    const dataPermalink = $el.attr('data-permalink');
    let permalink;
    if (dataPermalink) {
      permalink = dataPermalink;
    } else if (/\/comments\//.test(commentsHref)) {
      permalink = commentsHref;
    } else if (/\/comments\//.test(titleHref)) {
      permalink = titleHref;
    } else {
      permalink = titleHref; // last resort — may be an external link for link-posts
    }

    // Prefer a real timestamp: data-timestamp if the row happens to carry
    // one, else the <time datetime="..."> ISO string Old Reddit renders
    // next to "submitted X ago" on search result rows.
    let createdUtc = null;
    const dataTimestamp = $el.attr('data-timestamp');
    if (dataTimestamp) {
      createdUtc = Number(dataTimestamp) / 1000;
    } else {
      const iso = $el.find('time').first().attr('datetime');
      if (iso) {
        const parsed = Date.parse(iso);
        if (!isNaN(parsed)) createdUtc = parsed / 1000;
      }
    }

    results.push({
      id: $el.attr('data-fullname') || permalink,
      title: titleLink.text().trim(),
      permalink,
      isExternalLink: !/\/comments\//.test(permalink), // true = link post, no reddit thread to expand
      author: $el.attr('data-author') || $el.find('.search-author a').first().text().trim() || null,
      score: parseInt(scoreText, 10) || 0,
      numComments: parseInt(commentsText, 10) || 0,
      createdUtc,
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
// Public API — unchanged from the previous revision
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
  // IMPORTANT: scope selftext/title to postEl, not the whole page. The
  // subreddit's sidebar description lives in an element with the exact
  // same classes (.usertext-body .md) and appears earlier in the raw HTML
  // than the post itself — searching the whole page with $(...) instead of
  // postEl.find(...) was grabbing the sidebar's "Welcome to r/X..." text
  // instead of the actual post body. This was the cause of search results
  // seeming to open the subreddit instead of the real post.
  const post = {
    id: postEl.attr('data-fullname'),
    title: postEl.find('a.title').first().text().trim() || $('a.title').first().text().trim(),
    author: postEl.attr('data-author'),
    score: Number(postEl.attr('data-score')) || 0,
    selftext: postEl.find('.usertext-body .md').first().text().trim(),
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
// signal2-specific; no equivalent in redditintel.
function isRedditUrl(url) {
  return /^https?:\/\/(old\.|www\.)?reddit\.com\//i.test(url);
}

module.exports = { fetchSubreddit, searchReddit, fetchPost, isRedditUrl };
