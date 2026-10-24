require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const pool    = require("./db");
const { rateLimiter } = require("./middleware/rateLimit");

const app = express();

// Render ligger bak en proxy. Uten dette deler alle brukere samme IP i rate-limiteren.
app.set("trust proxy", 1);

// ── Sikkerhetshoder ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Native mobile apps send no Origin — allow them unconditionally
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("CORS ikke tillatt"));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// ── Body parsing – liten grense hindrer payload-angrep ───────────────────────
// Unntak: publisering av annonse, som har med komprimerte bilder.
const smallJson = express.json({ limit: "100kb" });
const listingJson = express.json({ limit: "6mb" });
app.use((req, res, next) =>
  (req.method === "POST" && req.path === "/listings" ? listingJson : smallJson)(req, res, next)
);

// ── Global rate limit – stopper skrapere og DoS-forsøk ───────────────────────
app.use(rateLimiter(300, 60 * 1000)); // 300 req/min per IP

// ── Auto-migrering ────────────────────────────────────────────────────────────
async function migrate() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    // Fjern kommentarlinjer først – ellers hoppes setninger med kommentar foran over.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const client = await pool.connect();
    try {
      for (const stmt of statements) {
        try {
          await client.query(stmt);
        } catch (err) {
          if (!err.message.includes("already exists")) {
            console.warn("Migrering hopper over:", err.message);
          }
        }
      }
      console.log("Databaseskjema OK");
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Kunne ikke kjøre migrering (DB utilgjengelig?):", err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",     require("./routes/auth"));
app.use("/users",    require("./routes/users"));
app.use("/listings", require("./routes/listings"));
app.use("/deals",    require("./routes/deals"));
app.use("/reports",  require("./routes/reports"));
app.use("/images",   require("./routes/images"));
app.use("/products", require("./routes/products"));
app.use("/",         require("./routes/pages"));

// ── Produktbrytere appen leser ved oppstart ───────────────────────────────────
const { FREE_ONLY, SUBSCRIPTION_ENABLED } = require("./lib/config");
app.get("/config", (req, res) => res.json({
  freeOnly: FREE_ONLY,
  subscriptionEnabled: SUBSCRIPTION_ENABLED,
  minAppVersion: "1.0.5",
}));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Ikke funnet" }));

// ── Global feilhåndtering ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.message === "CORS ikke tillatt") return res.status(403).json({ error: err.message });
  console.error("Uhåndtert feil:", err.message);
  res.status(500).json({ error: "Intern serverfeil" });
});

const PORT = process.env.PORT || 3000;
migrate()
  .catch((err) => console.error("Migrering feilet fullstendig:", err.message))
  .finally(() => {
    app.listen(PORT, () => console.log(`Svinn API kjører på http://localhost:${PORT}`));
  });
