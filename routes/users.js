const router      = require("express").Router();
const requireAuth = require("../middleware/auth");
const pool        = require("../db");
const { getTrustState } = require("../lib/trust");
const { revokeRefreshToken } = require("../lib/apple");
const { containsBlockedWords } = require("../lib/moderation");
const { firstName } = require("../lib/shape");
const { MAX_NO_SHOWS_30D } = require("../lib/config");

// Grovt anslag: ~2,5 kg CO₂e per kg mat som ikke kastes. Vises alltid som «ca.» i appen.
const CO2_PER_KG = 2.5;
const DEFAULT_WEIGHT_G = 500;

async function impactFor(userId) {
  const { rows } = await pool.query(
    `SELECT
        COUNT(*)::int AS rescued,
        COUNT(*) FILTER (WHERE d.buyer_id = $1)::int AS received,
        COUNT(*) FILTER (WHERE d.seller_id = $1)::int AS given,
        COALESCE(SUM(CASE WHEN d.buyer_id = $1 THEN COALESCE(d.original_price, 0) - COALESCE(d.deal_price, 0) END), 0)::float AS money_saved,
        COALESCE(SUM(COALESCE(l.weight_g, $2)), 0)::int AS grams
       FROM deals d JOIN listings l ON l.id = d.listing_id
      WHERE d.status = 'completed' AND (d.buyer_id = $1 OR d.seller_id = $1)`,
    [userId, DEFAULT_WEIGHT_G]
  );
  const r = rows[0];
  const kg = r.grams / 1000;
  return {
    rescued: r.rescued,
    received: r.received,
    given: r.given,
    money_saved: Math.round(r.money_saved),
    kg: Math.round(kg * 10) / 10,
    co2_kg: Math.round(kg * CO2_PER_KG * 10) / 10,
  };
}

const ME_COLUMNS = `id, name, display_name, email, tos_accepted,
  buyer_rating, seller_rating, buyer_rating_count, seller_rating_count, created_at`;

// GET /users/me
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${ME_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Ikke funnet" });
    const [impact, trust] = await Promise.all([impactFor(req.user.id), getTrustState(req.user.id)]);
    res.json({ ...rows[0], impact, trust: { ...trust, maxNoShows: MAX_NO_SHOWS_30D } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// PATCH /users/me — visningsnavn
router.patch("/me", requireAuth, async (req, res) => {
  const displayName = String(req.body?.display_name || "").replace(/[<>]/g, "").trim().slice(0, 40);
  if (displayName.length < 2) return res.status(400).json({ error: "Skriv inn navnet ditt" });
  if (containsBlockedWords(displayName)) return res.status(400).json({ error: "Velg et annet navn" });
  try {
    await pool.query(
      `UPDATE users SET display_name = $1, name = CASE WHEN name = 'Ny bruker' THEN $1 ELSE name END WHERE id = $2`,
      [displayName, req.user.id]
    );
    const { rows } = await pool.query(`SELECT ${ME_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// DELETE /users/me — sletter kontoen og alt innhold permanent
router.delete("/me", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT apple_refresh_token FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Ikke funnet" });

    await client.query("BEGIN");
    // Varer andre har reservert fra meg forsvinner med kontoen. Varer jeg har reservert hos andre frigjøres.
    await client.query(
      `UPDATE listings SET status = 'active'
        WHERE pickup_deadline > NOW() AND id IN (
          SELECT listing_id FROM deals WHERE buyer_id = $1 AND status IN ('reserved','confirmed','delayed'))`,
      [req.user.id]
    );
    await client.query("DELETE FROM reports WHERE reporter_id = $1", [req.user.id]);
    await client.query("DELETE FROM users WHERE id = $1", [req.user.id]);
    await client.query("COMMIT");

    revokeRefreshToken(rows[0].apple_refresh_token).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  } finally {
    client.release();
  }
});

// POST /users/push-token — registrer push-token
router.post("/push-token", requireAuth, async (req, res) => {
  const { token, platform } = req.body;
  if (!token || typeof token !== "string" || token.length > 300) return res.status(400).json({ error: "Token er påkrevd" });
  try {
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = $1, platform = $3`,
      [req.user.id, token, platform || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// GET /users/me/blocks
router.get("/me/blocks", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({ id: r.id, name: firstName(r.display_name) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /users/:id/block — blokkerer og avlyser åpne avtaler mellom dere
router.post("/:id/block", requireAuth, async (req, res) => {
  const target = String(req.params.id);
  if (target === req.user.id) return res.status(400).json({ error: "Du kan ikke blokkere deg selv" });
  try {
    await pool.query(
      "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.user.id, target]
    );
    const { rows: open } = await pool.query(
      `UPDATE deals SET status = 'cancelled', cancel_reason = 'Avlyst etter blokkering'
        WHERE status IN ('reserved','confirmed','delayed')
          AND ((buyer_id = $1 AND seller_id = $2) OR (buyer_id = $2 AND seller_id = $1))
        RETURNING listing_id`,
      [req.user.id, target]
    );
    if (open.length) {
      await pool.query(
        "UPDATE listings SET status = 'withdrawn' WHERE id = ANY($1)",
        [open.map((r) => r.listing_id)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// DELETE /users/:id/block
router.delete("/:id/block", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2", [req.user.id, String(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// GET /users/:id — offentlig profil (kun fornavn)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, display_name, seller_rating, seller_rating_count, buyer_rating, buyer_rating_count, created_at
         FROM users WHERE id = $1 AND suspended_at IS NULL`,
      [String(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: "Ikke funnet" });
    const u = rows[0];
    const impact = await impactFor(u.id);
    res.json({
      id: u.id,
      first_name: firstName(u.display_name),
      seller_rating: u.seller_rating != null ? Number(u.seller_rating) : null,
      seller_rating_count: u.seller_rating_count || 0,
      buyer_rating: u.buyer_rating != null ? Number(u.buyer_rating) : null,
      buyer_rating_count: u.buyer_rating_count || 0,
      rescued: impact.rescued,
      member_since: u.created_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

module.exports = router;
