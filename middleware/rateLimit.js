// In-memory sliding-window rate limiter — no external dependencies.
// Automatically prunes stale entries to prevent memory growth.

const store = new Map();

function getHits(key, windowMs) {
  const now = Date.now();
  const hits = (store.get(key) || []).filter((t) => now - t < windowMs);
  store.set(key, hits);
  return hits;
}

function prune(windowMs) {
  const now = Date.now();
  for (const [key, hits] of store.entries()) {
    if (hits.every((t) => now - t >= windowMs)) store.delete(key);
  }
}

let pruneCounter = 0;

/**
 * @param {number} max         Max requests allowed in the window.
 * @param {number} windowMs    Window duration in milliseconds.
 * @param {function} [keyFn]   (req) => string — defaults to IP address.
 */
let limiterCount = 0;

function rateLimiter(max, windowMs, keyFn) {
  // Hver limiter får sitt eget navnerom – ellers deler f.eks. meldinger og rapporter teller.
  const namespace = ++limiterCount;
  return (req, res, next) => {
    const key = `${namespace}:${keyFn ? keyFn(req) : (req.ip || "unknown")}`;
    const hits = getHits(key, windowMs);

    if (hits.length >= max) {
      const retryAfter = Math.ceil(windowMs / 1000);
      res.setHeader("Retry-After", retryAfter);
      return res.status(429).json({
        error: "For mange forsøk. Vent litt og prøv igjen.",
        retryAfterSeconds: retryAfter,
      });
    }

    hits.push(Date.now());
    store.set(key, hits);

    // Prune every 500 requests to keep memory bounded
    if (++pruneCounter % 500 === 0) prune(windowMs);

    next();
  };
}

// Pre-built limiters for common scenarios
const byIp      = (req) => req.ip || "unknown";
const byUser    = (req) => req.user?.id || req.ip || "unknown";
const byIpRoute = (req) => `${req.ip}:${req.path}`;

module.exports = {
  rateLimiter,
  // Auth: strict — prevents brute-force and account enumeration
  authLogin:    rateLimiter(5,  15 * 60 * 1000, byIp),
  authRegister: rateLimiter(3,  60 * 60 * 1000, byIp),
  authApple:    rateLimiter(20, 15 * 60 * 1000, byIp),
  // Write endpoints: per-user to allow normal usage but stop automation
  createListing: rateLimiter(30, 60 * 60 * 1000, byUser),
  createDeal:    rateLimiter(15, 60 * 60 * 1000, byUser),
  sendMessage:   rateLimiter(40, 60 * 1000,       byUser),
  submitReport:  rateLimiter(5,  60 * 60 * 1000,  byUser),
  dealAction:    rateLimiter(60, 60 * 60 * 1000,  byUser),
  // General reads: generous but stops scrapers
  readGeneral:   rateLimiter(300, 60 * 1000, byIp),
};
