import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/index.js';

// All tests use a fake clock so behaviour is independent of wall time.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

const TOLERANCE = 1e-9;

function approxEqual(a, b, msg) {
  assert.ok(Math.abs(a - b) < TOLERANCE, `${msg} (got ${a}, expected ~${b})`);
}

test('constructs full and allows a burst up to capacity', () => {
  const clock = makeClock(1000);
  const b = new TokenBucket({ capacity: 5, refillRate: 1, now: clock.now });

  for (let i = 0; i < 5; i++) {
    const r = b.take(1);
    assert.equal(r.allowed, true);
    assert.equal(r.waitMs, 0);
  }
  // 6th request in the same instant is denied.
  const r = b.take(1);
  assert.equal(r.allowed, false);
  assert.equal(r.waitMs, 1000);
  approxEqual(r.remaining, 0, 'remaining after drain');
});

test('refills continuously at the configured rate', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 2, refillRate: 1, now: clock.now });

  b.take(2); // drain
  clock.advance(500); // half a token
  approxEqual(b.availableTokens, 0.5, 'half-second refill');

  clock.advance(500); // a full token now
  approxEqual(b.availableTokens, 1.0, 'one-second refill');
});

test('refill is capped at capacity', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 3, refillRate: 1, now: clock.now });

  clock.advance(10_000); // would add 10 tokens
  approxEqual(b.availableTokens, 3, 'capped at capacity');
});

test('waitMs accounts for partial tokens already present', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 2, refillRate: 1, now: clock.now });

  b.take(2); // empty
  clock.advance(250); // 0.25 tokens
  const r = b.take(1); // needs 0.75 more -> 750ms
  assert.equal(r.allowed, false);
  assert.equal(r.waitMs, 750);
});

test('waitMs is rounded up to whole milliseconds', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: clock.now });

  b.take(1); // empty
  // 0.1 tokens present; need 0.9 more -> 900ms exactly, ceiling is 900.
  clock.advance(100);
  const r = b.take(1);
  assert.equal(r.waitMs, 900);

  // Now a non-integer case: 0.11 tokens, need 0.89 -> 890ms, ceiling 890.
  clock.set(0);
  const b2 = new TokenBucket({ capacity: 1, refillRate: 1, now: clock.now });
  b2.take(1);
  clock.advance(110);
  const r2 = b2.take(1);
  assert.equal(r2.waitMs, 890);
});

test('cost greater than capacity is reported with its true wait', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 2, refillRate: 1, now: clock.now });

  // Full bucket holds 2, request needs 5 -> deficit 3 -> 3000ms.
  const r = b.take(5);
  assert.equal(r.allowed, false);
  assert.equal(r.waitMs, 3000);
  approxEqual(r.remaining, 2, 'bucket untouched on denial');
});

test('denied take does not consume tokens', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: clock.now });

  b.take(1); // empty
  clock.advance(250); // 0.25 tokens
  const before = b.availableTokens;
  b.take(1); // denied
  approxEqual(b.availableTokens, before, 'tokens unchanged after denial');
});

test('clock moving backwards does not refill and does not advance baseline', () => {
  const clock = makeClock(1000);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: clock.now });

  b.take(1); // empty at t=1000
  clock.set(500); // backwards
  approxEqual(b.availableTokens, 0, 'no refill on backward clock');

  // Move forward past the original baseline; refill should be measured
  // from 1000, not 500, so at t=1500 we get 0.5 tokens.
  clock.set(1500);
  approxEqual(b.availableTokens, 0.5, 'refill measured from earlier baseline');
});

test('zero elapsed time does not refill', () => {
  const clock = makeClock(1000);
  const b = new TokenBucket({ capacity: 2, refillRate: 1, now: clock.now });

  b.take(2); // empty
  // Call again at the same instant.
  approxEqual(b.availableTokens, 0, 'no refill at same instant');
});

test('custom cost is honoured on success', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 10, refillRate: 1, now: clock.now });

  const r = b.take(4);
  assert.equal(r.allowed, true);
  approxEqual(r.remaining, 6, 'remaining after multi-token take');
});

test('constructor rejects invalid parameters', () => {
  const clock = makeClock(0);
  assert.throws(() => new TokenBucket({ capacity: 0, refillRate: 1, now: clock.now }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: -1, refillRate: 1, now: clock.now }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: NaN, refillRate: 1, now: clock.now }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 0, now: clock.now }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: -1, now: clock.now }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: Infinity, now: clock.now }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 1, now: 'not a function' }), TypeError);
});

test('take rejects invalid cost', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: clock.now });

  assert.throws(() => b.take(0), RangeError);
  assert.throws(() => b.take(-1), RangeError);
  assert.throws(() => b.take(NaN), RangeError);
  assert.throws(() => b.take(Infinity), RangeError);
});

test('default cost is 1', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: clock.now });

  const r = b.take();
  assert.equal(r.allowed, true);
  approxEqual(r.remaining, 0, 'default cost of 1 consumed');
});

test('defaults to Date.now when no clock is given', () => {
  // Only verifies construction and a single call succeed; no timing
  // assertions, since Date.now is non-deterministic.
  const b = new TokenBucket({ capacity: 5, refillRate: 1 });
  const r = b.take(1);
  assert.equal(r.allowed, true);
  assert.equal(r.waitMs, 0);
});

test('fractional refillRate accumulates without loss', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 0.1, now: clock.now });

  b.take(1); // empty
  clock.advance(5000); // 0.5 tokens at 0.1/sec
  approxEqual(b.availableTokens, 0.5, 'fractional rate after 5s');

  clock.advance(5000); // now 1.0
  approxEqual(b.availableTokens, 1.0, 'fractional rate reaches 1.0');
});

test('take after exact wait succeeds', () => {
  const clock = makeClock(0);
  const b = new TokenBucket({ capacity: 1, refillRate: 1, now: clock.now });

  b.take(1); // empty
  const denied = b.take(1);
  assert.equal(denied.allowed, false);
  assert.equal(denied.waitMs, 1000);

  clock.advance(1000);
  const ok = b.take(1);
  assert.equal(ok.allowed, true);
  approxEqual(ok.remaining, 0, 'exactly consumed after waiting');
});
