import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { handleAdmin, handleCatalog, handleFeedback, handleRoadmap, handleTickets } from './admin.js';
import { ensureFeedbackSchema } from './feedback.js';
import { onRequest as serveAdminApi } from '../api/admin/[[path]].js';
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
    this.conversations = new Map();
    this.ticketActivity = [];
    this.nextTicketNumber = 1001;
    this.schemaInitializationCalls = 0;
    this.legacyFeedbackSchema = false;
    this.feedbackMigrationStatements = [];
    this.failFeedbackRead = false;
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    assert.equal(this.legacyFeedbackSchema, true);
    this.feedbackMigrationStatements = statements.map((statement) => statement.sql);
    this.legacyFeedbackSchema = false;
    return statements.map(() => ({ success: true }));
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
    if (sql.startsWith('UPDATE feedback_ticket_sequence')) return { ticket_number: database.nextTicketNumber++ };
    if (sql.startsWith('SELECT id, ticket_number, type, game_id, message, status, priority, created_at, updated_at FROM feedback_submissions')) {
      const ticket = database.feedback.get(values[0]);
      return ticket?.access_token_hash === values[1] && !ticket.deleted_at ? ticket : null;
    }
    if (sql.startsWith('SELECT id, access_token_hash FROM feedback_submissions')) {
      const ticket = database.feedback.get(values[0]);
      return ticket && !ticket.deleted_at ? { id: ticket.id, access_token_hash: ticket.access_token_hash } : null;
    }
    if (sql.startsWith('SELECT * FROM feedback_submissions WHERE id = ?')) return database.feedback.get(values[0]) || null;
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
    if (this.sql.includes("FROM sqlite_master WHERE type = 'table'")) {
      return { results: [
        'feedback_submissions',
        'feedback_rate_limits',
        'feedback_ticket_sequence',
        'feedback_conversations',
        'feedback_activity',
      ].map((name) => ({ name })) };
    }
    if (this.sql === 'PRAGMA table_info(feedback_submissions)') {
      const names = this.database.legacyFeedbackSchema
        ? ['id', 'type', 'game_id', 'message', 'device_info', 'status', 'admin_notes', 'created_at', 'updated_at']
        : ['id', 'ticket_number', 'access_token_hash', 'type', 'game_id', 'message', 'device_info', 'status', 'priority', 'admin_notes', 'archived_at', 'deleted_at', 'created_at', 'updated_at'];
      return { results: names.map((name) => ({ name })) };
    }
    if (this.sql.startsWith('SELECT id FROM feedback_submissions WHERE deleted_at IS NULL')) {
      return { results: this.values.filter((id) => this.database.feedback.has(id)
        && !this.database.feedback.get(id).deleted_at).map((id) => ({ id })) };
    }
    if (this.sql.startsWith('SELECT * FROM feedback_submissions')) {
      if (this.database.failFeedbackRead) throw new Error('Simulated Cloudflare D1 provider diagnostic.');
      const results = [...this.database.feedback.values()];
      return { results: this.sql.includes('deleted_at IS NULL') ? results.filter((entry) => !entry.deleted_at) : results };
    }
    if (this.sql.startsWith('SELECT author_type, message, created_at FROM feedback_conversations')) {
      return { results: this.database.conversations.get(this.values[0]) || [] };
    }
    if (this.sql.startsWith('SELECT action, actor_type, created_at FROM feedback_activity')) {
      return { results: this.database.ticketActivity.filter((entry) => entry[1] === this.values[0]).map((entry) => ({
        action: entry[2], actor_type: entry[3], created_at: entry[4],
      })) };
    }
    throw new Error(`Unexpected all() query in test: ${this.sql}`);
  }

  async run() {
    const { database, sql, values } = this;
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')) {
      database.schemaInitializationCalls += 1;
    } else if (sql.startsWith('INSERT OR IGNORE INTO feedback_ticket_sequence')) {
      database.schemaInitializationCalls += 1;
      database.nextTicketNumber = Math.max(1001, ...[...database.feedback.values()].map((entry) => (entry.ticket_number || 1000) + 1));
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
      const [id, ticket_number, access_token_hash, type, game_id, message, device_info, status, priority, admin_notes, created_at, updated_at] = values;
      database.feedback.set(id, { id, ticket_number, access_token_hash, type, game_id, message, device_info, status, priority, admin_notes, created_at, updated_at });
    } else if (sql.startsWith('INSERT INTO feedback_conversations')) {
      const [, feedback_id, author_type, message, created_at] = values;
      const conversations = database.conversations.get(feedback_id) || [];
      conversations.push({ author_type, message, created_at });
      database.conversations.set(feedback_id, conversations);
    } else if (sql.startsWith('INSERT INTO feedback_activity')) {
      database.ticketActivity.push(values);
    } else if (sql.startsWith('UPDATE feedback_submissions SET admin_notes')) {
      const [admin_notes, updated_at, id] = values;
      Object.assign(database.feedback.get(id), { admin_notes, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET status') && sql.includes('WHERE id IN')) {
      const [status, updated_at, ...ids] = values;
      for (const id of ids) if (database.feedback.has(id)) Object.assign(database.feedback.get(id), { status, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET status')) {
      const [status, updated_at, id] = values;
      Object.assign(database.feedback.get(id), { status, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET priority')) {
      const [priority, updated_at, id] = values;
      Object.assign(database.feedback.get(id), { priority, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET archived_at')) {
      const [archived_at, updated_at, id] = values;
      Object.assign(database.feedback.get(id), { archived_at, updated_at });
    } else if (sql.startsWith('UPDATE feedback_submissions SET deleted_at')) {
      const [deleted_at, updated_at, id] = values;
      Object.assign(database.feedback.get(id), { deleted_at, updated_at });
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
  const ticketCredentials = await publicSubmission.json();
  assert.equal(ticketCredentials.ticketNumber, 1001);
  assert.match(ticketCredentials.accessToken, /^[a-f\d]{64}$/);
  const publicTicketResponse = await handleTickets(new Request(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, {
    headers: { 'X-Ticket-Access-Token': ticketCredentials.accessToken },
  }), env);
  assert.equal(publicTicketResponse.status, 200);
  const publicTicket = await publicTicketResponse.json();
  assert.equal(publicTicket.ticketNumber, 1001);
  assert.equal(publicTicket.conversation[0].message, 'Add a new puzzle game.');
  assert.equal('adminNotes' in publicTicket, false);
  assert.equal('deviceInfo' in publicTicket, false);
  const userReply = await handleTickets(new Request(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}/messages`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'X-Ticket-Access-Token': ticketCredentials.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Any update on this idea?' }),
  }), env);
  assert.equal(userReply.status, 201);
  const ticketAfterReply = await handleTickets(new Request(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, {
    headers: { 'X-Ticket-Access-Token': ticketCredentials.accessToken },
  }), env);
  assert.equal((await ticketAfterReply.json()).conversation.length, 2);
  const invalidTicketAccess = await handleTickets(new Request(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, {
    headers: { 'X-Ticket-Access-Token': '0'.repeat(64) },
  }), env);
  assert.equal(invalidTicketAccess.status, 404);
  assert.equal(env.ADMIN_DB.schemaInitializationCalls, 0);
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
  env.ADMIN_DB.failFeedbackRead = true;
  const failedAdminRequest = new Request(`${baseUrl}/api/admin/feedback`, { headers: { Cookie: cookie } });
  const failedAdminResponse = await serveAdminApi({ request: failedAdminRequest, env });
  const failedAdminBody = await failedAdminResponse.json();
  assert.equal(failedAdminResponse.status, 500);
  assert.equal(failedAdminBody.details, 'Simulated Cloudflare D1 provider diagnostic.');
  assert.equal(failedAdminBody.requestId, failedAdminResponse.headers.get('X-Request-Id'));
  env.ADMIN_DB.failFeedbackRead = false;
  const prepare = env.ADMIN_DB.prepare.bind(env.ADMIN_DB);
  env.ADMIN_DB.prepare = (sql) => {
    if (sql.startsWith('SELECT COUNT(*) AS count FROM feedback_submissions')) {
      throw new Error('Feedback storage is unavailable.');
    }
    return prepare(sql);
  };
  const dashboardRequest = new Request(`${baseUrl}/api/admin/dashboard`, { headers: { Cookie: cookie } });
  const dashboardResponse = await handleAdmin(dashboardRequest, env);
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.ok(dashboard.counts.total > 0);
  assert.equal('newFeedback' in dashboard.counts, false);
  assert.ok(dashboard.activity.length > 0);
  assert.ok(dashboard.roadmap.length > 0);
  const legacyTicketId = 'e'.repeat(32);
  env.ADMIN_DB.feedback.set(legacyTicketId, {
    id: legacyTicketId, ticket_number: 900, access_token_hash: null, type: 'issue', game_id: null,
    message: 'Legacy inquiry', device_info: '{}', status: 'new', priority: 'medium', admin_notes: '',
    created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z',
  });
  const legacyHistory = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${legacyTicketId}/conversation`, {
    headers: { Cookie: cookie },
  }), env);
  assert.equal(legacyHistory.status, 200);
  const legacyReply = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${legacyTicketId}/reply`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Reply cannot be delivered.' }),
  }), env);
  assert.equal(legacyReply.status, 409);
  env.ADMIN_DB.feedback.delete(legacyTicketId);
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
  assert.equal(env.ADMIN_DB.schemaInitializationCalls, 0);
  const submissions = await inbox.json();
  assert.equal(submissions.length, 2);
  assert.equal(submissions.find((entry) => entry.type === 'issue').status, 'new');
  assert.equal(submissions.find((entry) => entry.type === 'suggestion').status, 'under_review');
  assert.equal(submissions.find((entry) => entry.type === 'issue').gameId, game.id);
  assert.equal(submissions.find((entry) => entry.type === 'suggestion').deviceInfo.userAgent, undefined);
  const statusUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${submissions[0].id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'under_review' }),
  }), env);
  assert.equal(statusUpdate.status, 200);
  const notesUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${submissions[0].id}/notes`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminNotes: 'Retest the report.' }),
  }), env);
  assert.equal(notesUpdate.status, 200);
  assert.notEqual(env.ADMIN_DB.feedback.get(ticketCredentials.ticketId).access_token_hash, ticketCredentials.accessToken);
  const userTicketAfterPrivateNote = await handleTickets(new Request(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, {
    headers: { 'X-Ticket-Access-Token': ticketCredentials.accessToken },
  }), env);
  const publicTicketAfterPrivateNote = await userTicketAfterPrivateNote.json();
  assert.equal('adminNotes' in publicTicketAfterPrivateNote, false);
  assert.equal('deviceInfo' in publicTicketAfterPrivateNote, false);
  const adminConversationResponse = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${ticketCredentials.ticketId}/conversation`, {
    headers: { Cookie: cookie },
  }), env);
  assert.equal(adminConversationResponse.status, 200);
  assert.equal((await adminConversationResponse.json()).conversation.length, 2);
  const adminReplyResponse = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${ticketCredentials.ticketId}/reply`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'We have added this to review.' }),
  }), env);
  assert.equal(adminReplyResponse.status, 201);
  const priorityUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${ticketCredentials.ticketId}/priority`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'critical' }),
  }), env);
  assert.equal(priorityUpdate.status, 200);
  const archiveTicket = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${ticketCredentials.ticketId}/archive`, {
    method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken }, body: '{}',
  }), env);
  assert.equal((await archiveTicket.json()).archived, true);
  const unarchiveTicket = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${ticketCredentials.ticketId}/unarchive`, {
    method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken }, body: '{}',
  }), env);
  assert.equal((await unarchiveTicket.json()).archived, false);
  const bulkUpdate = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/bulk`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: submissions.map((entry) => entry.id), status: 'closed' }),
  }), env);
  assert.equal(bulkUpdate.status, 200);
  const finalInbox = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback`, { headers: { Cookie: cookie } }), env);
  assert.ok((await finalInbox.json()).every((entry) => entry.status === 'closed'));
  const finalConversation = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${ticketCredentials.ticketId}/conversation`, {
    headers: { Cookie: cookie },
  }), env);
  assert.ok((await finalConversation.json()).activity.some((entry) => entry.action === 'status_closed'));
  const deleteTicket = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${ticketCredentials.ticketId}`, {
    method: 'DELETE', headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken },
  }), env);
  assert.equal(deleteTicket.status, 200);
  const deletedTicketAccess = await handleTickets(new Request(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, {
    headers: { 'X-Ticket-Access-Token': ticketCredentials.accessToken },
  }), env);
  assert.equal(deletedTicketAccess.status, 404);
  const invalidInquiryDelete = await handleAdmin(new Request(`${baseUrl}/api/admin/feedback/${submissions[0].id}/notes`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken },
  }), env);
  assert.equal(invalidInquiryDelete.status, 404);

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

test('legacy inquiry schema is diagnosed without running an automatic migration', async () => {
  const database = new MemoryDatabase();
  database.legacyFeedbackSchema = true;

  await assert.rejects(ensureFeedbackSchema(database), {
    code: 'FEEDBACK_SCHEMA_NOT_READY',
    status: 503,
  });

  assert.equal(database.legacyFeedbackSchema, true);
  assert.deepEqual(database.feedbackMigrationStatements, []);
  assert.equal(database.schemaInitializationCalls, 0);
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
