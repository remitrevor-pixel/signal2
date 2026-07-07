// Persistent JSON storage backed by a file in your GitHub repo, via the GitHub Contents API.
//
// WHY THIS EXISTS: Render's free-tier filesystem is ephemeral — anything written to local disk
// (server/data/*.json) is wiped whenever the service restarts, which happens automatically after
// ~15 minutes of no traffic. That's why saved keywords / keyword bank kept disappearing — it
// wasn't a frontend bug, the backend's disk was genuinely being reset under it.
//
// Storing the same data as a real file in your GitHub repo instead means it survives restarts,
// redeploys, and shows up in your commit history. Falls back to local disk automatically if
// GITHUB_TOKEN / GITHUB_REPO aren't set, so nothing breaks for anyone who hasn't configured it.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "yourname/signal2"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

function configured() {
  return !!(GITHUB_TOKEN && GITHUB_REPO);
}

// Reads a JSON file from the repo. Returns { data, sha } — sha is null if the file doesn't
// exist yet (first write will create it) or GitHub storage isn't configured at all.
async function readJson(filePath, fallbackData) {
  if (!configured()) return { data: fallbackData, sha: null };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
    );
    if (res.status === 404) return { data: fallbackData, sha: null };
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
    const json = await res.json();
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    return { data: content.trim() ? JSON.parse(content) : fallbackData, sha: json.sha };
  } catch (e) {
    console.error(`[githubStore] read error for ${filePath}:`, e.message);
    return { data: fallbackData, sha: null };
  }
}

// Writes a JSON file to the repo (creates it if sha is null, updates it if sha is provided).
async function writeJson(filePath, data, sha, message) {
  if (!configured()) throw new Error('GitHub storage not configured (GITHUB_TOKEN / GITHUB_REPO)');
  const body = {
    message: message || `Update ${filePath}`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub write failed: ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
  }
  return res.json();
}

module.exports = { configured, readJson, writeJson };
