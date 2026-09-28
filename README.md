# Rate Limit Token Bucket

A token-bucket rate limiter for JavaScript. Tracks a capacity of tokens that refills at a steady rate; `take(cost)` reports whether a request may proceed and, when not, how many milliseconds to wait until it can.

```js
import { TokenBucket } from 'rate-limit-token-bucket';

const bucket = new TokenBucket({ capacity: 10, refillRate: 2 });
const { allowed, waitMs, remaining } = bucket.take(1);
if (!allowed) {
  // waitMs is the whole milliseconds until 1 token is available.
}
```

Pass a `now` function to control time in tests:

```js
let t = 0;
const bucket = new TokenBucket({ capacity: 5, refillRate: 1, now: () => t });
bucket.take(5);   // drains the bucket
t += 500;         // advance 0.5s -> 0.5 tokens
bucket.take(1);   // { allowed: false, waitMs: 500, remaining: 0.5 }
```

## Why this exists

Most rate-limiting needs are simple: allow short bursts, then throttle to an average rate. A token bucket does that with one subtraction and one clock read per call, no timers, no background work. This library is the smallest correct implementation of that idea — lazy refill, an injectable clock, and nothing else.

The trade-off: refill is computed on demand, so a bucket that sits idle refills to capacity silently. That is the desired behaviour for burst-permitting limiters, but it means the bucket cannot enforce a hard "requests per calendar second" ceiling. If you need that, use a fixed-window limiter instead.

## Edge cases worth knowing

- **Clock skew.** If `now()` moves backwards, the bucket refills nothing and keeps its earlier baseline, so a later forward jump is measured from the original timestamp. This makes the bucket stable against small NTP adjustments but means a large backwards jump can briefly suppress refill.
- **Cost above capacity.** `take(cost)` where `cost > capacity` is never allowed; `waitMs` reflects the true deficit. The bucket is not consumed on denial.
- **Fractional tokens.** Tokens are stored as floats so a `refillRate` of `0.5` accumulates correctly. Comparisons in tests should use a tolerance, not strict equality.
- **`waitMs` is rounded up** to whole milliseconds via `Math.ceil`, so a 0.1ms wait is reported as 1ms. This avoids a caller spinning in a tight loop expecting sub-millisecond resolution that most schedulers cannot deliver.

## API

### `new TokenBucket({ capacity, refillRate, now? })`

- `capacity` — positive number, maximum tokens the bucket holds.
- `refillRate` — positive number, tokens added per second.
- `now` — optional `() => number` returning milliseconds. Defaults to `Date.now`.

Throws `RangeError` for non-positive or non-finite `capacity`/`refillRate`, `TypeError` if `now` is not a function.

### `bucket.take(cost = 1)`

Returns `{ allowed: boolean, waitMs: number, remaining: number }`.

- `allowed` is `true` when `cost` tokens were taken.
- `waitMs` is `0` when allowed; otherwise the whole milliseconds until enough tokens exist.
- `remaining` is the token count after the call.

Throws `RangeError` for non-positive or non-finite `cost`.

### `bucket.availableTokens`

Number of tokens after applying pending refill. Mainly useful for inspection and tests.
