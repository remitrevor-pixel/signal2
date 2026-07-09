// Google Gemini API provider — powers the two AI assist features (interest email generator,
// screener question explainer). Supports multi-key rotation like serper-multi.js /
// firecrawl-multi.js: GEMINI_API_KEY or GEMINI_API_KEY_1 through GEMINI_API_KEY_10.
//
// Gemini has a genuinely free tier (no credit card required to start) and native image input,
// which is why it was picked over other options for this feature.
const KeyRotator = require('./keyRotator');
const quota = require('../quota');

const MODEL = 'gemini-2.0-flash';

function initGeminiKeys() {
  const keys = [];
  const singleKey = process.env.GEMINI_API_KEY;
  if (singleKey) keys.push(singleKey);
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key) keys.push(key);
  }
  if (keys.length === 0) {
    console.warn('⚠️ Gemini: No API keys configured (GEMINI_API_KEY or GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.)');
    return null;
  }
  console.log(`✓ Gemini: Loaded ${keys.length} API key(s)`);
  return new KeyRotator(keys);
}

const geminiRotator = initGeminiKeys();

// image: { base64, mimeType } or null. text: pasted/typed context, optional if image given.
// systemInstruction: scopes what the model is allowed to do for this specific feature.
async function generateContent({ systemInstruction, text, image }) {
  if (!geminiRotator || geminiRotator.getAllKeys().length === 0) {
    throw new Error('Gemini not configured (GEMINI_API_KEY or GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.)');
  }
  if (!text && !image) {
    throw new Error('Provide pasted text and/or an uploaded image');
  }

  const q1 = quota.check('gemini');
  if (!q1.allowed) {
    throw new Error(`Gemini monthly budget exhausted (${q1.used}/${q1.budget}).`);
  }

  const parts = [];
  if (text && text.trim()) parts.push({ text: text.trim() });
  if (image && image.base64) {
    parts.push({ inline_data: { mime_type: image.mimeType || 'image/jpeg', data: image.base64 } });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
  };

  let lastError;
  for (let attempt = 0; attempt < geminiRotator.getAllKeys().length; attempt++) {
    const apiKey = geminiRotator.getNext();
    if (!apiKey) break;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastError = new Error(`Gemini request failed: ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
        // 429 (rate limit) or 400/403 (bad/exhausted key) — try the next key
        geminiRotator.markFailed(apiKey);
        console.log(`[Gemini] Key ${apiKey.substring(0, 8)}... failed (${res.status}), trying next key...`);
        continue;
      }

      quota.increment('gemini', 1);
      const json = await res.json();
      const candidate = json.candidates && json.candidates[0];
      const outText = candidate && candidate.content && candidate.content.parts
        ? candidate.content.parts.map(p => p.text || '').join('\n')
        : '';
      if (!outText) throw new Error('Gemini returned an empty response (the image may be unreadable, or the content was filtered)');
      return outText;
    } catch (error) {
      lastError = error;
      console.error(`[Gemini] Error with key ${apiKey.substring(0, 8)}...:`, error.message);
    }
  }

  throw lastError || new Error('All Gemini keys exhausted or failed');
}

function getStats() {
  if (!geminiRotator) return { status: 'not configured' };
  return { provider: 'gemini', ...geminiRotator.getStats() };
}

module.exports = { generateContent, getStats };
