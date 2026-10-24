const router      = require("express").Router();
const requireAuth = require("../middleware/auth");
const { submitReport } = require("../middleware/rateLimit");
const { validateReport } = require("../middleware/validate");
const { v4: uuid } = require("uuid");
const pool        = require("../db");
const { AUTO_SUSPEND_REPORTERS } = require("../lib/config");

// Finner hvilken bruker en rapport egentlig gjelder.
async function reportedUserId(targetType, targetId, reporterId) {
  if (!targetId) return null;
  if (targetType === "user") return targetId;
  if (targetType === "listing") {
    const { rows } = await pool.query("SELECT seller_id FROM listings WHERE id = $1", [targetId]);
    return rows[0]?.seller_id || null;
  }
  if (targetType === "deal") {
    const { rows } = await pool.query("SELECT buyer_id, seller_id FROM deals WHERE id = $1", [targetId]);
    if (!rows.length) return null;
    return rows[0].buyer_id === reporterId ? rows[0].seller_id : rows[0].buyer_id;
  }
  return null;
}

// POST /reports — lagres for manuell gjennomgang. Rapporter fra flere ulike brukere stenger kontoen midlertidig.
router.post("/", requireAuth, submitReport, validateReport, async (req, res) => {
  const { target_type, target_id, reason, note } = req.body;
  try {
    const userId = await reportedUserId(target_type, target_id, req.user.id);
    if (userId === req.user.id) return res.status(400).json({ error: "Du kan ikke rapportere deg selv" });

    await pool.query(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, note, reported_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuid(), req.user.id, target_type, target_id || null, reason, note || null, userId]
    );

    if (userId) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT reporter_id)::int AS n FROM reports
          WHERE created_at > NOW() - INTERVAL '30 days' AND reviewed = FALSE
            AND reported_user_id = $1`,
        [userId]
      );
      if (rows[0].n >= AUTO_SUSPEND_REPORTERS) {
        await pool.query("UPDATE users SET suspended_at = NOW() WHERE id = $1 AND suspended_at IS NULL", [userId]);
        await pool.query("UPDATE listings SET status = 'blocked' WHERE seller_id = $1 AND status = 'active'", [userId]);
        console.warn(`Bruker ${userId} automatisk stengt etter ${rows[0].n} rapporter`);
      }
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

module.exports = router;
