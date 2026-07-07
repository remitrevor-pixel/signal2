// Storage for the "Keyword Bank" — individual reusable keywords/phrases (e.g. "survey",
// "compensation", "+remote") users tap to insert into the search bar. Persists to your GitHub
// repo via githubStore (survives Render restarts) when GITHUB_TOKEN/GITHUB_REPO are configured;
// otherwise falls back to a local file, which will NOT persist across Render restarts on the
// free tier since that filesystem is ephemeral.
const fs = require('fs');
const path = require('path');
const githubStore = require('./githubStore');

const LOCAL_FILE = path.join(__dirname, '..', 'data', 'keyword-bank.json');
const REMOTE_PATH = 'data/keyword-bank.json';

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
    return [...data].sort((a, b) => a.createdAt - b.createdAt);
  }
  return loadLocal().sort((a, b) => a.createdAt - b.createdAt);
}

async function add(label, value) {
  if (!value || !value.trim()) throw new Error('value is required');
  const item = {
    id: 'kwb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    label: (label && label.trim()) || value.trim(),
    value: value.trim(),
    createdAt: Date.now(),
  };

  if (githubStore.configured()) {
    const { data, sha } = await githubStore.readJson(REMOTE_PATH, []);
    data.push(item);
    await githubStore.writeJson(REMOTE_PATH, data, sha, `Add keyword bank entry: ${item.label}`);
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
    await githubStore.writeJson(REMOTE_PATH, next, sha, `Remove keyword bank entry: ${id}`);
    return true;
  }

  const items = loadLocal();
  const next = items.filter(i => i.id !== id);
  saveLocal(next);
  return next.length !== items.length;
}

module.exports = { list, add, remove };
