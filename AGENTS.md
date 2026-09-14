# Khan Capital API

Express API proxy server for the Qx candle/trading data API.

## Architecture
- **server.js** — Express server on port 3000. Proxies candle/tick/status requests to upstream APIs (mrbeaxt.com, beaxtapi.online) and proxies CRUD to Firebase Realtime Database. No database or external secrets — all upstream URLs are hardcoded.
- **candle-worker.js** — 24/7 polling worker (compose service `candle-worker`) that fetches M1 candles every 10s and writes them to Firebase RTDB at `serverCandles/<pair>`, keeping the latest 60 per pair. Clients read instant chart data via `GET /api/db/serverCandles/<pair>`. Pairs configurable via `CANDLE_PAIRS` env var.

## Running
```
docker compose -f docker-compose.base44.yml up -d
```
- Node 22 base image, source bind-mounted, `npm install` + `node server.js` at startup.
- No live-reload dev server; restart the service after code changes: `docker compose -f docker-compose.base44.yml restart api`.
- Health check: `curl http://localhost:3000/` → JSON listing available endpoints.

## Endpoints
- `GET /api/time` — server UTC timestamp
- `GET /api/candles?pair=EURUSD&timeframe=M1&count=300` — candle data
- `GET /api/tick?pair=EURUSD` — current tick price
- `GET /api/status?pair=EURUSD` — market status/payout
- `GET/POST/PUT/PATCH/DELETE /api/db/*` — Firebase RTDB proxy
