// Simple file-based storage for saved keyword sets / query strings.
// Shared across whoever uses this backend (fits the 2-3 person use case) — no DB needed.
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'keywords.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return []; }
}
function save(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function list() {
  return load().sort((a, b) => b.createdAt - a.createdAt);
}

function add(label, query) {
  if (!query || !query.trim()) throw new Error('query is required');
  const items = load();
  const item = {
    id: 'kw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    label: (label && label.trim()) || query.trim().slice(0, 40),
    query: query.trim(),
    createdAt: Date.now(),
  };
  items.push(item);
  save(items);
  return item;
}

function remove(id) {
  const items = load();
  const next = items.filter(i => i.id !== id);
  save(next);
  return next.length !== items.length;
}

module.exports = { list, add, remove };
