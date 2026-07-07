// Storage for saved keyword sets / query strings. Persists to your GitHub repo via githubStore
// (survives Render restarts) when GITHUB_TOKEN/GITHUB_REPO are configured; otherwise falls back
// to a local file — which works fine for local dev, but will NOT persist across Render restarts
// on the free tier, since that filesystem is ephemeral.
const fs = require('fs');
const path = require('path');
const githubStore = require('./githubStore');

const LOCAL_FILE = path.join(__dirname, '..', 'data', 'keywords.json');
const REMOTE_PATH = 'data/keywords.json';

function loadLocal() {
  try { return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); } catch (e) { return []; }
}
function saveLocal(list) {
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(list, null, 2));
}

async function list() {
  if (githubStore.configured()) {
    const { data } = await githubStore.readJson(REMOTE_PATH, []);
    return [...data].sort((a, b) => b.createdAt - a.createdAt);
  }
  return loadLocal().sort((a, b) => b.createdAt - a.createdAt);
}

async function add(label, query) {
  if (!query || !query.trim()) throw new Error('query is required');
  const item = {
    id: 'kw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    label: (label && label.trim()) || query.trim().slice(0, 40),
    query: query.trim(),
    createdAt: Date.now(),
  };

  if (githubStore.configured()) {
    const { data, sha } = await githubStore.readJson(REMOTE_PATH, []);
    data.push(item);
    await githubStore.writeJson(REMOTE_PATH, data, sha, `Save keyword: ${item.label}`);
    return item;
  }

  const items = loadLocal();
  items.push(item);
  saveLocal(items);
  return item;
}

async function remove(id) {
  if (githubStore.configured()) {
    const { data, sha } = await githubStore.readJson(REMOTE_PATH, []);
    const next = data.filter(i => i.id !== id);
    if (next.length === data.length) return false;
    await githubStore.writeJson(REMOTE_PATH, next, sha, `Remove saved keyword: ${id}`);
    return true;
  }

  const items = loadLocal();
  const next = items.filter(i => i.id !== id);
  saveLocal(next);
  return next.length !== items.length;
}

module.exports = { list, add, remove };
