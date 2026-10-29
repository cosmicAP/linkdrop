'use strict';

// Behavioural tests: every case talks to the real server process over HTTP,
// backed by a real PostgreSQL instance. No pool stubs, no mocked routes.

const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { startDatabase, startApp, request } = require('./helpers');

let db;
let dbClient;
let app;

function postForm(fields, headers = {}) {
  return request(`${app.url}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: fields === null ? '' : new URLSearchParams(fields).toString(),
  });
}

function countLinks(html) {
  return (html.match(/<li>/g) || []).length;
}

before(async () => {
  db = await startDatabase();
  dbClient = new Client({ connectionString: db.url });
  await dbClient.connect();
  app = await startApp({ databaseUrl: db.url });
});

after(async () => {
  await app?.stop();
  await dbClient?.end();
  await db?.stop();
});

beforeEach(async () => {
  await dbClient.query('TRUNCATE links RESTART IDENTITY');
});

test('creates the links table on boot', async () => {
  const { rows } = await dbClient.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = 'links'",
  );
  assert.equal(rows.length, 1);
});

test('GET /healthz reports ok while the database answers', async () => {
  const res = await request(`${app.url}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.body, 'ok');
});

test('GET /healthz reports 503, not 500, when the database is unreachable', async () => {
  const broken = await startApp({ databaseUrl: 'postgresql://linkdrop@127.0.0.1:1/linkdrop' });
  try {
    const health = await request(`${broken.url}/healthz`);
    assert.equal(health.status, 503, 'a dependency outage is not an internal error');

    const home = await request(`${broken.url}/`);
    assert.equal(home.status, 500);
    assert.equal(home.body, 'Something went wrong.');
  } finally {
    await broken.stop();
  }
});

test('GET /healthz reports 503 when the schema could not be applied', async () => {
  await dbClient.query('CREATE ROLE restricted LOGIN');
  await dbClient.query('CREATE DATABASE linkdrop_locked');

  const admin = new Client({
    connectionString: db.url.replace(/\/linkdrop$/, '/linkdrop_locked'),
  });
  await admin.connect();
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await admin.end();

  const restricted = new URL(db.url);
  restricted.username = 'restricted';
  restricted.pathname = '/linkdrop_locked';

  const locked = await startApp({ databaseUrl: restricted.toString() });
  try {
    const health = await request(`${locked.url}/healthz`);
    assert.equal(health.status, 503, 'a database without the schema is not ready to serve');
    assert.match(locked.output, /Could not prepare the database schema/);
  } finally {
    await locked.stop();
    await dbClient.query('DROP DATABASE linkdrop_locked');
    await dbClient.query('DROP ROLE restricted');
  }
});

test('GET / renders the form and an empty list', async () => {
  const res = await request(`${app.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /<form method="post" action="\/links">/);
  assert.equal(countLinks(res.body), 0);
});

test('GET / ignores a query string instead of 404ing', async () => {
  const res = await request(`${app.url}/?ref=hn&utm_source=test`);
  assert.equal(res.status, 200);
});

test('POST /links stores a link and redirects back to the list', async () => {
  const res = await postForm({ url: 'https://example.com/article', note: 'worth it' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');

  const page = await request(`${app.url}/`);
  assert.match(page.body, /href="https:\/\/example\.com\/article"/);
  assert.match(page.body, /worth it/);

  const { rows } = await dbClient.query('SELECT url, note FROM links');
  assert.deepEqual(rows, [{ url: 'https://example.com/article', note: 'worth it' }]);
});

test('POST /links accepts a form content type with a charset', async () => {
  const res = await postForm(
    { url: 'https://example.com/charset' },
    { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  );
  assert.equal(res.status, 303);
});

test('POST /links rejects URLs that are not http or https', async () => {
  for (const url of [
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/file',
    '/relative/path',
    '   ',
  ]) {
    const res = await postForm({ url });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(url)}`);
  }
  const { rows } = await dbClient.query('SELECT count(*)::int AS n FROM links');
  assert.equal(rows[0].n, 0);
});

test('POST /links rejects URLs that embed credentials', async () => {
  for (const url of [
    'https://apple.com:secret@evil.example/',
    'https://user:pass@example.com/',
  ]) {
    const res = await postForm({ url });
    assert.equal(res.status, 400, `expected 400 for ${url}`);
  }
});

test('POST /links rejects a URL longer than 2048 characters', async () => {
  const res = await postForm({ url: `https://example.com/${'a'.repeat(2_100)}` });
  assert.equal(res.status, 400);
});

test('POST /links rejects cross-origin form posts', async () => {
  const viaOrigin = await postForm(
    { url: 'https://example.com/csrf' },
    { origin: 'https://evil.example' },
  );
  assert.equal(viaOrigin.status, 403);

  const viaReferer = await postForm(
    { url: 'https://example.com/csrf' },
    { referer: 'https://evil.example/page' },
  );
  assert.equal(viaReferer.status, 403);
});

test('POST /links rejects Sec-Fetch-Site: cross-site and same-site', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const res = await postForm(
      { url: 'https://example.com/fetch-metadata' },
      { 'sec-fetch-site': site, origin: 'https://evil.example' },
    );
    assert.equal(res.status, 403, `expected 403 for ${site}`);
  }
});

