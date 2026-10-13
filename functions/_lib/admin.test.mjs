import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { handleAdmin, handleCatalog, handleFeedback, handleRoadmap } from './admin.js';
import { onRequest as serveCompressedAsset } from '../Octo-Industries/Red-Ball-4/Build/[[path]].js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const catalogFile = resolve(root, 'Octo-Industries/BehindTheScenes/hub/catalog.js');
const htmlFile = resolve(root, 'index.html');

class MemoryDatabase {
  constructor() {
    this.state = null;
    this.sessions = new Map();
    this.challenges = new Map();
    this.loginAttempts = new Map();
    this.rateLimits = new Map();
    this.feedbackRateLimits = new Map();
    this.feedback = new Map();
    this.schemaInitializationCalls = 0;
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
}

class MemoryStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    const { database, sql, values } = this;
    if (sql.startsWith('SELECT value FROM admin_state')) return database.state ? { value: database.state } : null;
    if (sql.startsWith('SELECT csrf_token, expires_at FROM admin_sessions')) {
      const session = database.sessions.get(values[0]);
      return session && session.expires_at > values[1] ? session : null;
    }
    if (sql.startsWith('SELECT * FROM admin_login_attempts')) return database.loginAttempts.get(values[0]) || null;
    if (sql.startsWith("SELECT COUNT(*) AS count FROM feedback_submissions")) {
      return { count: [...database.feedback.values()].filter((entry) => entry.status === 'new').length };
    }
    if (sql.startsWith('SELECT id FROM feedback_submissions')) return database.feedback.has(values[0]) ? { id: values[0] } : null;
    if (sql.startsWith('INSERT INTO feedback_rate_limits')) {
      const [key, now, windowStart] = values;
      const previous = database.feedbackRateLimits.get(key);
      const count = !previous || previous.window_start < windowStart ? 1 : previous.request_count + 1;
      database.feedbackRateLimits.set(key, { window_start: now, request_count: count });
      return { request_count: count };
    }
    if (sql.startsWith('DELETE FROM admin_login_challenges')) {
      const challenge = database.challenges.get(values[0]);
      if (!challenge || challenge.client_key !== values[1] || challenge.expires_at <= values[2]) return null;
      database.challenges.delete(values[0]);
      return { nonce: challenge.nonce };
    }
    if (sql.startsWith('INSERT INTO admin_rate_limits')) {
      const [key, now, windowStart] = values;
      const previous = database.rateLimits.get(key);
      const count = !previous || previous.window_start < windowStart ? 1 : previous.request_count + 1;
      database.rateLimits.set(key, { window_start: now, request_count: count });
      return { request_count: count };
    }
    throw new Error(`Unexpected first() query in test: ${sql}`);
  }

  async all() {
    if (this.sql.startsWith('SELECT * FROM feedback_submissions')) {
      return { results: [...this.database.feedback.values()] };
    }
    throw new Error(`Unexpected all() query in test: ${this.sql}`);
  }

  async run() {
    const { database, sql, values } = this;
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')) {
      database.schemaInitializationCalls += 1;
      return { success: true };
    } else if (sql.startsWith('INSERT OR IGNORE INTO admin_state')) {
      database.state ??= values[0];
    } else if (sql.startsWith('UPDATE admin_state')) {
      database.state = values[0];
    } else if (sql.startsWith('INSERT INTO admin_sessions')) {
      database.sessions.set(values[0], { csrf_token: values[1], expires_at: values[2] });
    } else if (sql.startsWith('DELETE FROM admin_sessions WHERE token_hash')) {
      database.sessions.delete(values[0]);
    } else if (sql.startsWith('DELETE FROM admin_login_attempts WHERE key')) {
      database.loginAttempts.delete(values[0]);
    } else if (sql.startsWith('DELETE FROM admin_sessions WHERE expires_at')) {
      for (const [key, session] of database.sessions) if (session.expires_at <= values[0]) database.sessions.delete(key);
    } else if (sql.startsWith('DELETE FROM admin_rate_limits WHERE window_start')) {
      for (const [key, limit] of database.rateLimits) if (limit.window_start < values[0]) database.rateLimits.delete(key);
    } else if (sql.startsWith('DELETE FROM feedback_rate_limits WHERE window_start')) {
      for (const [key, limit] of database.feedbackRateLimits) if (limit.window_start < values[0]) database.feedbackRateLimits.delete(key);
    } else if (sql.startsWith('DELETE FROM admin_login_challenges WHERE expires_at')) {
      for (const [key, challenge] of database.challenges) if (challenge.expires_at <= values[0]) database.challenges.delete(key);
    } else if (sql.startsWith('INSERT INTO admin_login_challenges')) {
      database.challenges.set(values[0], {
        id_hash: values[0], client_key: values[1], nonce: values[2], expires_at: values[3],
      });
    } else if (sql.startsWith('INSERT INTO admin_login_attempts')) {
      database.loginAttempts.set(values[0], {
        key: values[0], window_start: values[1], attempts: values[2], blocked_until: values[3],
      });
    } else if (sql.startsWith('INSERT INTO feedback_submissions')) {
      const [id, type, game_id, message, device_info, status, admin_notes, created_at, updated_at] = values;
      database.feedback.set(id, { id, type, game_id, message, device_info, status, admin_notes, created_at, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET admin_notes')) {
      const [admin_notes, updated_at, id] = values;
      Object.assign(database.feedback.get(id), { admin_notes, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET status') && sql.includes('WHERE id IN')) {
      const [status, updated_at, ...ids] = values;
      for (const id of ids) if (database.feedback.has(id)) Object.assign(database.feedback.get(id), { status, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET status')) {
      const [status, updated_at, id] = values;
      Object.assign(database.feedback.get(id), { status, updated_at });
    } else {
      throw new Error(`Unexpected run() query in test: ${sql}`);
    }
    return { success: true };
  }
}

function testEnvironment(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return {
    ADMIN_DB: new MemoryDatabase(),
    OCTO_ADMIN_PASSWORD_HASH: `pbkdf2$120000$${salt}$${digest}`,
    ASSETS: {
      async fetch(input) {
        const url = new URL(input);
        if (url.pathname.endsWith('/catalog.js')) return new Response(await readFile(catalogFile, 'utf8'));
        if (url.pathname === '/') return new Response(await readFile(htmlFile, 'utf8'));
        return new Response(null, { status: 200 });
      },
    },
  };
}

test('public catalog refreshes stale asset refs and backfills addedAt without overwriting edits', async () => {
  const env = testEnvironment('backfill-test');
  const source = await readFile(catalogFile, 'utf8');
  const catalogMatch = /Object\.freeze\(([\s\S]*)\);\s*$/.exec(source);
  assert.ok(catalogMatch);
  const catalogGames = JSON.parse(catalogMatch[1]);
  const existingGames = catalogGames.map(({ addedAt, ...game }, index) => ({
    ...game,
    launch: game.launch.replace(/^\/+/, '').split(/[?#]/, 1)[0],
    thumbnail: '',
    screenshots: game.screenshots.map((path) => path.split(/[?#]/, 1)[0].replace(/^\/+/, '')),
    sourceFile: undefined,
    title: index === 0 ? 'Owner-edited title' : game.title,
    status: 'published',
  }));
  env.ADMIN_DB.state = JSON.stringify({ games: existingGames, jobs: [], activity: [], roadmap: [] });

  const response = await handleCatalog(new Request('https://octo-test.pages.dev/api/catalog'), env);
  assert.equal(response.status, 200);
  const publicGames = await response.json();
  for (const game of catalogGames) {
    const updated = publicGames.find((entry) => entry.id === game.id);
    assert.equal(updated?.addedAt, game.addedAt);
    assert.equal(updated?.launch, game.launch);
    assert.equal(updated?.thumbnail, game.thumbnail);
    assert.deepEqual(updated?.screenshots, game.screenshots);
    assert.equal(updated?.sourceFile, game.sourceFile);
  }
  assert.equal(publicGames[0].title, 'Owner-edited title');
  const savedState = JSON.parse(env.ADMIN_DB.state);
  assert.equal(savedState.games[0].title, 'Owner-edited title');
  assert.ok(savedState.games.every((game) => game.addedAt));
});

test('Cloudflare admin login, CSRF protection, catalog edits, and logout', async () => {
  const password = `test-${randomBytes(12).toString('hex')}`;
  const env = testEnvironment(password);
  const baseUrl = 'https://octo-test.pages.dev';
  const publicSubmission = await handleFeedback(new Request(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
    body: JSON.stringify({ type: 'suggestion', message: 'Add a new puzzle game.', deviceInfo: { browser: 'Firefox', userAgent: 'do not store' } }),
  }), env);
  assert.equal(publicSubmission.status, 201);
  assert.equal(env.ADMIN_DB.schemaInitializationCalls, 4);
  const crossOriginSubmission = await handleFeedback(new Request(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'suggestion', message: 'Cross origin' }),
  }), env);
  assert.equal(crossOriginSubmission.status, 403);
  const unauthorizedFeedback = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback`), env);
  assert.equal(unauthorizedFeedback.status, 401);

  const challengeResponse = await handleAdmin(new Request(`${baseUrl}/api/admin/login/challenge`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}',
  }), env);
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const verifierBits = await webcrypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-512',
    salt: new TextEncoder().encode(challenge.salt),
    iterations: challenge.iterations,
  }, await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']), 512);
  const proofKey = await webcrypto.subtle.importKey('raw', verifierBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const proof = [...new Uint8Array(await webcrypto.subtle.sign(
    'HMAC', proofKey, new TextEncoder().encode(`${challenge.challengeId}\n${challenge.nonce}`),
  ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const loginRequest = new Request(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.challengeId, proof }),
  });
  const login = await handleAdmin(loginRequest, env);
  assert.equal(login.status, 200);
  const { csrfToken } = await login.json();
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const dashboardRequest = new Request(`${baseUrl}/api/admin/dashboard`, { headers: { Cookie: cookie } });
  const dashboardResponse = await handleAdmin(dashboardRequest, env);
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.ok(dashboard.counts.total > 0);
  assert.equal(dashboard.counts.newFeedback, 1);
  assert.ok(dashboard.roadmap.length > 0);
  assert.equal((await handleAdmin(new Request(`${baseUrl}/api/admin/roadmap`), env)).status, 401);
  const publicRoadmapResponse = await handleRoadmap(new Request(`${baseUrl}/api/roadmap`), env);
  assert.equal(publicRoadmapResponse.status, 200);
  const publicRoadmap = await publicRoadmapResponse.json();
  assert.ok(publicRoadmap.length > 0);
  assert.ok(publicRoadmap.every((item) => !['released', 'archived'].includes(item.status) && !('internalNotes' in item)));

  const roadmapHeaders = { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' };
  const missingRoadmapCsrf = await handleAdmin(new Request(`${baseUrl}/api/admin/roadmap`, {
    method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Offline Hub', description: 'Cache the hub.' }),
  }), env);
  assert.equal(missingRoadmapCsrf.status, 403);
  const roadmapCreate = await handleAdmin(new Request(`${baseUrl}/api/admin/roadmap`, {
    method: 'POST', headers: roadmapHeaders,
    body: JSON.stringify({ title: 'Offline Hub', description: 'Cache the hub.', category: 'platform', priority: 'high' }),
  }), env);
  assert.equal(roadmapCreate.status, 201);
  const roadmapItem = await roadmapCreate.json();
  const roadmapUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/roadmap/${roadmapItem.id}`, {
    method: 'PATCH', headers: roadmapHeaders,
    body: JSON.stringify({ status: 'in-progress', internalNotes: 'Check storage limits.' }),
  }), env);
  assert.equal(roadmapUpdate.status, 200);
  const updatedRoadmapItem = await roadmapUpdate.json();
  assert.equal(updatedRoadmapItem.status, 'in-progress');
  const publicUpdatedRoadmap = await (await handleRoadmap(new Request(`${baseUrl}/api/roadmap`), env)).json();
  const publicOfflineHub = publicUpdatedRoadmap.find((item) => item.id === roadmapItem.id);
  assert.equal(publicOfflineHub.status, 'in-progress');
  assert.equal('internalNotes' in publicOfflineHub, false);
  const roadmapDelete = await handleAdmin(new Request(`${baseUrl}/api/admin/roadmap/${roadmapItem.id}`, {
    method: 'DELETE', headers: roadmapHeaders,
  }), env);
  assert.equal(roadmapDelete.status, 200);

  const game = dashboard.games[0];
  const issueSubmission = await handleFeedback(new Request(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.11' },
    body: JSON.stringify({
      type: 'issue',
      gameId: game.id,
      message: 'The game does not load.',
      deviceInfo: { deviceType: 'Mobile', operatingSystem: 'iOS', browser: 'Safari', screenResolution: '390 × 844' },
    }),
  }), env);
  assert.equal(issueSubmission.status, 201);
  const inbox = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback`, { headers: { Cookie: cookie } }), env);
  assert.equal(inbox.status, 200);
  assert.equal(env.ADMIN_DB.schemaInitializationCalls, 4);
  const submissions = await inbox.json();
  assert.equal(submissions.length, 2);
  assert.ok(submissions.every((entry) => entry.status === 'new'));
  assert.equal(submissions.find((entry) => entry.type === 'issue').gameId, game.id);
  assert.equal(submissions.find((entry) => entry.type === 'suggestion').deviceInfo.userAgent, undefined);
  const statusUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${submissions[0].id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'seen' }),
  }), env);
  assert.equal(statusUpdate.status, 200);
  const notesUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${submissions[0].id}/notes`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminNotes: 'Retest the report.' }),
  }), env);
  assert.equal(notesUpdate.status, 200);
  const bulkUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/bulk`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: submissions.map((entry) => entry.id), status: 'archived' }),
  }), env);
  assert.equal(bulkUpdate.status, 200);
  const finalInbox = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback`, { headers: { Cookie: cookie } }), env);
  assert.ok((await finalInbox.json()).every((entry) => entry.status === 'archived'));

  const editUrl = `${baseUrl}/api/admin/games/${game.id}`;
  const invalidEdit = await handleAdmin(new Request(editUrl, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'No CSRF token' }),
  }), env);
  assert.equal(invalidEdit.status, 403);

  const edit = await handleAdmin(new Request(editUrl, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Edited in D1' }),
  }), env);
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).title, 'Edited in D1');

  const unpublish = await handleAdmin(new Request(`${baseUrl}/api/admin/games/${game.id}/publish`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ published: false }),
  }), env);
  assert.equal(unpublish.status, 200);
  const catalog = await handleCatalog(new Request(`${baseUrl}/api/catalog`), env);
  assert.equal((await catalog.json()).some((entry) => entry.id === game.id), false);

  const logout = await handleAdmin(new Request(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: '{}',
  }), env);
  assert.equal(logout.status, 200);
  assert.equal((await handleAdmin(dashboardRequest, env)).status, 401);
});

