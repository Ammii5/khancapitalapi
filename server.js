// Khan Capital Management - API Proxy Server
// Proxies requests to the Qx candle API to avoid CORS issues.
// Run: npm install && npm start
// Then the Vite client (port 5173) proxies /api/* here (port 3000).

const express = require('express');
const path = require('path');
const https = require('https');

const RTDB_HOST = 'tools-1feac-default-rtdb.firebaseio.com';

const app = express();
const PORT = process.env.PORT || 3000;

const UPSTREAM_BASE = 'https://mrbeaxt.com/Qxapi/qx.php';
const UPSTREAM_TICK_BASE = 'https://mrbeaxt.com/Qxapi/qx_ticks.php';
const TRIM_CANDLES = 300;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 300;

function fetchWithRetry(url, retries, callback) {
  https.get(url, (upstreamRes) => {
    let body = '';
    upstreamRes.on('data', (chunk) => { body += chunk; });
    upstreamRes.on('end', () => {
      if (upstreamRes.statusCode === 503 && retries > 0) {
        setTimeout(() => fetchWithRetry(url, retries - 1, callback), RETRY_DELAY_MS);
      } else {
        callback(null, upstreamRes.statusCode, body);
      }
    });
  }).on('error', (err) => {
    if (retries > 0) {
      setTimeout(() => fetchWithRetry(url, retries - 1, callback), RETRY_DELAY_MS);
    } else {
      callback(err, 502, null);
    }
  });
}

// CORS headers so the Vite dev server can call this
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── FIREBASE RTDB PROXY ───────────────────────────────────────────────────
function rtdbRequest(method, rtdbPath, body, res) {
  const options = {
    hostname: RTDB_HOST,
    path: rtdbPath,
    method: method,
    headers: { 'Content-Type': 'application/json' },
  };
  const req2 = https.request(options, (r) => {
    let data = '';
    r.on('data', c => { data += c; });
    r.on('end', () => {
      res.status(r.statusCode).type('application/json').send(data);
    });
  });
  req2.on('error', (e) => res.status(502).json({ error: e.message }));
  if (body) req2.write(typeof body === 'string' ? body : JSON.stringify(body));
  req2.end();
}

// GET /api/db/*  → Firebase GET
app.get('/api/db/*', (req, res) => {
  const nodePath = req.params[0].replace(/\.json$/, '');
  // Build query string with proper encoding for Firebase (orderBy/equalTo need quoted strings)
  const parts = [];
  for (const [k, v] of Object.entries(req.query)) {
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  const qs = parts.length ? '?' + parts.join('&') : '';
  rtdbRequest('GET', '/' + nodePath + '.json' + qs, null, res);
});

// POST /api/db/*  → Firebase POST (push)
app.post('/api/db/*', (req, res) => {
  const nodePath = req.params[0].replace(/\.json$/, '');
  rtdbRequest('POST', '/' + nodePath + '.json', req.body, res);
});

// PUT /api/db/*  → Firebase PUT (set)
app.put('/api/db/*', (req, res) => {
  const nodePath = req.params[0].replace(/\.json$/, '');
  rtdbRequest('PUT', '/' + nodePath + '.json', req.body, res);
});

// PATCH /api/db/*  → Firebase PATCH (update)
app.patch('/api/db/*', (req, res) => {
  const nodePath = req.params[0].replace(/\.json$/, '');
  rtdbRequest('PATCH', '/' + nodePath + '.json', req.body, res);
});

// DELETE /api/db/*  → Firebase DELETE
app.delete('/api/db/*', (req, res) => {
  const nodePath = req.params[0].replace(/\.json$/, '');
  rtdbRequest('DELETE', '/' + nodePath + '.json', null, res);
});

// Serve React build (production)
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

// Serve admin panel at /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

// GET /api/candles?pair=EURUSD
app.get('/api/candles', (req, res) => {
  const pair = req.query.pair;
  if (!pair) return res.status(400).json({ success: false, error: 'Missing "pair" query param' });

  const url = `${UPSTREAM_BASE}?pair=${encodeURIComponent(pair)}`;
  fetchWithRetry(url, MAX_RETRIES, (err, status, body) => {
    if (err) return res.status(502).json({ success: false, error: 'Upstream request failed', detail: err.message });
    res.status(status || 200).type('application/json');
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json.data)) json.data = json.data.slice(0, TRIM_CANDLES);
      res.send(JSON.stringify(json));
    } catch (e) {
      res.send(body);
    }
  });
});

// GET /api/time — accurate server UTC time for candle boundary sync
app.get('/api/time', (req, res) => {
  res.json({ utc: Date.now() });
});

// GET /api/tick?pair=EURUSD or /api/tick?pair=EURUSD_otc
app.get('/api/tick', (req, res) => {
  const pair = req.query.pair;
  if (!pair) return res.status(400).json({ success: false, error: 'Missing "pair" query param' });

  // OTC pairs use the same tick endpoint with _otc suffix
  const url = `${UPSTREAM_TICK_BASE}?pair=${encodeURIComponent(pair)}`;
  fetchWithRetry(url, MAX_RETRIES, (err, status, body) => {
    if (err) return res.status(502).json({ success: false, error: 'Upstream request failed', detail: err.message });
    res.status(status || 200).type('application/json').send(body);
  });
});

// All other routes → React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Khan Capital API server running on http://localhost:${PORT}\n`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Try: set PORT=3001 && npm start\n`);
  } else {
    console.error('\n  Server failed to start:', err.message, '\n');
  }
  process.exit(1);
});
