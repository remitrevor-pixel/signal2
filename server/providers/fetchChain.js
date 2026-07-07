// Tries on-demand full-page fetch providers in order of preference (lowest risk / best quality
// first), falling through to the next if one fails or is unconfigured. ProxyScrape and Bright
// Data only get reached if you've explicitly enabled them in .env.
const firecrawl = require('./firecrawl-multi');
const scrapedo = require('./scrapedo-multi');
const scrapingbot = require('./scrapingbot');
const brightdata = require('./brightdata');
const axios = require('axios');

async function fetchPage(url, countryCode) {
  const attempts = [];

  try {
    const r = await firecrawl.fetchClean(url, { countryCode });
    return { provider: 'firecrawl', text: r.markdown, title: r.title, fromCache: r.fromCache, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`firecrawl: ${e.message}`); }

  try {
    const r = await scrapedo.fetchRaw(url, { countryCode });
    return { provider: 'scrapedo', text: stripHtml(r.html), title: null, fromCache: false, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`scrapedo: ${e.message}`); }

  try {
    const r = await scrapingbot.fetchRaw(url, { countryCode });
    return { provider: 'scrapingbot', text: stripHtml(r.html), title: null, fromCache: false, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`scrapingbot: ${e.message}`); }

  try {
    const r = await brightdata.fetchViaUnlocker(url, { countryCode });
    return { provider: 'brightdata', text: stripHtml(r.html), title: null, fromCache: false, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`brightdata: ${e.message}`); }

  // FALLBACK: plain HTTP fetch, no proxy/render — works for a lot of public sites, but not for
  // ones that actively fingerprint bots or require a login (Facebook, LinkedIn, X), where every
  // provider above will also fail — that's a platform-side wall, not something any fetcher fixes.
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });

    if (response.status === 200) {
      return {
        provider: 'simple-http',
        text: stripHtml(response.data),
        title: null,
        fromCache: false,
        sourceUrl: url,
        countryCode: countryCode || null
      };
    }
    attempts.push(`simple-http: request returned ${response.status}`);
  } catch (e) { attempts.push(`simple-http: ${e.message}`); }

  const err = new Error('All fetch providers failed or are unconfigured: ' + attempts.join(' | '));
  err.attempts = attempts;
  throw err;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

module.exports = { fetchPage };
