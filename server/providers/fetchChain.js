// Tries on-demand full-page fetch providers in order of preference (lowest risk / best quality
// first), falling through to the next if one fails or is unconfigured. ProxyScrape and Bright
// Data only get reached if you've explicitly enabled them in .env.
const firecrawl = require('./firecrawl');
const scraperapi = require('./scraperapi');
const scrapingbot = require('./scrapingbot');
const brightdata = require('./brightdata');

async function fetchPage(url, countryCode) {
  const attempts = [];

  try {
    const r = await firecrawl.fetchClean(url, { countryCode });
    return { provider: 'firecrawl', text: r.markdown, title: r.title, fromCache: r.fromCache, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`firecrawl: ${e.message}`); }

  try {
    const r = await scraperapi.fetchRaw(url, { countryCode });
    return { provider: 'scraperapi', text: stripHtml(r.html), title: null, fromCache: false, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`scraperapi: ${e.message}`); }

  try {
    const r = await scrapingbot.fetchRaw(url, { countryCode });
    return { provider: 'scrapingbot', text: stripHtml(r.html), title: null, fromCache: false, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`scrapingbot: ${e.message}`); }

  try {
    const r = await brightdata.fetchViaUnlocker(url, { countryCode });
    return { provider: 'brightdata', text: stripHtml(r.html), title: null, fromCache: false, sourceUrl: url, countryCode: countryCode || null };
  } catch (e) { attempts.push(`brightdata: ${e.message}`); }

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
