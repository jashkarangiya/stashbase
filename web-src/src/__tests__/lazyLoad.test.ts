import assert from 'node:assert/strict';
import test from 'node:test';
import { LazyLoadBoundary, loadWithRetry } from '../components/ErrorBoundary';

test('lazy module loading retries one transient failure', async () => {
  let attempts = 0;
  const loaded = await loadWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary chunk failure');
    return 'loaded';
  }, 1, 0);

  assert.equal(loaded, 'loaded');
  assert.equal(attempts, 2);
});

test('lazy module loading surfaces the final error after its retry budget', async () => {
  let attempts = 0;
  await assert.rejects(
    loadWithRetry(async () => {
      attempts += 1;
      throw new Error(`chunk failure ${attempts}`);
    }, 1, 0),
    /chunk failure 2/,
  );
  assert.equal(attempts, 2);
});

test('lazy load boundary clears a captured error when its resource identity changes', () => {
  const error = new Error('broken preview');
  const state = { error, resetKey: 'first.md:v1' };
  const props = {
    children: null,
    className: 'doc-loading',
    label: 'Markdown preview',
    resetKey: 'second.md:v1',
  };

  assert.deepEqual(LazyLoadBoundary.getDerivedStateFromProps(props, state), {
    error: null,
    resetKey: 'second.md:v1',
  });
  assert.equal(
    LazyLoadBoundary.getDerivedStateFromProps({ ...props, resetKey: state.resetKey }, state),
    null,
  );
});