test('Cloudflare large-asset route returns a correctly encoded gzip representation', async () => {
  const content = Buffer.from('large Unity payload');
  const compressed = gzipSync(content);
  const manifest = {
    '/Octo-Industries/Red-Ball-4/Build/large.data': {
      file: '/Octo-Industries/Red-Ball-4/Build/large.data.cf-gzip',
      contentType: 'application/octet-stream',
      originalSize: content.length,
    },
  };
  const request = new Request('https://octo-test.pages.dev/Octo-Industries/Red-Ball-4/Build/large.data', {
    headers: { 'Accept-Encoding': 'gzip, br' },
  });

  test('Cloudflare public feedback endpoint limits anonymous submissions without storing raw addresses', async () => {
    const env = testEnvironment(`test-${randomBytes(12).toString('hex')}`);
    const baseUrl = 'https://octo-test.pages.dev';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await handleFeedback(new Request(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.25' },
        body: JSON.stringify({ type: 'suggestion', message: `Suggestion ${attempt}` }),
      }), env);
      assert.equal(response.status, 201);
    }
    const limited = await handleFeedback(new Request(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.25' },
      body: JSON.stringify({ type: 'suggestion', message: 'One too many' }),
    }), env);
    assert.equal(limited.status, 429);
    assert.equal(env.ADMIN_DB.feedback.size, 5);
    assert.ok([...env.ADMIN_DB.feedbackRateLimits.keys()].every((key) => !key.includes('203.0.113.25')));
  });
  const response = await serveCompressedAsset({
    request,
    env: {
      ASSETS: {
        async fetch(input) {
          const path = new URL(input).pathname;
          if (path === '/octo-compressed-assets.json') return Response.json(manifest);
          if (path === manifest[requestUrlPath(request)].file) return new Response(compressed);
          return new Response('not found', { status: 404 });
        },
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(gunzipSync(Buffer.from(await response.arrayBuffer())), content);
});

function requestUrlPath(request) {
  return new URL(request.url).pathname;
}
