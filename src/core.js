/**
 * A token bucket for rate limiting.
 *
 * The bucket holds up to `capacity` tokens. Tokens refill continuously at a
 * rate of `refillRate` tokens per second. `take()` removes `cost` tokens if
 * available and reports whether the request was allowed and, when denied, how
 * many milliseconds until enough tokens accumulate to satisfy it.
 *
 * Time is obtained from a caller-supplied `now` function (milliseconds since
 * the epoch by convention). Injecting the clock keeps the bucket deterministic
 * and testable without sleeping.
 *
 * Design decisions:
 *
 * - Refill is computed lazily on each `take()` call. We never run a timer in
 *   the background, which means the bucket is safe to construct and ignore; it
 *   does zero work until queried. The cost is that a long-idle bucket refills
 *   to capacity in one step, which is exactly the desired behaviour for a
 *   burst-permitting limiter.
 *
 * - Tokens are stored as a float so fractional refill accumulates correctly.
 *   A bucket refilling at 0.5 tokens/sec would otherwise lose half a token
 *   per second to integer truncation. Comparisons in tests use a tolerance
 *   rather than strict equality because of this.
 *
 * - `take()` never blocks and never waits. When denied it returns the wait
 *   time; the caller decides whether to sleep, reject, or queue. This keeps
 *   the library free of promises or timers and usable from synchronous
 *   call sites.
 */
export class TokenBucket {
  #capacity;
  #refillRate;
  #now;
  #tokens;
  #lastRefillMs;

  /**
   * @param {object} opts
   * @param {number} opts.capacity   Maximum tokens the bucket can hold.
   * @param {number} opts.refillRate  Tokens added per second.
   * @param {() => number} [opts.now] Clock returning ms since epoch. Defaults
   *   to `Date.now`. Inject a fake in tests.
   */
  constructor({ capacity, refillRate, now = Date.now }) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive finite number');
    }
    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      throw new RangeError('refillRate must be a positive finite number');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }

    this.#capacity = capacity;
    this.#refillRate = refillRate;
    this.#now = now;
    // Start full so the first burst of requests up to capacity is allowed,
    // which is the conventional token-bucket semantics: a cold client gets
    // its full allotment immediately, then is throttled to the refill rate.
    this.#tokens = capacity;
    this.#lastRefillMs = now();
  }

  /** Current token count, after applying pending refill. */
  get availableTokens() {
    this.#refill();
    return this.#tokens;
  }

  /**
   * Attempt to remove `cost` tokens.
   *
   * @param {number} [cost=1] Tokens required by this request.
   * @returns {{ allowed: boolean, waitMs: number, remaining: number }}
   *   `allowed` is true when the tokens were taken. `waitMs` is 0 when
   *   allowed; otherwise it is the whole milliseconds until enough tokens
   *   exist to satisfy `cost`. `remaining` is the token count after the call.
   */
  take(cost = 1) {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError('cost must be a positive finite number');
    }

    this.#refill();

    if (this.#tokens >= cost) {
      this.#tokens -= cost;
      return { allowed: true, waitMs: 0, remaining: this.#tokens };
    }

    // How long until the bucket holds enough for this request. Note we
    // compute against `cost`, not the deficit, because the bucket may be
    // partially full: we need (cost - current) more tokens.
    const deficit = cost - this.#tokens;
    const waitSeconds = deficit / this.#refillRate;
    const waitMs = Math.ceil(waitSeconds * 1000);

    return { allowed: false, waitMs, remaining: this.#tokens };
  }

  /**
   * Apply continuous refill up to capacity. Called internally before any
   * read so the bucket reflects elapsed wall time.
   */
  #refill() {
    const t = this.#now();
    const elapsedMs = t - this.#lastRefillMs;
    if (elapsedMs <= 0) {
      // Clock went backwards or stood still. Refill nothing and do not
      // advance the baseline, so a later forward jump is measured from the
      // earlier timestamp. This keeps the bucket stable against minor clock
      // skew (e.g. NTP adjustments).
      return;
    }
    const added = (elapsedMs / 1000) * this.#refillRate;
    this.#tokens = Math.min(this.#capacity, this.#tokens + added);
    this.#lastRefillMs = t;
  }
}