test('POST /links accepts Sec-Fetch-Site: same-origin even when Host is rewritten', async () => {
  const res = await postForm(
    { url: 'https://example.com/proxy-fetch-metadata' },
    {
      'sec-fetch-site': 'same-origin',
      origin: 'https://public.example',
      host: 'internal:8080',
    },
  );
  assert.equal(res.status, 303);
});

test('POST /links compares Origin with X-Forwarded-Host behind a proxy', async () => {
  const proxied = await postForm(
    { url: 'https://example.com/proxy-host' },
    {
      origin: 'https://public.example',
      host: 'internal:8080',
      'x-forwarded-host': 'public.example',
    },
  );
  assert.equal(proxied.status, 303);

  const unproxied = await postForm(
    { url: 'https://example.com/proxy-host-missing' },
    { origin: 'https://public.example', host: 'internal:8080' },
  );
  assert.equal(unproxied.status, 403, 'a proxy that does not forward the host is misconfigured');
});

test('POST /links tolerates an opaque Origin: null', async () => {
  const res = await postForm({ url: 'https://example.com/opaque' }, { origin: 'null' });
  assert.equal(res.status, 303);
});

test('POST /links requires a form content type', async () => {
  const res = await request(`${app.url}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/json' }),
  });
  assert.equal(res.status, 415);

  const missing = await request(`${app.url}/links`, {
    method: 'POST',
    body: 'url=https://example.com/no-type',
  });
  assert.equal(missing.status, 415);
});

test('POST /links answers 413 for a body over 10 KB instead of hanging', async () => {
  const res = await postForm({ url: 'https://example.com/big', note: 'x'.repeat(11_000) });
  assert.equal(res.status, 413);
  assert.equal(res.body, 'That submission is too large.');
});

test('POST /links escapes HTML in the note and the URL', async () => {
  const note = '<script>alert(1)</script>';
  const res = await postForm({ url: 'https://example.com/x?a=1&b=2', note });
  assert.equal(res.status, 303);

  const page = await request(`${app.url}/`);
  assert.ok(!page.body.includes('<script>alert(1)</script>'), 'raw script tag must not appear');
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page.body, /https:\/\/example\.com\/x\?a=1&amp;b=2/);
});

test('GET / keeps multi-byte characters intact', async () => {
  const note = 'café ☕ 日本語 — naïve';
  const res = await postForm({ url: 'https://example.com/unicode', note });
  assert.equal(res.status, 303);

  const page = await request(`${app.url}/`);
  assert.ok(page.body.includes(note), 'note should round-trip through the body reader');
});

test('GET / shows the newest 20 links, newest first', async () => {
  for (let i = 1; i <= 25; i += 1) {
    await dbClient.query(
      "INSERT INTO links (url, note, created_at) VALUES ($1, '', now() - ($2 || ' minutes')::interval)",
      [`https://example.com/${i}`, String(25 - i)],
    );
  }

  const page = await request(`${app.url}/`);
  assert.equal(countLinks(page.body), 20, 'page size is 20');

  const first = page.body.indexOf('https://example.com/25');
  const second = page.body.indexOf('https://example.com/24');
  const last = page.body.indexOf('https://example.com/6');
  assert.ok(first > -1 && second > -1 && last > -1);
  assert.ok(first < second && second < last, 'newest link must come first');
  assert.ok(!page.body.includes('href="https://example.com/1"'), 'oldest rows fall off the page');
});

test('GET / breaks created_at ties by id, newest first', async () => {
  for (const name of ['first', 'second', 'third']) {
    await dbClient.query("INSERT INTO links (url, created_at) VALUES ($1, '2026-01-01T00:00:00Z')", [
      `https://example.com/${name}`,
    ]);
  }

  const page = await request(`${app.url}/`);
  const positions = ['third', 'second', 'first'].map((name) => page.body.indexOf(name));
  assert.ok(positions.every((p) => p > -1));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
});

test('HEAD / returns headers and no body', async () => {
  const res = await request(`${app.url}/`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body, '');
});

test('unknown paths and unsupported methods return 404', async () => {
  const cases = [
    request(`${app.url}/nope`),
    request(`${app.url}/favicon.ico`),
    request(`${app.url}/links`),
    request(`${app.url}/links/`),
    request(`${app.url}/healthz`, { method: 'POST' }),
    request(`${app.url}/`, { method: 'DELETE' }),
  ];
  for (const res of await Promise.all(cases)) {
    assert.equal(res.status, 404);
    assert.equal(res.body, 'Not found');
  }
});

test('every response carries the security headers', async () => {
  for (const res of [
    await request(`${app.url}/`),
    await request(`${app.url}/healthz`),
    await request(`${app.url}/nope`),
  ]) {
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
});

test('links survive a restart of the process', async () => {
  await postForm({ url: 'https://example.com/persisted', note: 'still here' });

  await app.stop();
  app = await startApp({ databaseUrl: db.url });

  const page = await request(`${app.url}/`);
  assert.match(page.body, /https:\/\/example\.com\/persisted/);
  assert.match(page.body, /still here/);
});

test('the process exits non-zero when the port is already taken', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: db.url,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, 5_000);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  blocker.close();

  assert.notEqual(code, 'timeout', 'a process that cannot bind must not keep running');
  assert.notEqual(code, 0, 'a failed bind is not a clean exit');
});
