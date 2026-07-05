// Official Reddit API (OAuth, script-app credentials, free personal-use tier).
// Docs: https://www.reddit.com/dev/api
const { KEYS } = require('../config');

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5000) return tokenCache.token;
  const { clientId, clientSecret, userAgent } = KEYS.reddit;
  if (!clientId || !clientSecret) throw new Error('Reddit credentials not configured (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET)');

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in * 1000) };
  return tokenCache.token;
}

// searchString: plain keywords (Reddit's search doesn't support our full boolean grammar,
// so we send a loose OR-of-terms and let our own parser do the real AND/OR/MUST/IGNORE filtering
// against the returned post text afterward).
async function search(searchString, { limit = 25, sort = 'new' } = {}) {
  if (!searchString.trim()) return [];
  const token = await getToken();
  const { userAgent } = KEYS.reddit;
  const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(searchString)}&limit=${limit}&sort=${sort}&type=link`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': userAgent },
  });
  if (!res.ok) throw new Error(`Reddit search failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const posts = (json.data && json.data.children) || [];

  return posts.map(p => {
    const d = p.data;
    return {
      id: 'reddit_' + d.id,
      platform: 'reddit',
      title: d.title,
      body: d.selftext ? d.selftext.slice(0, 500) : '',
      source: 'r/' + d.subreddit,
      author: d.author,
      url: `https://www.reddit.com${d.permalink}`,
      createdUtc: d.created_utc, // seconds
      engagement: { upvotes: d.ups, comments: d.num_comments },
      raw: true, // this is genuine platform data, not simulated
    };
  });
}

module.exports = { search };
