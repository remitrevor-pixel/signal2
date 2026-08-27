// Fallback for when old.reddit.com's logged-out access is blocked (it now is — see
// reddit-scrape.js). Redlib is a self-hostable, open-source Reddit front-end that renders
// plain server-side HTML (no JS needed to view it), so this gets tried when the
// old.reddit.com path fails.
//
// Ported to this project's CommonJS style from a reference redlib.js (which used
// import/export + a REDLIB_URL-required guard). Defaults REDLIB_URL to the instance you
// already have running (https://redlib-2ryy.onrender.com) so it works out of the box, but
// still honors an env override if you point it at a different/self-hosted instance.
//
// Honest caveat carried over: Redlib fetches Reddit's own .json endpoints internally, the
// same mechanism that's under pressure generally — this isn't a guaranteed fix, just a
// reasonable, low-cost thing to try. If it also fails, that failure gets surfaced clearly
// rather than silently swallowed.
//
// Selectors below are taken from Redlib's actual template source
// (github.com/redlib-org/redlib/templates/{search,post,comment,utils}.html) rather than
// guessed.
const cheerio = require('cheerio');
const axios = require('axios');

const REDLIB_URL = (process.env.REDLIB_URL || 'https://redlib-2ryy.onrender.com').replace(/\/$/, '');
const USER_AGENT = 'signal-console/1.0 (contact: you@example.com)';

// Render's free tier sleeps a service after ~15 min of no traffic, and waking it back up can
// take 30-60+ seconds for something like Redlib (a compiled Rust binary in a Docker image —
// slower to cold-start than a typical Node app). Two stages: a quick check first (fast when
// already warm), then one patient retry with a much longer timeout if that fails, to cover a
// cold start that's now actually in progress (the first request is usually what triggers
// Render to start spinning the container up at all).
const QUICK_TIMEOUT_MS = Number(process.env.REDLIB_QUICK_TIMEOUT_MS) || 10000;
const COLD_START_TIMEOUT_MS = Number(process.env.REDLIB_COLD_START_TIMEOUT_MS) || 70000;

function redlibEnabled() {
  return Boolean(REDLIB_URL);
}

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: QUICK_TIMEOUT_MS });
    return res.data;
  } catch (err) {
    // Give it one patient retry — likely a cold start now underway.
    const res = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: COLD_START_TIMEOUT_MS });
    return res.data;
  }
}

// Mirrors reddit-scrape.js's parseSearchResults() output shape, so callers (getRedditResults'
// fallback in routes.js) don't need to care which source produced it.
function parseRedlibSearchResults($, limit) {
  const results = [];
  $('div.post').each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    const titleLink = $el.find('h2.post_title a, h1.post_title a').first();
    const permalink = titleLink.attr('href') || '';
    const communityLink = $el.find('a.post_subreddit').first();
    const authorLink = $el.find('a.post_author').first();
    const createdSpan = $el.find('span.created').first();
    const scoreEl = $el.find('div.post_score').first();
    const commentsLink = $el.find('a.post_comments').first();

    results.push({
      id: $el.attr('id') || permalink,
      title: titleLink.text().trim(),
      permalink,
      isExternalLink: false, // Redlib's post_title link is always the actual thread, unlike old.reddit's title-href quirk
      author: (authorLink.text().trim() || '').replace(/^u\//, '') || null,
      score: parseInt((scoreEl.text() || '0').trim(), 10) || 0,
      numComments: parseInt((commentsLink.text() || '0').trim(), 10) || 0,
      createdUtc: null, // Redlib gives relative time as text, not a machine timestamp — see relTime below
      relTime: createdSpan.text().trim() || null, // e.g. "3 hours ago"
      subreddit: (communityLink.text().trim() || '').replace(/^r\//, ''),
    });
  });
  return results;
}

