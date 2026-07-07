// Tries on-demand full-page fetch providers in order of preference (lowest risk / best quality
// first), falling through to the next if one fails or is unconfigured. ProxyScrape and Bright
// Data only get reached if you've explicitly enabled them in .env.
const firecrawl = require('./firecrawl-multi');
const scraperapi = require('./scraperapi');
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

  // FALLBACK: Try simple HTTP fetch as last resort
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      maxRedirects: 5
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
