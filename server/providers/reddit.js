// Reddit public search — uses the free /search.json endpoint with no authentication required
// Just like the analyzed project, we fetch directly from Reddit's public API
const REDDIT_SEARCH_URL = 'https://www.reddit.com/search.json';

async function searchPublic(query) {
  try {
    const url = new URL(REDDIT_SEARCH_URL);
    url.searchParams.append('q', query);
    url.searchParams.append('sort', 'new');
    url.searchParams.append('limit', '50');
    url.searchParams.append('restrict_sr', 'off');
    url.searchParams.append('type', 'link,self');

    // Add a User-Agent to avoid being blocked
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'signal-console/1.0 (research tool)'
      }
    });

    if (!response.ok) {
      console.error(`Reddit search failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return mapRedditToResults(data);
  } catch (error) {
    console.error('Reddit public search error:', error);
    return [];
  }
}

function mapRedditToResults(redditData) {
  const items = redditData?.data?.children || [];

  return items
    .map((item) => {
      const post = item?.data;
      if (!post || !post.title) return null;

      // Detect study type from title
      let studyType = 'research';
      const titleLower = post.title.toLowerCase();
      if (titleLower.includes('survey')) studyType = 'survey';
      else if (titleLower.includes('focus group')) studyType = 'focus_group';
      else if (titleLower.includes('study')) studyType = 'academic_study';
      else if (titleLower.includes('research')) studyType = 'research';

      // Detect compensation
      let compensation = 'Unknown';
      if (titleLower.includes('$') || titleLower.includes('paid')) {
        const match = post.title.match(/\$\d+/);
        compensation = match ? match[0] : 'Paid';
      }

      // Extract eligibility from title + selftext
      const fullText = (post.title + ' ' + (post.selftext || '')).toLowerCase();
      const eligibility = [];
      if (fullText.includes('18+') || fullText.includes('18 years')) eligibility.push('18+');
      if (fullText.includes('student')) eligibility.push('Student');
      if (fullText.includes('us only') || fullText.includes('united states')) eligibility.push('US Only');
      if (eligibility.length === 0) eligibility.push('Open');

      // Minutes ago
      const now = Math.floor(Date.now() / 1000);
      const minsAgo = Math.floor((now - post.created_utc) / 60);

      return {
        id: `reddit_${post.id}`,
        title: post.title,
        snippet: post.selftext ? post.selftext.substring(0, 250) : '(No description — check source)',
        platform: 'reddit',
        url: `https://www.reddit.com${post.permalink}`,
        source: `r/${post.subreddit}`,
        author: post.author || 'Deleted',
        minsAgo: minsAgo,
        country: null, // Reddit is global
        discovery: false, // This is direct API, not discovery
        studyType,
        compensation,
        eligibility,
        upvotes: post.ups || 0,
        comments: post.num_comments || 0,
        engagement: (post.ups || 0) + (post.num_comments || 0) * 2
      };
    })
    .filter((r) => r !== null);
}

module.exports = { searchPublic };
