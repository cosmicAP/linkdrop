const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const config = require('./config');

const MAX_BODY_BYTES = 10_000;
const MAX_URL_LENGTH = 2_048;
const MAX_NOTE_LENGTH = 2_000;

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5,
  statement_timeout: 5_000,
  idleTimeoutMillis: 30_000,
});

// Without this listener a dropped idle connection crashes the process.
pool.on('error', (err) => {
  console.error('idle database client error', err);
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Only absolute http(s) URLs are allowed, so stored links can never be
// javascript:, data: or anything else that runs in the page.
function safeUrl(raw) {
  const value = (raw || '').trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href.length > MAX_URL_LENGTH ? null : url.href;
  } catch {
    return null;
  }
}

function render(links) {
  const items = links
    .map((l) => {
      const href = escapeHtml(l.url);
      const createdAt = l.created_at.toISOString();
      return `<li><a href="${href}">${href}</a><p>${escapeHtml(l.note)}</p><time datetime="${createdAt}">${createdAt}</time></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkdrop</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#0f172a}
  form{display:grid;gap:8px;margin-bottom:32px}
  input,textarea,button{font:inherit;padding:8px}
  label{font-size:13px;color:#475569}
  li{margin-bottom:16px}
  li p{margin:4px 0}
  time{color:#64748b;font-size:13px}
</style>
</head>
<body>
<h1>linkdrop</h1>
<form method="post" action="/links">
  <label for="url">Link</label>
  <input id="url" name="url" type="url" placeholder="https://..." maxlength="${MAX_URL_LENGTH}" required>
  <label for="note">Why it is worth reading</label>
  <textarea id="note" name="note" rows="2" maxlength="${MAX_NOTE_LENGTH}" placeholder="Optional note"></textarea>
  <button type="submit">Drop it</button>
</form>
<ol>
${items}
</ol>
</body>
</html>`;
}

async function listLinks() {
  const { rows } = await pool.query(
    'SELECT url, note, created_at FROM links ORDER BY created_at DESC, id DESC LIMIT $1',
    [config.pageSize],
  );
  return rows;
}

async function addLink(url, note) {
  await pool.query('INSERT INTO links (url, note) VALUES ($1, $2)', [url, note]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let settled = false;

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > MAX_BODY_BYTES) {
        settled = true;
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(new URLSearchParams(body));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// Browsers send Origin/Referer on form posts. Reject cross-site ones so third
// party pages cannot inject links. Non-browser clients without the headers
// (curl, health checks) are unaffected.
function isSameOrigin(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true;
  try {
    return new URL(source).host === req.headers.host;
  } catch {
    return false;
  }
}

function send(req, res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );

  try {
    // Parsing the pathname instead of comparing req.url means query strings
    // such as /?ref=hn no longer 404.
    const { pathname } = new URL(req.url, 'http://localhost');
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (isRead && pathname === '/healthz') {
      // Only report healthy when the database actually answers.
      await pool.query('SELECT 1');
      return send(req, res, 200, 'text/plain; charset=utf-8', 'ok');
    }

    if (isRead && pathname === '/') {
      const links = await listLinks();
      return send(req, res, 200, 'text/html; charset=utf-8', render(links), {
        'cache-control': 'no-store',
      });
    }

    if (req.method === 'POST' && pathname === '/links') {
      if (!isSameOrigin(req)) {
        return send(req, res, 403, 'text/plain; charset=utf-8', 'Cross-origin posts are not allowed.');
      }

      const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/x-www-form-urlencoded') {
        return send(req, res, 415, 'text/plain; charset=utf-8', 'Expected a form submission.');
      }

      const form = await readBody(req);
      const url = safeUrl(form.get('url'));
      const note = (form.get('note') || '').trim().slice(0, MAX_NOTE_LENGTH);

      if (!url) {
        return send(req, res, 400, 'text/plain; charset=utf-8', 'A link needs a valid http(s) URL.');
      }

      await addLink(url, note);
      res.writeHead(303, { location: '/' });
      return res.end();
    }

    return send(req, res, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // An oversized body is a client mistake, not a server error worth a stack trace.
    if (err.statusCode === 413) {
      return send(req, res, 413, 'text/plain; charset=utf-8', 'That submission is too large.');
    }
    console.error(err);
    return send(req, res, 500, 'text/plain; charset=utf-8', 'Something went wrong.');
  }
});

// Stop slow clients from holding a connection open indefinitely.
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

function describeDatabase(raw) {
  try {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function start() {
  console.log(`starting linkdrop on ${config.host}:${config.port}`);

  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set; the app will start but database calls will fail.');
  } else {
    console.log(`database target: ${describeDatabase(config.databaseUrl)}`);
    try {
      await ensureSchema();
      console.log('database schema ready');
    } catch (err) {
      console.error('Could not prepare the database schema:', err.message);
    }
  }

  server.on('error', (err) => {
    console.error('server error:', err.message);
  });

  server.listen(config.port, config.host, () => {
    console.log(`linkdrop listening on http://${config.host}:${config.port}`);
  });
}

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  server.close(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  if (server.closeIdleConnections) server.closeIdleConnections();

  // Do not let keep-alive connections hold the shutdown open forever.
  setTimeout(() => {
    if (server.closeAllConnections) server.closeAllConnections();
    process.exit(0);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
