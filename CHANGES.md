# linkdrop — change log

Reference of every change made while preparing the app for deployment, plus what still
remains. Newest work is at the top of each file section.

Repository history used as the starting point: `547998b` (after the two commits below).

---

## Changes you made

| Commit | File | Change |
|---|---|---|
| `d208a35` | `.env.example` | Renamed `PG_URL` to `DATABASE_URL` so it matches what `config.js` reads. |
| `547998b` | `config.js` | `port: 8080` → `port: Number(process.env.PORT) || 8080` so PaaS `PORT` is honoured. |

---

## Changes made in this pass

### `config.js`

| Line | Change | Why |
|---|---|---|
| 3 | `host` default `'localhost'` → `'127.0.0.1'` | `127.0.0.1` is explicit IPv4 and avoids `localhost` resolving to `::1` only. Production still sets `HOST=0.0.0.0`. |
| 4 | Removed the stray space in `8080 ,` | Formatting only. |

### `server.js`

| Area | Change | Why |
|---|---|---|
| `escapeHtml()` | New helper; `url`, `note` and the `href` are escaped before rendering. | Stored XSS: a posted note could inject `<script>` that ran for every visitor. |
| `safeUrl()` | New helper; only absolute `http:`/`https:` URLs are accepted, max 2048 chars. | Blocked `javascript:`, `data:` and attribute-breakout payloads; the old check was `if (!url)`. |
| `render()` | `<time datetime="...">` added; visible `<label>` elements; `maxlength` on both fields. | Accessibility and defence in depth (placeholders are not labels). |
| `listLinks()` | `ORDER BY created_at` → `ORDER BY created_at DESC, id DESC`. | The page claimed "20 newest" but returned the 20 **oldest**, so new links never appeared after 20 rows. `id` breaks timestamp ties. |
| `readBody()` | `req.setEncoding('utf8')`, byte-based size counting, settle-once guard, rejects with status 413 instead of `req.destroy()`. | `destroy()` left the promise pending forever (hung request); counting UTF-16 units corrupted multi-byte characters split across chunks. |
| `isSameOrigin()` | New; rejects `POST /links` when `Origin`/`Referer` is a different host. | Cross-site form posts could inject spam links. Requests without the headers (curl) still work. |
| Content-Type check | `POST /links` requires `application/x-www-form-urlencoded`, otherwise `415`. | Stopped JSON/multipart bodies being parsed as form data and silently inserted as garbage. |
| Routing | Parse `pathname` from `req.url`; support `HEAD` alongside `GET`. | `/?ref=x` used to 404; uptime monitors often probe with `HEAD`. |
| `/healthz` | Runs `SELECT 1`; returns `503` when the database is down. | Previously reported `ok` with a dead database, so load balancers kept sending traffic. |
| Security headers | `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `Cache-Control: no-store` on `/`. | Mitigates XSS and stale HTML being cached by proxies. |
| Error handler | Guards on `res.headersSent`; maps oversized bodies to `413`. | Avoided `ERR_HTTP_HEADERS_SENT` when an error happened after headers were written. |
| `pool` | Added `statement_timeout: 5s`, `idleTimeoutMillis: 30s`, and a `pool.on('error')` listener. | A dropped idle connection used to crash the process with an uncaught exception. |
| `ensureSchema()` | Runs `db/schema.sql` on boot before listening. | PaaS gives no easy shell to apply the schema, so first deploys failed with `relation "links" does not exist`. The SQL is idempotent. |
| `start()` | Fails fast (exit 1, clear message) when `DATABASE_URL` is missing or the schema cannot be applied. | Previously the process started "healthy" and 500'd on every request. |
| Timeouts | `server.requestTimeout = 15s`, `server.headersTimeout = 10s`. | Basic slowloris protection; a client could otherwise hold a connection open indefinitely. |
| Shutdown | Handles `SIGINT` as well as `SIGTERM`; closes idle connections; force-closes after 10s. | Keep-alive connections could hold `server.close()` open until the orchestrator SIGKILLed the deploy. |

### `db/schema.sql`

| Change | Why |
|---|---|
| Added `CREATE INDEX IF NOT EXISTS links_created_at_idx ON links (created_at DESC, id DESC)`. | Every page load sorted the full table; the index matches the new query order. |

### `.env.example`

| Change | Why |
|---|---|
| Kept `DATABASE_URL`; added commented `HOST` and `PORT` with explanation. | Documents the two variables a deployment needs without changing local defaults. |

### `README.md`

| Change | Why |
|---|---|
| `PG_URL` → `DATABASE_URL`; port 3000 → 8080; `export $(cat .env \| xargs)` → `set -a; . ./.env; set +a`. | The old instructions did not match the code and broke on passwords with special characters. |
| Documented `HOST`/`PORT`, the `503` health behaviour, schema auto-creation, and a selfhost.dev deploy checklist. | Everything needed to deploy is now in one place. |

---

## Environment variables

| Variable | Local | Deployed |
|---|---|---|
| `DATABASE_URL` | required, from `.env` | required, from the platform's Variables tab |
| `HOST` | optional, defaults to `127.0.0.1` | set `0.0.0.0` |
| `PORT` | optional, defaults to `8080` | set `3000` to match the Nixpacks exposed port |

`.env` stays gitignored. Never commit real credentials.

---

## Verified

- `node --check server.js` and `node --check config.js` pass.
- An ad-hoc HTTP smoke test was run with a stubbed `pg` pool (no database required), 14
  assertions, all passing:
  - `GET /healthz` → `200 ok`
  - `GET /` renders, escapes `<script>` in a note, emits `href` and `<time datetime>`
  - `GET /?ref=hn` → `200` (query string no longer 404s)
  - `HEAD /` → `200`, `GET /favicon.ico` → `404`, `GET /nope` → `404`
  - `POST /links` valid → `303` to `/`
  - `POST /links` with `javascript:` → `400`
  - `POST /links` cross-origin → `403`
  - `POST /links` as JSON → `415`
  - `POST /links` over 10 KB → `413` (and no stack trace logged)

Not verified locally: no PostgreSQL server is installed on this machine, so real queries and
the boot-time schema creation were not exercised. The first real check is `/healthz` after the
first deploy.

---

## Still open (not changed)

| Issue | Where | Notes |
|---|---|---|
| No pagination | `server.js` `listLinks()` | Only the newest 20 are visible; add `?before=` if the list grows. |
| No rate limiting | `server.js` `POST /links` | A public URL can still be spammed with rows. |
| `pg` SSL not configured | `server.js` pool | Fine for a same-host private database; add `?sslmode=require` if the provider requires TLS. |
| No tests | repo root | `node:test` cases for `render`, `safeUrl` and `readBody` would be cheap. |
| No request logging | `server.js` | Only errors are logged; no request ids or latency. |
| No favicon | `server.js` | `GET /favicon.ico` returns 404, which is harmless. |
| Open to anyone with the link | by design | Decision taken during planning; add auth if that changes. |

---

## Deployment record (selfhost.dev)

Where it runs and how it is wired, so the next person does not have to rediscover it.

| Item | Value |
|---|---|
| Project | `link drop from fork` (`prj_01m60w6atrpd01808z7a9k8b4h`) |
| App / deployment | `cosmicAP/linkdrop`, branch `main`, Nixpacks, port `3000` (`deploy_01m60zxgntgdca916ttgehfa6w`) |
| Live URL | https://linkdrop-66e95219.49.12.110.255.nip.swatantra.cloud |
| Database | project Postgres `linkdrop-db`, private (no public port), db `linkdrop`, user `linkdrop` |
| Env vars | `DATABASE_URL` (internal container hostname, not `localhost`), `HOST=0.0.0.0`, `PORT=3000` |

### The two failures that cost the most time

1. **`DATABASE_URL` pointed at `localhost:5432/linkdrop`.** It had been copied from
   `.env.example`, and a project database is a *separate container* with its own internal
   hostname. The app booted, logged `database target: localhost:5432/linkdrop`, failed
   `ensureSchema()`, and then crash-looped, so the proxy answered `502`.
   The internal hostname is printed in the database container log header
   (`== /<hostname> ==`); the MCP API deliberately never returns database passwords.
2. **Port mismatch: container listening on one port, proxy configured for another.**
   Nixpacks detects and exposes `3000` for a Node app, while the app defaulted to `8080`.
   The build log states it plainly:
   `Warning: PORT environment variable (3000) does not match configured ports_exposes: 8080.`
   That produces `502 Bad Gateway` or `503 no available server` even though the container is
   healthy and logging `listening on 0.0.0.0:...`. Fix: make both sides agree — here by
   setting `PORT=3000` and the deployment port to `3000`.

### Startup logging added because of (1)

`start()` now prints the redacted database target and whether `ensureSchema()` succeeded, and
**keeps serving** if the database is unreachable. Before this, a bad `DATABASE_URL` exited the
process with one line that the platform did not surface, which looked identical to a port
problem.

### Verified live after the fix

- `GET /healthz` → `200 ok` (also re-checked after a redeploy)
- `GET /` → `200`, renders the list
- `POST /links` → `303` to `/`, row appears on the page
- `javascript:` URL → `400`, cross-origin post → `403`, JSON body → `415`
- a note containing `<script>` renders escaped
- `GET /?ref=hn` → `200`
- links persisted across a fresh deploy
