import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogCategories } from './catalog-utils.mjs';

test('catalog categories are unique, trimmed, sorted, and ignore missing values', () => {
  assert.deepEqual(catalogCategories([
    { category: ' Puzzle ' },
    { category: 'Action' },
    { category: 'Puzzle' },
    { category: '' },
    { category: null },
    {},
  ]), ['Action', 'Puzzle']);
});
