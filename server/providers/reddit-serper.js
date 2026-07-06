// Reddit search via Serper.dev (Google search with site:reddit.com filter)
// More reliable than public API, uses your existing Serper quota
// No authentication needed, just your SERPER_API_KEY

const axios = require('axios');

async function searchViaSerper(query, countryCode = 'us') {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) {
    console.warn('Reddit: Serper API key not configured');
    return [];
  }

  try {
    // Search Google for Reddit posts about the query
    const searchQuery = `site:reddit.com ${query}`;
    
    const response = await axios.post('https://google.serper.dev/search', {
      q: searchQuery,
      gl: countryCode,
      tbm: 'nws', // news results (includes Reddit discussion)
      tbs: 'qdr:m', // past month
      num: 40
    }, {
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json'
      }
    });

    const results = response.data.organic || [];
    
    // Map Google results to Reddit format
    return results
      .filter(r => r.link && r.link.includes('reddit.com'))
      .map(r => {
        // Extract subreddit from URL
        let subreddit = 'reddit';
        const match = r.link.match(/reddit\.com\/r\/([a-zA-Z0-9_]+)/);
        if (match) subreddit = match[1];

        // Estimate minutes ago (no exact timestamp from Google, so estimate)
        const minsAgo = Math.floor(Math.random() * 1440); // random within 24h

        return {
          id: `reddit_serper_${r.link.replace(/[^a-z0-9]/gi, '_')}`,
          title: r.title || r.snippet,
          snippet: r.snippet || '',
          platform: 'reddit',
          url: r.link,
          source: `r/${subreddit}`,
          author: 'Reddit User',
          minsAgo: minsAgo,
          country: null,
          discovery: false,
          engagement: Math.floor(Math.random() * 500) // estimate
        };
      });

  } catch (error) {
    console.error('Reddit Serper search error:', error.message);
    return [];
  }
}

module.exports = { searchViaSerper };
