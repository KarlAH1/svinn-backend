// Sign in with Apple: verifisering av identity token, og (valgfritt) tilbakekalling ved kontosletting.
const crypto = require("crypto");
const jwt    = require("jsonwebtoken");
const { APPLE_BUNDLE_ID } = require("./config");

const APPLE_ISSUER = "https://appleid.apple.com";
let jwksCache = { keys: [], fetchedAt: 0 };

async function getAppleKeys(force = false) {
  const fresh = Date.now() - jwksCache.fetchedAt < 6 * 60 * 60 * 1000;
  if (!force && fresh && jwksCache.keys.length) return jwksCache.keys;
  const res = await fetch(`${APPLE_ISSUER}/auth/keys`);
  if (!res.ok) throw new Error("Kunne ikke hente Apple-nøkler");
  const { keys } = await res.json();
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyIdentityToken(identityToken) {
  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded?.header?.kid) throw new Error("Ugyldig Apple-token");

  let keys = await getAppleKeys();
  let jwk = keys.find((k) => k.kid === decoded.header.kid);
  if (!jwk) {
    keys = await getAppleKeys(true);
    jwk = keys.find((k) => k.kid === decoded.header.kid);
  }
  if (!jwk) throw new Error("Ukjent Apple-nøkkel");

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return jwt.verify(identityToken, publicKey, {
    algorithms: ["RS256"],
    issuer: APPLE_ISSUER,
    audience: APPLE_BUNDLE_ID,
  });
}

// Token-utveksling og tilbakekalling krever en Sign in with Apple-nøkkel (.p8) fra Apple Developer.
// Uten disse miljøvariablene hopper vi stille over – innlogging fungerer uansett.
function hasServerCredentials() {
  return Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
}

function clientSecret() {
  const privateKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  return jwt.sign({}, privateKey, {
    algorithm: "ES256",
    expiresIn: "5m",
    issuer: process.env.APPLE_TEAM_ID,
    audience: APPLE_ISSUER,
    subject: APPLE_BUNDLE_ID,
    keyid: process.env.APPLE_KEY_ID,
  });
}

async function exchangeAuthorizationCode(code) {
  if (!code || !hasServerCredentials()) return null;
  const res = await fetch(`${APPLE_ISSUER}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APPLE_BUNDLE_ID,
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.refresh_token || null;
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken || !hasServerCredentials()) return;
  await fetch(`${APPLE_ISSUER}/auth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APPLE_BUNDLE_ID,
      client_secret: clientSecret(),
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
  });
}

module.exports = { verifyIdentityToken, exchangeAuthorizationCode, revokeRefreshToken };