async function searchReddit(query, { subreddit, sort = 'relevance', limit = 25, timeRange = '' } = {}) {
  if (!redlibEnabled()) throw new Error('REDLIB_URL is not configured');
  const base = subreddit ? `${REDLIB_URL}/r/${encodeURIComponent(subreddit)}` : REDLIB_URL;
  let url = `${base}/search?q=${encodeURIComponent(query)}&sort=${sort}&restrict_sr=${subreddit ? 'on' : 'off'}`;
  if (timeRange) url += `&t=${encodeURIComponent(timeRange)}`;

  const allResults = [];
  let nextUrl = url;
  let pageCount = 0;
  const MAX_PAGES = 10;

  while (nextUrl && allResults.length < limit && pageCount < MAX_PAGES) {
    const html = await fetchHtml(nextUrl);
    const $ = cheerio.load(html);
    const pageResults = parseRedlibSearchResults($, Infinity);
    if (!pageResults.length) break;
    for (const r of pageResults) allResults.push(r);

    // Redlib's own pagination uses ?after=<cursor> in the NEXT link.
    const nextHref = $("footer a[href*='after=']").first().attr('href');
    if (!nextHref) break;
    const resolvedNext = nextHref.startsWith('http') ? nextHref : `${base}/search${nextHref.startsWith('?') ? nextHref : '?' + nextHref}`;
    if (resolvedNext === nextUrl) break;
    nextUrl = resolvedNext;
    pageCount++;
  }

  // Keep permalink as a bare path (e.g. "/r/mit/comments/xxx/slug/"), not prefixed with the
  // Redlib domain — Redlib mirrors Reddit's own permalink structure exactly, so this stays
  // consistent with what old.reddit.com results already look like elsewhere in this app
  // (routes.js prefixes bare paths with https://reddit.com itself).
  return allResults.slice(0, limit).map((r) => ({
    ...r,
    permalink: r.permalink.startsWith('http') ? new URL(r.permalink).pathname : r.permalink,
  }));
}

function parseOneRedlibComment($, $c) {
  const author = ($c.find('> details > summary a.comment_author, > details > summary span.comment_author').first().text().trim() || '').replace(/^u\//, '');
  const scoreText = $c.find('> div.comment_left p.comment_score').first().text().trim();
  const body = $c.find('> details div.comment_body').first().text().trim();
  const replyContainer = $c.find('> details > blockquote.replies').first();
  return {
    id: $c.attr('id'),
    author: author || null,
    score: parseInt(scoreText, 10) || 0,
    body,
    replies: replyContainer.length ? parseRedlibComments($, replyContainer) : [],
  };
}

function parseRedlibComments($, container) {
  const comments = [];
  container.children('div.comment').each((_, el) => {
    comments.push(parseOneRedlibComment($, $(el)));
  });
  return comments;
}

async function fetchPost(permalinkOrUrl) {
  if (!redlibEnabled()) throw new Error('REDLIB_URL is not configured');
  const url = permalinkOrUrl.startsWith('http') && permalinkOrUrl.includes(REDLIB_URL)
    ? permalinkOrUrl
    : `${REDLIB_URL}${permalinkOrUrl.startsWith('http') ? new URL(permalinkOrUrl).pathname : permalinkOrUrl}`;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const postEl = $('div.post.highlighted').first();

  const post = {
    id: postEl.attr('id'),
    title: postEl.find('h1.post_title').first().clone().children('small,a.post_flair').remove().end().text().trim(),
    author: (postEl.find('a.post_author').first().text().trim() || '').replace(/^u\//, ''),
    score: parseInt(postEl.find('div.post_score').first().text().trim(), 10) || 0,
    selftext: postEl.find('div.post_body').first().text().trim(),
    subreddit: (postEl.find('a.post_subreddit').first().text().trim() || '').replace(/^r\//, ''),
    permalink: url,
  };

  // Each top-level comment is wrapped in its own <div class="thread"> per Redlib's post.html.
  post.comments = [];
  $('div.thread > div.comment').each((_, el) => {
    post.comments.push(parseOneRedlibComment($, $(el)));
  });

  return post;
}

// True if a URL points at this Redlib instance — mirrors reddit-scrape.js's isRedditUrl(),
// used the same way by routes.js.
function isRedlibUrl(url) {
  return redlibEnabled() && typeof url === 'string' && url.startsWith(REDLIB_URL);
}

module.exports = { redlibEnabled, searchReddit, fetchPost, isRedlibUrl, REDLIB_URL };
