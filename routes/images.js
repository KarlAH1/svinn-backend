const router = require("express").Router();
const pool   = require("../db");

// GET /images/:id — bilder lagret i databasen. ID-ene er tilfeldige UUID-er og endres aldri.
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT mime, data FROM listing_images WHERE id = $1", [String(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: "Ikke funnet" });
    res.setHeader("Content-Type", rows[0].mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(rows[0].data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

module.exports = router;
