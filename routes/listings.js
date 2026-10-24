const router      = require("express").Router();
const requireAuth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");
const { v4: uuid } = require("uuid");
const pool        = require("../db");
const { createListing } = require("../middleware/rateLimit");
const { validateListing } = require("../middleware/validate");
const { PUBLIC_LISTING_COLUMNS, publicListing, ownListing } = require("../lib/shape");
const { osloToday } = require("../lib/geo");
const { tradingBlockReason } = require("../lib/trust");
const { FREE_ONLY } = require("../lib/config");

const MAX_IMAGE_BYTES = 1_500_000;

function decodeImage(img) {
  if (!img || typeof img.data !== "string") return null;
  const buf = Buffer.from(img.data, "base64");
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng  = buf[0] === 0x89 && buf[1] === 0x50;
  if (!isJpeg && !isPng) return null;
  return { kind: img.kind, data: buf, mime: isJpeg ? "image/jpeg" : "image/png" };
}

// GET /listings/seller/mine — mine annonser, med full adresse
router.get("/seller/mine", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_LISTING_COLUMNS}, l.address,
              (SELECT d.id FROM deals d WHERE d.listing_id = l.id
                 AND d.status IN ('reserved','confirmed','delayed') LIMIT 1) AS active_deal_id
         FROM listings l JOIN users u ON u.id = l.seller_id
        WHERE l.seller_id = $1 AND l.status <> 'withdrawn'
        ORDER BY l.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json(rows.map(ownListing));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// GET /listings — aktive annonser. Adresse og eksakt posisjon sendes aldri.
router.get("/", optionalAuth, async (req, res) => {
  const { category } = req.query;
  try {
    const args = [osloToday()];
    let sql = `SELECT ${PUBLIC_LISTING_COLUMNS}
                 FROM listings l JOIN users u ON u.id = l.seller_id
                WHERE l.status = 'active'
                  AND (l.pickup_deadline IS NULL OR l.pickup_deadline > NOW())
                  AND (l.expiry_date IS NULL OR l.expiry_date >= $1::date)
                  AND u.suspended_at IS NULL`;
    if (category) {
      args.push(String(category));
      sql += ` AND l.category = $${args.length}`;
    }
    if (req.user) {
      args.push(req.user.id);
      sql += ` AND NOT EXISTS (SELECT 1 FROM blocks b
                 WHERE (b.blocker_id = $${args.length} AND b.blocked_id = l.seller_id)
                    OR (b.blocked_id = $${args.length} AND b.blocker_id = l.seller_id))`;
    }
    sql += " ORDER BY l.expiry_date ASC NULLS LAST, l.created_at DESC LIMIT 200";

    const { rows } = await pool.query(sql, args);
    res.json(rows.map(publicListing));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// GET /listings/:id
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_LISTING_COLUMNS}, l.address
         FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Ikke funnet" });
    const row = rows[0];
    res.json(req.user?.id === row.seller_id ? ownListing(row) : publicListing(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /listings — publiser. Reglene håndheves her, ikke bare i appen.
router.post("/", requireAuth, createListing, validateListing, async (req, res) => {
  const b = req.body;

  const blockReason = await tradingBlockReason(req.user.id).catch(() => "Serverfeil");
  if (blockReason) return res.status(403).json({ error: blockReason });

  if (b.is_opened || b.is_homemade) {
    return res.status(400).json({ error: "Svinn er kun for uåpnede varer i originalemballasje, kjøpt i butikk." });
  }
  if (!b.expiry_date) return res.status(400).json({ error: "Datomerkingen mangler." });
  if (b.expiry_date < osloToday()) {
    return res.status(400).json({ error: "Varen har gått ut på dato og kan ikke deles." });
  }
  const deadline = b.pickup_deadline ? new Date(b.pickup_deadline) : null;
  if (!deadline || isNaN(deadline) || deadline <= new Date() || deadline > new Date(Date.now() + 8 * 86400000)) {
    return res.status(400).json({ error: "Velg et hentevindu de neste dagene." });
  }
  if (b.lat == null || b.lng == null || !b.address) {
    return res.status(400).json({ error: "Hentestedet mangler." });
  }

  const images = (Array.isArray(b.images) ? b.images.slice(0, 4) : []).map(decodeImage);
  if (images.some((img) => !img)) return res.status(400).json({ error: "Et av bildene kunne ikke leses. Prøv igjen." });
  if (!images.some((img) => img.kind === "front") || !images.some((img) => img.kind === "date")) {
    return res.status(400).json({ error: "Vi trenger bilde av forsiden og av datomerkingen." });
  }

  const dealPrice = FREE_ONLY ? 0 : (b.deal_price ?? 0);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = uuid();
    await client.query(
      `INSERT INTO listings
        (id, seller_id, title, brand, category, original_price, deal_price, price,
         address, area, lat, lng, expiry_date, pickup_deadline, storage, barcode,
         product_image_url, weight_g, is_opened, is_homemade, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,FALSE,FALSE,'active')`,
      [
        id, req.user.id, b.title, b.brand, b.category, b.original_price, dealPrice,
        b.address, b.area, b.lat, b.lng, b.expiry_date, deadline.toISOString(), b.storage, b.barcode,
        b.product_image_url, b.weight_g,
      ]
    );
    for (const [sort, img] of images.entries()) {
      await client.query(
        "INSERT INTO listing_images (listing_id, kind, mime, data, sort) VALUES ($1,$2,$3,$4,$5)",
        [id, img.kind, img.mime, img.data, sort]
      );
    }
    await client.query("COMMIT");

    const { rows } = await pool.query(
      `SELECT ${PUBLIC_LISTING_COLUMNS}, l.address FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
      [id]
    );
    res.status(201).json(ownListing(rows[0]));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  } finally {
    client.release();
  }
});

// PATCH /listings/:id/status — selger kan trekke tilbake en aktiv annonse
router.patch("/:id/status", requireAuth, async (req, res) => {
  const { status } = req.body;
  if (status !== "withdrawn") return res.status(400).json({ error: "Ugyldig status" });

  try {
    const { rows } = await pool.query(
      `UPDATE listings SET status = 'withdrawn'
        WHERE id = $1 AND seller_id = $2 AND status = 'active'
        RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) {
      return res.status(409).json({ error: "Annonsen kan ikke trekkes nå. Er den reservert, må du avlyse avtalen først." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

module.exports = router;
