const express = require('express');
const path = require('path');
const routes = require('./routes');

const app = express();
app.use(express.json());
app.use('/api', routes);
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`SIGNAL console running at http://localhost:${PORT}`);
  console.log(`Quota summary: GET http://localhost:${PORT}/api/quota`);
});
