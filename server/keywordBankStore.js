// Simple file-based storage for the "Keyword Bank" — individual reusable keywords/phrases
// (e.g. "survey", "compensation", "+remote") that users tap to insert into the search bar,
// as opposed to keywordStore.js which saves whole ready-to-run query strings.
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'keyword-bank.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return []; }
}
function save(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function list() {
  return load().sort((a, b) => a.createdAt - b.createdAt);
}

function add(label, value) {
  if (!value || !value.trim()) throw new Error('value is required');
  const items = load();
  const item = {
    id: 'kwb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    label: (label && label.trim()) || value.trim(),
    value: value.trim(),
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
