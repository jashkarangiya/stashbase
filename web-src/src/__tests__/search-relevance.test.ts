import assert from 'node:assert/strict';
import test from 'node:test';

import { relevanceRatios } from '../lib/searchRelevance.ts';

const approx = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;

test('relevance normalizes to a floored [0.2, 1] range within the result set', () => {
  const ratios = relevanceRatios([1, 0.5, 0]);
  assert.equal(ratios[0], 1); // strongest fills the bar
  assert.equal(ratios[2], 0.2); // weakest keeps a visible floor
  assert.ok(approx(ratios[1], 0.6)); // midpoint scales between floor and 1
});

test('relevance is order-independent and driven by value, not position', () => {
  const ratios = relevanceRatios([0, 0.5, 1]);
  assert.equal(ratios[0], 0.2);
  assert.ok(approx(ratios[1], 0.6));
  assert.equal(ratios[2], 1);
});

test('a single result and all-equal scores fill every bar', () => {
  assert.deepEqual(relevanceRatios([0.42]), [1]);
  assert.deepEqual(relevanceRatios([3, 3, 3]), [1, 1, 1]);
});

test('an empty result set yields no ratios', () => {
  assert.deepEqual(relevanceRatios([]), []);
});

test('negative and mixed-sign scores still normalize correctly', () => {
  const ratios = relevanceRatios([-1, 1]);
  assert.equal(ratios[0], 0.2);
  assert.equal(ratios[1], 1);
});
