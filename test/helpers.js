'use strict';

// Test infrastructure: a throwaway PostgreSQL cluster in the temp directory and
// the app spawned as a real child process, so tests hit the same entry point we
// deploy instead of a re-implementation of it.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const APP_DIR = path.join(__dirname, '..');
const PG_USER = 'linkdrop';
const PG_DB = 'linkdrop';

function pgBin(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {
    // fall through to the versioned install layout
  }
  const root = '/usr/lib/postgresql';
  if (fs.existsSync(root)) {
    for (const version of fs.readdirSync(root).sort().reverse()) {
      const candidate = path.join(root, version, 'bin', name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `\`${name}\` not found. Install PostgreSQL or set TEST_DATABASE_URL to a throwaway database.`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 100, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function startDatabase() {
  if (process.env.TEST_DATABASE_URL) {
    return {
      url: process.env.TEST_DATABASE_URL,
      async stop() {},
    };
  }

  const initdb = pgBin('initdb');
  const postgres = pgBin('postgres');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkdrop-pg-'));
  const port = await freePort();

  execFileSync(initdb, ['-D', dataDir, '-U', PG_USER, '-A', 'trust', '--encoding=UTF8', '--locale=C'], {
    stdio: 'ignore',
  });

  const child = spawn(
    postgres,
    [
      '-D', dataDir,
      '-p', String(port),
      '-k', dataDir,
      '-c', 'listen_addresses=127.0.0.1',
      '-c', 'fsync=off',
      '-c', 'synchronous_commit=off',
      '-c', 'full_page_writes=off',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const adminUrl = `postgresql://${PG_USER}@127.0.0.1:${port}/postgres`;
  const admin = await waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`postgres exited: ${stderr.slice(-500)}`);
      }
      // A failed connect leaves a client unusable, so each attempt gets a fresh one.
      const client = new Client({ connectionString: adminUrl });
      try {
        await client.connect();
        return client;
      } catch {
        await client.end().catch(() => {});
        return null;
      }
    },
    { label: 'postgres to accept connections' },
  );

  await admin.query(`CREATE DATABASE ${PG_DB}`);
  await admin.end();

  return {
    url: `postgresql://${PG_USER}@127.0.0.1:${port}/${PG_DB}`,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function startApp({ databaseUrl, port } = {}) {
  const listenPort = port || (await freePort());
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(listenPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const url = `http://127.0.0.1:${listenPort}`;

  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`app exited with ${child.exitCode}:\n${output}`);
        }
        try {
          await request(`${url}/healthz`, { timeoutMs: 1_000 });
          return true;
        } catch {
          return false;
        }
      },
      { label: `app to listen on ${url}` },
    );
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\n--- app output ---\n${output}`);
  }

  return {
    url,
    child,
    get output() {
      return output;
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function request(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { startDatabase, startApp, request };
