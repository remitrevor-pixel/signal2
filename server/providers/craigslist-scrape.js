// Craigslist provider — two parts:
//
// 1. searchCraigslist() uses Craigslist's own published RSS feeds (&format=rss) for search
//    results. This is a real, documented, sanctioned feature — not HTML scraping — which is
//    exactly why it can't "leak" sidebar/nav content the way scraping a results page could:
//    an RSS <item> only ever contains that listing's own title/link/description/date, by
//    construction. Ported from a similar approach in the "redditintel" project.
//
// 2. fetchPosting() fetches a single posting's page and scopes extraction to the posting's own
//    known-stable containers (#titletextonly, section#postingbody, .attrgroup, the ISO
//    <time datetime> attribute) instead of stripping the whole page, which would otherwise pull
//    in "also see" related-postings, category nav, and footer boilerplate along with the actual
//    ad text — the same class of bug that was fixed for Reddit's expand.
const cheerio = require('cheerio');
const scrapedo = require('./scrapedo-multi');

const USER_AGENT = 'signal-research-console/1.0 (contact: you@example.com)';
const MIN_REQUEST_GAP_MS = 1500;
const CACHE_TTL_MS = 60 * 1000;

let lastRequestAt = 0;
let queue = Promise.resolve();
const cache = new Map();

async function fetchCraigslistUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return await res.text();
    if (res.status !== 403 && res.status !== 429) {
      throw new Error(`Craigslist request failed: ${res.status}`);
    }
    // 403/429 — Craigslist blocks known cloud/datacenter IP ranges the same way Reddit does.
  } catch (directErr) {
    // Network-level failure — also try the proxy fallback below.
  }

  try {
    const proxied = await scrapedo.fetchRaw(url, { render: false });
    return proxied.html;
  } catch (proxyErr) {
    throw new Error(`Craigslist blocked this request and the Scrape.do fallback also failed: ${proxyErr.message}`);
  }
}

function throttledFetch(url) {
  queue = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fetchCraigslistUrl(url);
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

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Search — via official RSS feed, per city/category
// ---------------------------------------------------------------------------

// Categories where research-study/survey/focus-group ads most commonly get posted:
//   etc = Jobs > Et Cetera (the single most common spot for these ads)
//   ggg = Gigs             (also very common)
const DEFAULT_CATEGORIES = ['etc', 'ggg'];

async function searchOneCityCategory(city, category, query, limit) {
  const url = `https://${city}.craigslist.org/search/${encodeURIComponent(category)}?query=${encodeURIComponent(query)}&format=rss`;
  const html = await cachedFetch(url);
  const $ = cheerio.load(html, { xmlMode: true });

  const items = [];
  $('item').each((_, el) => {
    if (items.length >= limit) return;
    const $el = $(el);
    const pubDateStr = $el.find('pubDate').first().text().trim();
    const parsedDate = pubDateStr ? new Date(pubDateStr) : null;
    items.push({
      title: $el.find('title').first().text().trim(),
      link: $el.find('link').first().text().trim(),
      description: stripHtml($el.find('description').first().text()),
      createdUtc: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.getTime() / 1000 : null,
      city,
      category,
    });
  });
  return items;
}

// cities: array of Craigslist subdomains, e.g. ["newyork", "sfbay"]
// categories: array of Craigslist category codes, defaults to the two above
async function searchCraigslist(cities, query, { categories = DEFAULT_CATEGORIES, limit = 25 } = {}) {
  const all = [];
  for (const city of cities) {
    for (const category of categories) {
      try {
        const results = await searchOneCityCategory(city, category, query, limit);
        all.push(...results);
      } catch (err) {
        // One bad city/category combo shouldn't kill the whole search — skip it and continue.
        console.error(`[Craigslist] ${city}/${category} failed:`, err.message);
      }
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Individual posting — scoped extraction, not whole-page stripping
// ---------------------------------------------------------------------------

async function fetchPosting(url) {
  const html = await cachedFetch(url);
  const $ = cheerio.load(html);

  const title = $('#titletextonly').first().text().trim();
  const price = $('.postingtitletext .price').first().text().trim() || null;
  const locationRaw = $('.postingtitletext small').first().text().trim();
  const location = locationRaw ? locationRaw.replace(/^[\s(]+|[\s)]+$/g, '') : null;

  // The ISO datetime attribute is the real, reliable timestamp — no relative-string guessing.
  const postedIso = $('time.timeago').first().attr('datetime') || null;

  const attrs = [];
  $('.attrgroup span').each((_, el) => {
    const t = $(el).text().trim();
    if (t) attrs.push(t);
  });

  // #postingbody holds the actual ad text, but Craigslist also nests an unrelated
  // "QR Code Link to This Post" print widget inside that same section — strip it out before
  // reading the text, or it pollutes the start/end of every single posting's body.
  const bodyEl = $('section#postingbody, #postingbody').first().clone();
  bodyEl.find('.print-information, .print-qrcode-container').remove();
  const body = bodyEl.text().replace(/QR Code Link to This Post/gi, '').replace(/\s+/g, ' ').trim();

  return { title, price, location, postedIso, attrs, body, url };
}

function isCraigslistUrl(url) {
  return /^https?:\/\/[a-z0-9-]+\.craigslist\.org\//i.test(url);
}

module.exports = { searchCraigslist, fetchPosting, isCraigslistUrl };
