const express = require('express');
const path = require('path');
const routes = require('./routes');

const app = express();

// CORS — the APK's WebView loads index.html from a different origin than the Render backend,
// so cross-origin fetch() calls need these headers or stricter WebViews will silently block them.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Higher limit than the 100kb default — needed for base64-encoded screener/flyer photos.
app.use(express.json({ limit: '15mb' }));
app.use('/api', routes);
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`SIGNAL console running at http://localhost:${PORT}`);
  console.log(`Quota summary: GET http://localhost:${PORT}/api/quota`);
});
