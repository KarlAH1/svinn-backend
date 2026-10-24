const router  = require("express").Router();
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const pool    = require("../db");
const { authLogin, authRegister, authApple } = require("../middleware/rateLimit");
const { validateLogin, validateRegister } = require("../middleware/validate");
const { verifyIdentityToken, exchangeAuthorizationCode } = require("../lib/apple");
const { ALLOW_PASSWORD_AUTH } = require("../lib/config");
const { containsBlockedWords } = require("../lib/moderation");

function token(user) {
  return jwt.sign(
    { id: user.id, name: user.name, display_name: user.display_name },
    process.env.JWT_SECRET,
    { expiresIn: "90d" }
  );
}

function passwordAuthGuard(req, res, next) {
  if (!ALLOW_PASSWORD_AUTH) return res.status(410).json({ error: "Logg inn med Apple i den nyeste versjonen av Svinn." });
  next();
}

// POST /auth/apple — Sign in with Apple
router.post("/apple", authApple, async (req, res) => {
  const { identityToken, authorizationCode, fullName } = req.body || {};
  if (typeof identityToken !== "string" || identityToken.length > 5000) {
    return res.status(400).json({ error: "Mangler Apple-token" });
  }

  let claims;
  try {
    claims = await verifyIdentityToken(identityToken);
  } catch (err) {
    console.warn("Apple-verifisering feilet:", err.message);
    return res.status(401).json({ error: "Kunne ikke bekrefte Apple-innloggingen" });
  }

  // Apple sender bare navnet første gang brukeren logger inn.
  const given  = String(fullName?.givenName || "").trim().slice(0, 50);
  const family = String(fullName?.familyName || "").trim().slice(0, 50);
  const name   = [given, family].filter(Boolean).join(" ");
  const email  = typeof claims.email === "string" ? claims.email.toLowerCase() : null;

  try {
    const { rows: existing } = await pool.query("SELECT * FROM users WHERE apple_sub = $1", [claims.sub]);
    let user = existing[0];
    let isNew = false;

    if (!user) {
      isNew = true;
      const id = uuid();
      const safeName = name && !containsBlockedWords(name) ? name : null;
      // Vi slår aldri sammen med eksisterende kontoer på e-post – det ville åpnet for kontoovertakelse.
      const { rows: emailTaken } = email
        ? await pool.query("SELECT 1 FROM users WHERE email = $1", [email])
        : { rows: [] };
      const { rows } = await pool.query(
        `INSERT INTO users (id, name, display_name, email, apple_sub, role, can_buy, can_sell, seller_verified)
         VALUES ($1, $2, $3, $4, $5, 'both', TRUE, TRUE, TRUE)
         RETURNING *`,
        [id, safeName || "Ny bruker", safeName ? given || safeName : null, emailTaken.length ? null : email, claims.sub]
      );
      user = rows[0];
    } else if (name && !user.display_name) {
      const { rows } = await pool.query(
        "UPDATE users SET name = $1, display_name = $2 WHERE id = $3 RETURNING *",
        [name, given || name, user.id]
      );
      user = rows[0];
    }

    // Lagre refresh token så vi kan tilbakekalle Apple-tilgangen ved kontosletting.
    exchangeAuthorizationCode(authorizationCode)
      .then((refresh) => refresh && pool.query("UPDATE users SET apple_refresh_token = $1 WHERE id = $2", [refresh, user.id]))
      .catch(() => {});

    res.json({
      token: token(user),
      isNew,
      user: {
        id: user.id,
        name: user.name,
        display_name: user.display_name,
        tos_accepted: user.tos_accepted,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /auth/register — kun utvikling
router.post("/register", passwordAuthGuard, authRegister, validateRegister, async (req, res) => {
  const { name, email, password, phone } = req.body;
  try {
    const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length) return res.status(409).json({ error: "E-postadressen er allerede i bruk" });

    const id   = uuid();
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      "INSERT INTO users (id, name, display_name, email, phone, password_hash, can_sell, seller_verified) VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE)",
      [id, name, name, email, phone || null, hash]
    );
    const user = { id, name, display_name: name, email };
    res.status(201).json({ user, token: token(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /auth/login — kun utvikling
router.post("/login", passwordAuthGuard, authLogin, validateLogin, async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: "Feil e-post eller passord" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Feil e-post eller passord" });

    const safe = { id: user.id, name: user.name, display_name: user.display_name, email: user.email };
    res.json({ user: safe, token: token(safe) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// PATCH /auth/accept-tos
router.patch("/accept-tos", require("../middleware/auth"), async (req, res) => {
  try {
    await pool.query(
      "UPDATE users SET tos_accepted = TRUE, tos_accepted_at = NOW() WHERE id = $1",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

module.exports = router;
