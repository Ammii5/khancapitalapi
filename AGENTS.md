# Khan Capital API

Express API proxy server for the Qx candle/trading data API.

## Architecture
- **server.js** — Express server on port 3000. Proxies candle/tick/status requests to upstream APIs (mrbeaxt.com, beaxtapi.online) and proxies CRUD to Firebase Realtime Database. No database or external secrets — all upstream URLs are hardcoded.
- **candle-worker.js** — Standalone polling worker that fetches candle data and writes it to Firebase RTDB. Not run by default; run with `node candle-worker.js` if needed.

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
