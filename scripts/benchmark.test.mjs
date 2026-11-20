import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, measure } from './benchmark.mjs';

test('benchmark percentiles use sorted measured samples', () => {
  assert.deepEqual(distribution([8, 2, 4, 1, 5]), {
    samples: 5, minMs: 1, medianMs: 4, p95Ms: 8, maxMs: 8,
  });
  assert.throws(() => distribution([]));
  assert.throws(() => distribution([NaN]));
  assert.throws(() => distribution([-1]));
});

test('benchmark warms once and reports the requested measurements', () => {
  let calls = 0;
  const result = measure(() => { calls++; }, 3);
  assert.equal(calls, 4);
  assert.equal(result.samples, 3);
  assert.ok(result.minMs >= 0);
  assert.ok(result.p95Ms >= result.medianMs);
});
