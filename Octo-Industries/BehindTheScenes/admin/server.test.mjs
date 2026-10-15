import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, pbkdf2Sync } from 'node:crypto';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, '../..');

async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = probe.address();
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForHealth(baseUrl, process) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) throw new Error('Admin server exited before becoming healthy.');
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error('Admin server did not become healthy.');
}

async function waitForJob(baseUrl, headers, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/admin/jobs`, { headers });
    assert.equal(response.status, 200);
    const jobs = await response.json();
    const job = jobs.find((entry) => entry.id === id);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Job ${id} did not finish.`);
}

async function submitLogin(baseUrl, password) {
  const originHeaders = { 'Content-Type': 'application/json', Origin: baseUrl };
  const challengeResponse = await fetch(`${baseUrl}/api/admin/login/challenge`, {
    method: 'POST',
    headers: originHeaders,
    body: '{}',
  });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const verifier = pbkdf2Sync(password, challenge.salt, challenge.iterations, 64, 'sha512');
  const proof = createHmac('sha256', verifier)
    .update(`${challenge.challengeId}\n${challenge.nonce}`)
    .digest('hex');
  return fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: originHeaders,
    body: JSON.stringify({ challengeId: challenge.challengeId, proof }),
  });
}

test('admin service protects and manages the canonical library', async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDirectory = await mkdtemp(resolve(tmpdir(), 'octo-admin-test-'));
  const catalogSource = await readFile(resolve(project, 'hub/catalog.js'), 'utf8');
  const catalogMatch = /Object\.freeze\(([\s\S]*)\);\s*$/.exec(catalogSource);
  assert.ok(catalogMatch);
  const storedCatalog = JSON.parse(catalogMatch[1]);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(resolve(dataDirectory, 'admin-state.json'), JSON.stringify({
    games: storedCatalog.map(({ addedAt, ...game }) => ({
      ...game,
      launch: game.launch.replace(/^\/+/, '').split(/[?#]/, 1)[0],
      thumbnail: ['8-ball-pool-online', 'baggio-magical-kicks'].includes(game.id)
        ? ''
        : game.thumbnail.split(/[?#]/, 1)[0].replace(/^\/+/, ''),
      screenshots: game.screenshots.map((path) => path.split(/[?#]/, 1)[0].replace(/^\/+/, '')),
      sourceFile: undefined,
      title: game.id === 'baggio-magical-kicks' ? 'Owner-edited Baggio title' : game.title,
      status: 'published',
    })),
    jobs: [],
    activity: [],
  }));
  const password = `Test-${randomBytes(12).toString('hex')}`;
  const salt = randomBytes(16).toString('hex');
  const digest = pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  const child = spawn(process.execPath, [resolve(project, 'admin/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      OCTO_DATA_DIR: dataDirectory,
      OCTO_ADMIN_PASSWORD_HASH: `pbkdf2$120000$${salt}$${digest}`,
      GEMINI_API_KEY: '',
      GITHUB_TOKEN: '',
      CF_ACCOUNT_ID: '',
      CF_D1_DATABASE_ID: '',
      CF_D1_API_TOKEN: '',
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once('exit', resolveExit);
    });
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  assert.equal(homepage.headers.get('cache-control'), 'no-cache');
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /Octo Industries/);
  assert.match(homepageHtml, /href="\/admin">Admin Dashboard<\/a>/);
  const runtimeCatalogResponse = await fetch(`${baseUrl}/api/catalog`);
  const runtimeCatalog = await runtimeCatalogResponse.json();
  for (const game of runtimeCatalog) {
    const launchResponse = await fetch(`${baseUrl}${game.launch}`);
    assert.equal(launchResponse.status, 200, `${game.title} launch page should be served`);
    const launchHtml = await launchResponse.text();
    assert.match(launchHtml, /game-branding\.css/, `${game.title} should load shared branding styles`);
    assert.match(launchHtml, /game-branding\.js/, `${game.title} should load the shared home button`);
  }
  for (const id of ['8-ball-pool-online', 'baggio-magical-kicks']) {
    const actual = runtimeCatalog.find((game) => game.id === id);
    const expected = storedCatalog.find((game) => game.id === id);
    assert.equal(actual.thumbnail, expected.thumbnail);
    assert.equal(actual.launch, expected.launch);
    assert.deepEqual(actual.screenshots, expected.screenshots);
    assert.equal(actual.sourceFile, expected.sourceFile);
  }
  assert.equal(runtimeCatalog.find((game) => game.id === 'baggio-magical-kicks').title, 'Owner-edited Baggio title');
  const publicCatalog = await fetch(`${baseUrl}/Octo-Industries/BehindTheScenes/hub/catalog.js`);
  assert.equal(publicCatalog.status, 200);
  assert.equal(publicCatalog.headers.get('cache-control'), 'no-cache');
  const gameBanner = await fetch(`${baseUrl}/Octo-Industries/Baggio-Magical-Kicks/hub-banner.svg`);
  assert.equal(gameBanner.status, 200);
  assert.equal(gameBanner.headers.get('cache-control'), 'public, max-age=300');
  const adminPage = await fetch(`${baseUrl}/admin`);
  assert.equal(adminPage.status, 200);
  const adminHtml = await adminPage.text();
  assert.match(adminPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(adminHtml, /OCTO AI GAME AGENT/);
  assert.match(adminHtml, /id="chat-form"/);
  const privateServerSource = await fetch(`${baseUrl}/admin/server.mjs`);
  assert.equal(privateServerSource.status, 404);
  const wasmAsset = await fetch(`${baseUrl}/Octo-Industries/Age-of-War/ruffle/72a20ef1c0b8ceb37720.wasm`);
  assert.equal(wasmAsset.headers.get('content-type'), 'application/wasm');
  const hiddenFile = await fetch(`${baseUrl}/.git/config`);
  assert.equal(hiddenFile.status, 404);
  const unauthorized = await fetch(`${baseUrl}/api/admin/dashboard`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/feedback`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/roadmap`)).status, 401);
  const publicRoadmapResponse = await fetch(`${baseUrl}/api/roadmap`);
  assert.equal(publicRoadmapResponse.status, 200);
  const publicRoadmap = await publicRoadmapResponse.json();
  assert.ok(publicRoadmap.some((item) => item.id === 'game-dna'));
  assert.ok(publicRoadmap.every((item) => !['released', 'archived'].includes(item.status) && !('internalNotes' in item)));

  const badLogin = await submitLogin(baseUrl, 'incorrect');
  assert.equal(badLogin.status, 401);

  const login = await submitLogin(baseUrl, password);
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie };
  const writeHeaders = { ...headers, Origin: baseUrl, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };

  const roadmapWithoutCsrf = await fetch(`${baseUrl}/api/admin/roadmap`, {
    method: 'POST', headers: { ...headers, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Search analytics', description: 'Record popular searches.' }),
  });
  assert.equal(roadmapWithoutCsrf.status, 403);
  const roadmapCreate = await fetch(`${baseUrl}/api/admin/roadmap`, {
    method: 'POST', headers: writeHeaders,
    body: JSON.stringify({ title: 'Search analytics', description: 'Record popular searches.', category: 'analytics', priority: 'normal' }),
  });
  assert.equal(roadmapCreate.status, 201);
  const roadmapItem = await roadmapCreate.json();
  const roadmapUpdate = await fetch(`${baseUrl}/api/admin/roadmap/${roadmapItem.id}`, {
    method: 'PATCH', headers: writeHeaders,
    body: JSON.stringify({ status: 'testing', internalNotes: 'Review query volume first.' }),
  });
  assert.equal(roadmapUpdate.status, 200);
  const updatedRoadmap = await roadmapUpdate.json();
  assert.equal(updatedRoadmap.status, 'testing');
  const bulkRoadmapUpdate = await fetch(`${baseUrl}/api/admin/roadmap/bulk`, {
    method: 'POST', headers: writeHeaders,
    body: JSON.stringify({ ids: [roadmapItem.id], status: 'on-hold' }),
  });
  assert.equal(bulkRoadmapUpdate.status, 200);
  assert.deepEqual(await bulkRoadmapUpdate.json(), { updated: 1, status: 'on-hold' });
  const publicUpdatedRoadmap = await (await fetch(`${baseUrl}/api/roadmap`)).json();
  const publicSearchAnalytics = publicUpdatedRoadmap.find((item) => item.id === roadmapItem.id);
  assert.equal(publicSearchAnalytics.status, 'on-hold');
  assert.equal('internalNotes' in publicSearchAnalytics, false);
  const roadmapDelete = await fetch(`${baseUrl}/api/admin/roadmap/${roadmapItem.id}`, { method: 'DELETE', headers: writeHeaders });
  assert.equal(roadmapDelete.status, 200);

  const initialCatalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
  assert.ok(initialCatalog.every((game) => Number.isFinite(Date.parse(game.addedAt))));
  const feedbackResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'issue',
      gameId: initialCatalog[0].id,
      message: 'The game freezes in fullscreen.',
      deviceInfo: {
        deviceType: 'Desktop',
        operatingSystem: 'Windows',
        browser: 'Chrome',
        screenResolution: '1920 × 1080',
        octoVersion: 'test-build',
        userAgent: 'must not be stored',
      },
    }),
  });
  assert.equal(feedbackResponse.status, 201);
  const ticketCredentials = await feedbackResponse.json();
  assert.equal(ticketCredentials.ticketNumber, 1001);
  assert.match(ticketCredentials.accessToken, /^[a-f\d]{64}$/);
  const ticketHeaders = { 'X-Ticket-Access-Token': ticketCredentials.accessToken };
  const publicTicketResponse = await fetch(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, { headers: ticketHeaders });
  assert.equal(publicTicketResponse.status, 200);
  const publicTicket = await publicTicketResponse.json();
  assert.equal(publicTicket.ticketNumber, 1001);
  assert.equal('adminNotes' in publicTicket, false);
  assert.equal('deviceInfo' in publicTicket, false);
  const userReply = await fetch(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}/messages`, {
    method: 'POST', headers: { ...ticketHeaders, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'I can share more details.' }),
  });
  assert.equal(userReply.status, 201);
  const secondFeedbackResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'suggestion', message: 'Add more puzzle games.' }),
  });
  assert.equal(secondFeedbackResponse.status, 201);
  assert.equal((await fetch(`${baseUrl}/api/feedback`)).status, 405);
  const feedbackResponseList = await fetch(`${baseUrl}/api/admin/feedback`, { headers });
  assert.equal(feedbackResponseList.status, 200);
  const feedbackItems = await feedbackResponseList.json();
  assert.equal(feedbackItems.length, 2);
  const issueFeedback = feedbackItems.find((entry) => entry.type === 'issue');
  assert.equal(issueFeedback.status, 'under_review');
  assert.equal(issueFeedback.gameId, initialCatalog[0].id);
  assert.equal(issueFeedback.deviceInfo.userAgent, undefined);
  assert.equal(issueFeedback.deviceInfo.browser, 'Chrome');
  assert.ok(Number.isFinite(Date.parse(issueFeedback.createdAt)));
  const markSeen = await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/status`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ status: 'under_review' }),
  });
  assert.equal(markSeen.status, 200);
  const saveNotes = await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/notes`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ adminNotes: 'Test this on desktop Chrome.' }),
  });
  assert.equal(saveNotes.status, 200);
  const adminReply = await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/reply`, {
    method: 'POST', headers: writeHeaders, body: JSON.stringify({ message: 'We are reviewing this report.' }),
  });
  assert.equal(adminReply.status, 201);
  const ownerTicketAfterAdminReply = await (await fetch(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, {
    headers: ticketHeaders,
  })).json();
  assert.equal(ownerTicketAfterAdminReply.status, 'awaiting_user_reply');
  assert.equal(ownerTicketAfterAdminReply.conversation.length, 3);
  const adminConversation = await (await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/conversation`, { headers })).json();
  assert.equal(adminConversation.conversation.length, 3);
  assert.ok(adminConversation.activity.some((entry) => (entry.action || '').includes('reply')));
  const setPriority = await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/priority`, {
    method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ priority: 'high' }),
  });
  assert.equal(setPriority.status, 200);
  const archiveTicket = await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/archive`, {
    method: 'POST', headers: writeHeaders, body: '{}',
  });
  assert.equal((await archiveTicket.json()).archived, true);
  const unarchiveTicket = await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/unarchive`, {
    method: 'POST', headers: writeHeaders, body: '{}',
  });
  assert.equal((await unarchiveTicket.json()).archived, false);
  const bulkArchive = await fetch(`${baseUrl}/api/admin/feedback/bulk`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ ids: feedbackItems.map((entry) => entry.id), status: 'closed' }),
  });
  assert.equal(bulkArchive.status, 200);
  const archivedFeedback = await (await fetch(`${baseUrl}/api/admin/feedback`, { headers })).json();
  assert.ok(archivedFeedback.every((entry) => entry.status === 'closed'));
  assert.equal(archivedFeedback.find((entry) => entry.id === issueFeedback.id).adminNotes, 'Test this on desktop Chrome.');
  const bulkActivity = await (await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}/conversation`, { headers })).json();
  assert.ok(bulkActivity.activity.some((entry) => (entry.action || '').includes('status_closed')));
  const deleteTicket = await fetch(`${baseUrl}/api/admin/feedback/${issueFeedback.id}`, { method: 'DELETE', headers: writeHeaders });
  assert.equal(deleteTicket.status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/admin/feedback`, { headers })).json()).length, 1);
  assert.equal((await fetch(`${baseUrl}/api/tickets/${ticketCredentials.ticketId}`, { headers: ticketHeaders })).status, 404);

  const unauthenticatedChat = await fetch(`${baseUrl}/api/admin/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'What needs attention?' }] }),
  });
  assert.equal(unauthenticatedChat.status, 401);

  const chatNotConfigured = await fetch(`${baseUrl}/api/admin/chat`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'What needs attention?' }] }),
  });
  assert.equal(chatNotConfigured.status, 503);
  assert.match((await chatNotConfigured.json()).error, /GEMINI_API_KEY/);

  const unauthenticatedApproval = await fetch(`${baseUrl}/api/admin/proposals/0123456789abcdef0123/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthenticatedApproval.status, 401);

  const approvalWithoutGitHubToken = await fetch(`${baseUrl}/api/admin/proposals/0123456789abcdef0123/approve`, {
    method: 'POST',
    headers: writeHeaders,
    body: '{}',
  });
  assert.equal(approvalWithoutGitHubToken.status, 404);

  const forbidden = await fetch(`${baseUrl}/api/admin/build`, {
    method: 'POST',
    headers: { ...headers, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);

  const dashboard = await fetch(`${baseUrl}/api/admin/dashboard`, { headers });
  assert.equal(dashboard.status, 200);
  const initial = await dashboard.json();
  assert.ok(initial.counts.total > 0);
  assert.equal(initial.capabilities.changeProposals, false);
  const gameId = initial.games[0].id;

  const healthResponse = await fetch(`${baseUrl}/api/admin/games/${gameId}/health`, {
    method: 'POST',
    headers: writeHeaders,
    body: '{}',
  });
  assert.equal(healthResponse.status, 202);
  const health = await waitForJob(baseUrl, headers, (await healthResponse.json()).id);
  assert.equal(health.status, 'completed');
  assert.ok(health.result.checks.some((check) => check.name === 'Launch file exists' && check.passed));
  assert.ok(health.result.checks.some((check) => check.name === 'Thumbnail available' && check.passed));

  const updated = await fetch(`${baseUrl}/api/admin/games/${gameId}`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ description: 'Admin-managed test description.' }),
  });
  assert.equal(updated.status, 200);
  const catalogResponse = await fetch(`${baseUrl}/api/catalog`);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.find((game) => game.id === gameId).description, 'Admin-managed test description.');

  const unpublished = await fetch(`${baseUrl}/api/admin/games/${gameId}/publish`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ published: false }),
  });
  assert.equal(unpublished.status, 200);
  const hiddenCatalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
  assert.equal(hiddenCatalog.some((game) => game.id === gameId), false);

  const blockedAnalysis = await fetch(`${baseUrl}/api/admin/analyze`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ url: 'http://127.0.0.1/private' }),
  });
  assert.equal(blockedAnalysis.status, 202);
  const analysisJob = await blockedAnalysis.json();
  const failedAnalysis = await waitForJob(baseUrl, headers, analysisJob.id);
  assert.equal(failedAnalysis.status, 'failed');
  assert.match(failedAnalysis.message, /private or reserved/i);

  const mappedLoopback = await fetch(`${baseUrl}/api/admin/analyze`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ url: 'http://[::ffff:7f00:1]/private' }),
  });
  assert.equal(mappedLoopback.status, 202);
  const mappedJob = await waitForJob(baseUrl, headers, (await mappedLoopback.json()).id);
  assert.equal(mappedJob.status, 'failed');
  assert.match(mappedJob.message, /private or reserved/i);

  const buildResponse = await fetch(`${baseUrl}/api/admin/build`, {
    method: 'POST',
    headers: writeHeaders,
    body: '{}',
  });
  assert.equal(buildResponse.status, 202);
  const build = await buildResponse.json();
  const completedBuild = await waitForJob(baseUrl, headers, build.id);
  assert.equal(completedBuild.status, 'completed');
  assert.equal(completedBuild.result.gameCount, initial.counts.total - 1);

  const standalone = await fetch(`${baseUrl}/masterstandalone.html`);
  assert.equal(standalone.status, 200);
  assert.match(standalone.headers.get('content-security-policy'), /sha256-/);
  assert.match(await standalone.text(), /window\.OCTO_GAMES/);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rejected = await submitLogin(baseUrl, 'incorrect-again');
    assert.equal(rejected.status, 401);
  }
  const rateLimited = await submitLogin(baseUrl, 'incorrect-again');
  assert.equal(rateLimited.status, 429);

  const logout = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: writeHeaders,
    body: '{}',
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/admin/dashboard`, { headers });
  assert.equal(afterLogout.status, 401);
});
