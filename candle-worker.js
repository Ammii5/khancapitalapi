const https = require('https');

const FIREBASE_HOST = 'tools-1feac-default-rtdb.firebaseio.com';
const PRIMARY_BASE = 'https://mrbeaxt.com/Qxapi/qx.php';
const FALLBACK_BASE = 'https://qxcandledata.beaxtapi.online/api/v1/status';
const FALLBACK_TICK_BASE = 'https://qxcandledata.beaxtapi.online/api/v1/tick';
const PAIRS = (process.env.CANDLE_PAIRS || 'EURUSD,GBPUSD,USDJPY,USDARS_otc').split(',').map(p => p.trim()).filter(Boolean);
const POLL_MS = Number(process.env.CANDLE_POLL_MS || 10000);
const RETENTION_MS = 60 * 60 * 1000;
const once = process.argv.includes('--once');
const dryRun = process.argv.includes('--dry-run');
const forming = new Map();

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`HTTP ${response.statusCode} from ${url}`));
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('Request timeout')));
    request.on('error', reject);
  });
}

function putJson(path, value) {
  if (dryRun) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const request = https.request({
      hostname: FIREBASE_HOST,
      path: `${path}.json`,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      let output = '';
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`Firebase HTTP ${response.statusCode}: ${output}`));
        }
        resolve();
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function getJsonPath(path) {
  return getJson(`https://${FIREBASE_HOST}${path}.json`);
}

function deleteJson(path) {
  if (dryRun) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: FIREBASE_HOST, path: `${path}.json`, method: 'DELETE' }, response => {
      let output = '';
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Firebase delete HTTP ${response.statusCode}: ${output}`));
        resolve();
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function normalizeCandles(payload) {
  const source = Array.isArray(payload)
    ? payload
    : payload?.forming
      ? [payload.forming]
      : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.candles) ? payload.candles : [];
  return source.map(candle => ({
    epoch: Number(candle.epoch ?? candle.time),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    colour: candle.colour || candle.color || null,
    payout: candle.payout ?? payload?.payout ?? null,
  })).filter(candle => Number.isFinite(candle.epoch) && Number.isFinite(candle.close));
}

async function fetchPairCandles(pair) {
  const query = `pair=${encodeURIComponent(pair)}&timeframe=M1&count=65`;
  try {
    const primary = await getJson(`${PRIMARY_BASE}?${query}`);
    if (primary?.success === false) throw new Error(primary.error || 'Primary candle API returned no data');
    const candles = normalizeCandles(primary);
    if (!candles.length) throw new Error('Primary candle API returned an empty payload');
    return candles;
  } catch (primaryError) {
    const [status, tick] = await Promise.all([
      getJson(`${FALLBACK_BASE}?pair=${encodeURIComponent(pair)}`),
      getJson(`${FALLBACK_TICK_BASE}?pair=${encodeURIComponent(pair)}`),
    ]);
    const price = Number(tick?.data?.price ?? tick?.price ?? tick?.close);
    if (!Number.isFinite(price) || !status?.last_candle) return [];
    const epoch = Math.floor(Date.parse(`${status.last_candle.replace(' ', 'T')}+06:00`) / 1000);
    if (!Number.isFinite(epoch)) return [];
    const previous = forming.get(pair);
    const candle = previous && previous.epoch === epoch
      ? { ...previous, high: Math.max(previous.high, price), low: Math.min(previous.low, price), close: price, payout: status.payout ?? null }
      : { epoch, open: price, high: price, low: price, close: price, colour: null, payout: status.payout ?? null };
    forming.set(pair, candle);
    return [candle];
  }
}

async function syncPair(pair) {
  const candles = await fetchPairCandles(pair);
  if (!candles.length) return console.log(`[${new Date().toISOString()}] ${pair}: no candle data`);
  await Promise.all(candles.map(candle => putJson(`/serverCandles/${encodeURIComponent(pair)}/${candle.epoch}`, candle)));

  const stored = await getJsonPath(`/serverCandles/${encodeURIComponent(pair)}`);
  const epochs = Object.keys(stored || {}).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  const stale = epochs.slice(60);
  await Promise.all(stale.map(epoch => deleteJson(`/serverCandles/${encodeURIComponent(pair)}/${epoch}`)));
  console.log(`[${new Date().toISOString()}] ${pair}: kept ${Math.min(epochs.length, 60)} candles, removed ${stale.length}${dryRun ? ' (dry-run)' : ''}`);
}

async function syncAll() {
  const results = await Promise.allSettled(PAIRS.map(syncPair));
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.error(`${PAIRS[index]} failed: ${result.reason.message}`);
  });
}

syncAll().then(() => {
  if (!once) setInterval(syncAll, POLL_MS);
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
