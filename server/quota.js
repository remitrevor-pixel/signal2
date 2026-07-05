// Minimal file-based monthly usage tracker. No DB needed for a 2-3 person tool.
const fs = require('fs');
const path = require('path');
const { PROVIDER_BUDGETS } = require('./config');

const DATA_FILE = path.join(__dirname, '..', 'data', 'usage.json');

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Returns {allowed, used, budget, remaining}
function check(provider) {
  const data = load();
  const mk = monthKey();
  const used = (data[mk] && data[mk][provider]) || 0;
  const budget = PROVIDER_BUDGETS[provider] ?? Infinity;
  return { allowed: used < budget, used, budget, remaining: Math.max(0, budget - used) };
}

function increment(provider, by = 1) {
  const data = load();
  const mk = monthKey();
  if (!data[mk]) data[mk] = {};
  data[mk][provider] = (data[mk][provider] || 0) + by;
  save(data);
  return data[mk][provider];
}

function summary() {
  const data = load();
  const mk = monthKey();
  const usedThisMonth = data[mk] || {};
  const out = {};
  Object.keys(PROVIDER_BUDGETS).forEach(p => {
    const used = usedThisMonth[p] || 0;
    out[p] = { used, budget: PROVIDER_BUDGETS[p], remaining: Math.max(0, PROVIDER_BUDGETS[p] - used) };
  });
  return out;
}

module.exports = { check, increment, summary };
