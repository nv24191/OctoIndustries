import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ensureGameBranding } from './branding-injection.mjs';

const root = resolve('/workspace/site');
const launchFile = resolve(root, 'Octo-Industries', 'New-Game', 'index.html');

test('adds the existing branding assets to an unbranded launch page', () => {
  const html = '<!doctype html><html><head><title>New Game</title></head><body></body></html>';
  const branded = ensureGameBranding(html, launchFile, root);

  assert.match(branded, /href="\.\.\/branding\/game-branding\.css"/);
  assert.match(branded, /src="\.\.\/branding\/game-branding\.js"/);
  assert.equal((branded.match(/game-branding\.css/g) || []).length, 1);
  assert.equal((branded.match(/game-branding\.js/g) || []).length, 1);
});

test('repeated sync leaves existing branding assets unchanged', () => {
  const html = '<html><head><link href="../branding/game-branding.css"><script defer src="../branding/game-branding.js"></script></head></html>';

  assert.equal(ensureGameBranding(html, launchFile, root), html);
});

test('adds only the missing shared asset', () => {
  const html = '<html><head><script defer src="../branding/game-branding.js"></script></head></html>';
  const branded = ensureGameBranding(html, launchFile, root);

  assert.equal((branded.match(/game-branding\.css/g) || []).length, 1);
  assert.equal((branded.match(/game-branding\.js/g) || []).length, 1);
});

test('does not treat remote files with the same name as shared branding', () => {
  const html = '<html><head><script defer src="https://example.com/game-branding.js"></script></head></html>';
  const branded = ensureGameBranding(html, launchFile, root);

  assert.match(branded, /src="\.\.\/branding\/game-branding\.js"/);
});
