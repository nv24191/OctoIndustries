import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function runLoader(autoStart) {
  const source = await readFile(new URL('./game-loader.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const timers = new Map();
  const classes = new Set();
  let nextTimer = 0;
  const percent = { textContent: '' };
  const playButton = { addEventListener() {}, focus() {} };
  const loaderElement = {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
    style: { setProperty() {} },
    setAttribute(name, value) {
      this.attributes ??= {};
      this.attributes[name] = value;
    },
    querySelector(selector) {
      return selector === '.octo-loader-percent' ? percent : playButton;
    },
  };
  const document = {
    currentScript: {
      src: 'https://example.test/Octo-Industries/branding/game-loader.js',
      hasAttribute(name) { return autoStart && name === 'data-octo-auto-loader'; },
    },
    readyState: 'loading',
    body: { append() {} },
    createElement: () => loaderElement,
  };
  const windowObject = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
  };

  vm.runInNewContext(source, {
    document,
    window: windowObject,
    URL,
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetch,
    Blob,
    console,
  });

  return { classes, listeners, timers, percent };
}

test('automatically starts and finishes the shared loader for opted-in game pages', async () => {
  const { classes, listeners, timers, percent } = await runLoader(true);

  assert.equal(classes.has('is-done'), false);
  listeners.get('load')();
  assert.equal(percent.textContent, '100%');
  assert.equal(classes.has('is-done'), false);
  for (const callback of timers.values()) callback();
  assert.equal(classes.has('is-done'), true);
});

test('does not automatically show the loader for pages without opt-in', async () => {
  const { classes, listeners } = await runLoader(false);

  assert.equal(classes.size, 0);
  assert.equal(listeners.has('load'), false);
});
