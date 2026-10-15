Add per-API-key rate limiting to the tasklite HTTP server (src/server.js).

Requirements:
- `createServer` accepts two new optional options: `rateLimit: { capacity, refillPerSec }` and `clock` (a function returning the current time in milliseconds, default `Date.now`). When `rateLimit` is not given, behavior and response headers are unchanged.
- Token bucket per API key. Each bucket starts full at `capacity` tokens. Tokens refill continuously at `refillPerSec` tokens per second (fractional refill is fine), up to `capacity`, measured with `clock()`.
- Every authenticated request (valid key, any route or method) costs 1 token. Requests rejected with 401 do not touch any bucket. A request rejected with 429 does not consume a token.
- An allowed request gets the header `X-RateLimit-Remaining`: the whole number of tokens left after this request (rounded down).
- When the bucket has less than 1 token, respond `429` with body `{"error":"rate_limited"}` and header `Retry-After`: whole seconds until 1 token is available, rounded up, at least 1.
- `createServer` throws a `TypeError` if `rateLimit` is given and `capacity` is not a positive integer or `refillPerSec` is not a positive finite number.
- Buckets are independent per key. Memory use must not grow without bound when many different keys are used over time.
- Add tests. Update the README.
