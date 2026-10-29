# linkdrop

A tiny shared reading list. Paste a link, say why it is worth reading. Everyone with the address sees the 20 newest links, newest first.

One Node.js process and one PostgreSQL table. No framework, one dependency (`pg`).

## Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer

## Run it locally

```bash
npm install

cp .env.example .env        # then edit DATABASE_URL
set -a; . ./.env; set +a

psql "$DATABASE_URL" -f db/schema.sql   # optional: the app also creates the table on boot
npm start
```

The app listens on http://127.0.0.1:8080 by default. Open it and drop a link.

`set -a; . ./.env; set +a` is used instead of `export $(cat .env | xargs)` because the latter
breaks on passwords containing spaces, `&`, `#`, quotes or `*`. On Node 20.6+ you can also run
`node --env-file=.env server.js`.

## Configuration

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string, e.g. `postgresql://user:password@host:5432/linkdrop` |
| `HOST` | no | Interface to listen on. Defaults to `127.0.0.1`; set `0.0.0.0` in a container or PaaS. |
| `PORT` | no | Port to listen on. Defaults to `8080`; PaaS platforms usually inject this. |

The app reads configuration only from the environment. `.env` is gitignored; `.env.example` is
the template to copy.

## Health check

`GET /healthz` returns `200 ok` only when the process is up, the database answers `SELECT 1`,
**and** the `links` table exists. It returns `503` (with `Retry-After`) otherwise, so a load
balancer stops routing traffic to an instance that cannot serve.

## Tests

```bash
npm test
```

The suite starts a throwaway PostgreSQL cluster (`initdb` + `postgres`, trust auth, random
port, temp directory), boots the app as a real child process, and drives it over HTTP. Nothing
is mocked and no external service is required.

Requirements: PostgreSQL 14+ server binaries (`initdb`, `postgres`). They are looked up on
`PATH`, then under `/usr/lib/postgresql/*/bin`. To use an existing disposable database instead:

```bash
TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/linkdrop_test npm test
```

The suite truncates `links` before each case — never point `TEST_DATABASE_URL` at real data.

## Deploying

The app is stateless and has no build step, so any Node host works. It needs:

1. A PostgreSQL database and a `DATABASE_URL` pointing at it.
2. `HOST=0.0.0.0` so the port is reachable from outside the container.
3. The platform's injected `PORT` — the app already honours it.
4. The `links` table — created automatically on boot from `db/schema.sql` (idempotent).

### selfhost.dev

1. Create a Project (smallest cost-optimized server is fine).
2. Add a PostgreSQL service to the project and note its connection details.
3. Add the GitHub repo as an app, enable auto-deploy, use the Nixpacks build pack.
4. In the app's Variables tab set `DATABASE_URL` (from step 2) and `HOST=0.0.0.0`.
5. Make the app port and the platform port agree, or you will get `502`/`503` from the proxy
   while the container itself looks healthy. Nixpacks exposes `3000` for Node, so either set
   `PORT=3000` or set the app's port to `8080`.
6. Deploy, then check `/healthz` and post a link.

Two things that are easy to get wrong:

- **`DATABASE_URL` must use the database container's internal hostname**, not `localhost`.
  A project database is a separate container; `localhost:5432` refers to the app container.
  The hostname appears in the database container logs (`== /<hostname> ==`).
- Environment changes restart the container, but the proxy only picks up a changed port after
  the next deploy.

Custom domains and TLS are handled by the platform. Stop the project when you are done testing;
billing is per hour.
