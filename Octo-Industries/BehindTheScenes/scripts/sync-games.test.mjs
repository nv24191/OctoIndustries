import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const collection = resolve(root, 'Octo-Industries');
const catalogFile = resolve(collection, 'BehindTheScenes/hub/catalog.js');

async function readCatalog() {
  const source = await readFile(catalogFile, 'utf8');
  const match = /Object\.freeze\(([\s\S]*)\);\s*$/.exec(source);
  assert.ok(match, 'generated catalog uses the expected format');
  const catalog = JSON.parse(match[1]);
  assert.ok(Array.isArray(catalog), 'generated catalog is an array');
  return catalog;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('the generated main registry includes every importable game folder with complete metadata and assets', async () => {
  const entries = await readdir(collection, { withFileTypes: true });
  const importable = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const directory = resolve(collection, entry.name);
    if (await isFile(resolve(directory, 'game.json')) || await isFile(resolve(directory, 'index.html'))) {
      importable.push(directory);
    }
  }

  const catalog = await readCatalog();
  const gameIds = new Set(catalog.map((game) => game.id));
  assert.equal(gameIds.size, catalog.length, 'game IDs are unique');
  assert.equal(catalog.length, importable.length, 'every importable top-level game folder is registered');

  for (const directory of importable) {
    const manifestPath = resolve(directory, 'game.json');
    const manifestExists = await isFile(manifestPath);
    const manifest = manifestExists ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
    const game = catalog.find((entry) => entry.id === manifest?.id
      || entry.sourceFile === `${directory.slice(collection.length + 1)}/index.html`);
    assert.ok(game, `${directory} is in the generated main registry`);
    for (const field of ['title', 'description', 'category', 'addedAt', 'launch', 'thumbnail', 'banner', 'sourceFile']) {
      assert.ok(typeof game[field] === 'string' && game[field].trim(), `${game.title} has ${field}`);
    }
    assert.ok(Array.isArray(game.tags), `${game.title} has searchable tags`);

    for (const asset of [game.launch, game.thumbnail, game.banner]) {
      const assetPath = decodeURIComponent(new URL(asset, 'https://octo.invalid').pathname)
        .split('/')
        .filter(Boolean);
      assert.ok(await isFile(resolve(root, ...assetPath)), `${game.title} asset exists: ${asset}`);
    }
  }
});
