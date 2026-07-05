// Boolean query parser shared logic.
// Supports: AND, OR, parentheses, +must / MUST INCLUDE(word), -ignore / IGNORE(word)
// Implicit AND between adjacent bare words (e.g. "focus group" -> focus AND group)

function extractMustIgnore(raw) {
  let text = raw || '';
  const must = [];
  const ignore = [];

  text = text.replace(/must\s+include\s*\(([^)]+)\)/gi, (m, g) => { must.push(g.trim().toLowerCase()); return ' '; });
  text = text.replace(/ignore\s*\(([^)]+)\)/gi, (m, g) => { ignore.push(g.trim().toLowerCase()); return ' '; });
  text = text.replace(/(^|\s)\+([a-zA-Z0-9_-]+)/g, (m, pre, g) => { must.push(g.trim().toLowerCase()); return ' '; });
  text = text.replace(/(^|\s)-([a-zA-Z0-9_-]+)/g, (m, pre, g) => { ignore.push(g.trim().toLowerCase()); return ' '; });

  return { core: text.trim(), must, ignore };
}

function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push(c); i++; continue; }
    let j = i;
    while (j < str.length && !/\s|\(|\)/.test(str[j])) j++;
    tokens.push(str.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseExpr(tokens, pos) {
  let [left, p1] = parseTerm(tokens, pos);
  pos = p1;
  while (pos < tokens.length && tokens[pos] && tokens[pos].toUpperCase() === 'OR') {
    pos++;
    let [right, p2] = parseTerm(tokens, pos);
    left = { op: 'OR', left, right };
    pos = p2;
  }
  return [left, pos];
}

function parseTerm(tokens, pos) {
  let [left, p1] = parseFactor(tokens, pos);
  pos = p1;
  while (pos < tokens.length && tokens[pos] !== ')' && tokens[pos].toUpperCase() !== 'OR') {
    if (tokens[pos].toUpperCase() === 'AND') pos++;
    if (pos >= tokens.length || tokens[pos] === ')') break;
    let [right, p2] = parseFactor(tokens, pos);
    left = { op: 'AND', left, right };
    pos = p2;
  }
  return [left, pos];
}

function parseFactor(tokens, pos) {
  if (tokens[pos] === '(') {
    let [e, p1] = parseExpr(tokens, pos + 1);
    if (tokens[p1] === ')') p1++;
    return [e, p1];
  }
  const val = (tokens[pos] || '').toLowerCase();
  return [{ op: 'WORD', value: val }, pos + 1];
}

function parseCore(coreStr) {
  if (!coreStr.trim()) return null;
  const tokens = tokenize(coreStr);
  if (tokens.length === 0) return null;
  const [tree] = parseExpr(tokens, 0);
  return tree;
}

function evalNode(node, textLower) {
  if (!node) return true;
  if (node.op === 'WORD') return node.value ? textLower.includes(node.value) : true;
  if (node.op === 'AND') return evalNode(node.left, textLower) && evalNode(node.right, textLower);
  if (node.op === 'OR') return evalNode(node.left, textLower) || evalNode(node.right, textLower);
  return true;
}

function collectWords(node, arr) {
  if (!node) return arr;
  if (node.op === 'WORD') { if (node.value) arr.push(node.value); return arr; }
  collectWords(node.left, arr);
  collectWords(node.right, arr);
  return arr;
}

// Full parse: returns {tree, must, ignore, positiveWords}
function parseQuery(raw) {
  const { core, must, ignore } = extractMustIgnore(raw);
  let tree = null;
  try { tree = parseCore(core); } catch (e) { tree = null; }
  const coreWords = [...new Set(collectWords(tree, []))];
  const positiveWords = [...new Set([...coreWords, ...must])];
  return { tree, must, ignore, coreWords, positiveWords };
}

// Does a piece of text satisfy the full parsed query (core AND/OR tree, must terms, ignore terms)?
function matchesQuery(parsed, text) {
  const t = (text || '').toLowerCase();
  const mustOk = parsed.must.every(m => t.includes(m));
  const ignoreOk = parsed.ignore.every(g => !t.includes(g));
  const coreOk = parsed.tree ? evalNode(parsed.tree, t) : true;
  return mustOk && ignoreOk && coreOk;
}

// Build a best-effort search string for external platforms / Google-style queries
function toSearchString(parsed) {
  const parts = [];
  function walk(node) {
    if (!node) return;
    if (node.op === 'WORD') { if (node.value) parts.push(node.value); return; }
    walk(node.left); walk(node.right);
  }
  walk(parsed.tree);
  parsed.must.forEach(m => parts.push(`"${m}"`));
  parsed.ignore.forEach(g => parts.push(`-${g}`));
  return parts.join(' ');
}

module.exports = { parseQuery, matchesQuery, toSearchString, evalNode, collectWords };
