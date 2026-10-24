// Strekkodeoppslag via Kassalapp. Nøkkelen ligger kun på serveren (KASSALAPP_API_KEY),
// og svarene caches, så vi holder oss godt under 60 kall i minuttet.
const router = require("express").Router();
const pool   = require("../db");
const { rateLimiter } = require("../middleware/rateLimit");
const { cutout } = require("../lib/cutout");

const HIT_TTL_DAYS = 14;
const MISS_TTL_HOURS = 24;
const lookupLimit = rateLimiter(30, 60 * 1000);

function priceOf(p) {
  if (typeof p.current_price === "number") return p.current_price;
  if (p.current_price && typeof p.current_price.price === "number") return p.current_price.price;
  return null;
}

// EAN-endepunktet gir { data: { ean, products: [...per butikk], allergens } }. Vi slår sammen til ett produkt.
function normalize(data) {
  const list = Array.isArray(data?.products) ? data.products : data?.name ? [data] : [];
  const products = list.filter((p) => p?.name);
  if (!products.length) return null;
  const best = products.find((p) => priceOf(p) != null && p.image) || products.find((p) => p.image) || products[0];
  const prices = products.map(priceOf).filter((x) => x != null).sort((a, b) => a - b);
  return {
    ean: data.ean,
    name: best.name,
    brand: best.brand || null,
    vendor: best.vendor || null,
    image: best.image || null,
    category: best.category || null,
    // Median av butikkprisene gir et rimelig «butikkpris»-anslag.
    current_price: prices.length ? prices[Math.floor(prices.length / 2)] : null,
    weight: best.weight ?? null,
    weight_unit: best.weight_unit ?? null,
    allergens: (data.allergens || []).filter((a) => a?.contains === "YES").map((a) => a.display_name || a.code),
  };
}

// GET /products/ean/:ean
router.get("/ean/:ean", lookupLimit, async (req, res) => {
  const ean = String(req.params.ean);
  if (!/^\d{8,14}$/.test(ean)) return res.status(400).json({ error: "Ugyldig strekkode" });

  try {
    const { rows } = await pool.query(
      `SELECT product FROM product_cache WHERE ean = $1
         AND fetched_at > NOW() - (CASE WHEN product IS NULL THEN INTERVAL '${MISS_TTL_HOURS} hours' ELSE INTERVAL '${HIT_TTL_DAYS} days' END)`,
      [ean]
    );
    if (rows.length) {
      return rows[0].product ? res.json(rows[0].product) : res.status(404).json({ error: "Fant ikke varen" });
    }

    // Tåler at nøkkelen er limt inn med mellomrom, linjeskift, anførselstegn eller «Bearer » foran.
    const key = String(process.env.KASSALAPP_API_KEY || "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "");
    if (!key) return res.status(503).json({ error: "Produktoppslag er ikke satt opp", reason: "key_missing" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(`https://kassal.app/api/v1/products/ean/${ean}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (upstream.status === 401) {
      console.error("KASSALAPP_API_KEY er ugyldig eller utløpt (401 fra Kassalapp)");
      return res.status(503).json({ error: "Produktoppslag er ikke satt opp", reason: "key_rejected" });
    }
    if (upstream.status === 429) return res.status(503).json({ error: "Produktoppslaget er travelt. Prøv igjen om litt." });
    if (upstream.status === 404) {
      await pool.query(
        "INSERT INTO product_cache (ean, product, fetched_at) VALUES ($1, NULL, NOW()) ON CONFLICT (ean) DO UPDATE SET product = NULL, fetched_at = NOW()",
        [ean]
      );
      return res.status(404).json({ error: "Fant ikke varen" });
    }
    if (!upstream.ok) {
      console.error(`Kassalapp svarte ${upstream.status} for ${ean}: ${(await upstream.text()).slice(0, 200)}`);
      return res.status(502).json({ error: "Produktoppslaget svarte ikke", upstream: upstream.status });
    }

    const body = await upstream.json();
    const product = normalize(body.data);
    await pool.query(
      "INSERT INTO product_cache (ean, product, fetched_at) VALUES ($1, $2, NOW()) ON CONFLICT (ean) DO UPDATE SET product = $2, fetched_at = NOW()",
      [ean, product ? JSON.stringify(product) : null]
    );
    if (!product) return res.status(404).json({ error: "Fant ikke varen" });
    res.json(product);
  } catch (err) {
    console.error("Kassalapp-oppslag feilet:", err.message);
    // Vis bare feiltype, aldri detaljer som kan avsløre infrastruktur (f.eks. databaseadresse).
    const reason = err.name === "AbortError" ? "timeout" : err.message === "fetch failed" ? `kassalapp:${err.cause?.code || "nett"}` : "server";
    res.status(502).json({ error: "Produktoppslaget svarte ikke", reason });
  }
});

// GET /products/image/:ean — produktbildet uten bakgrunn. Lages én gang og lagres.
// Henter bare bildeadresser som kom fra Kassalapp (product_cache), aldri fra brukerinput.
const imageLimit = rateLimiter(120, 60 * 1000);
router.get("/image/:ean", imageLimit, async (req, res) => {
  const ean = String(req.params.ean);
  if (!/^\d{8,14}$/.test(ean)) return res.status(400).json({ error: "Ugyldig strekkode" });

  const send = (png) => {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=2592000");
    res.send(png);
  };

  try {
    const { rows: done } = await pool.query("SELECT png FROM product_cutouts WHERE ean = $1", [ean]);
    if (done.length) return done[0].png ? send(done[0].png) : res.status(404).json({ error: "Ingen utklipp" });

    const { rows } = await pool.query("SELECT product->>'image' AS image FROM product_cache WHERE ean = $1", [ean]);
    const url = rows[0]?.image;
    if (!url || !url.startsWith("https://")) return res.status(404).json({ error: "Ingen produktbilde" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
    const type = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !type.startsWith("image/")) return res.status(404).json({ error: "Fant ikke bildet" });
    const original = Buffer.from(await upstream.arrayBuffer());
    if (original.length > 8_000_000) return res.status(404).json({ error: "Bildet er for stort" });

    const png = await cutout(original);
    await pool.query(
      "INSERT INTO product_cutouts (ean, png) VALUES ($1, $2) ON CONFLICT (ean) DO UPDATE SET png = $2, created_at = NOW()",
      [ean, png]
    );
    if (!png) return res.status(404).json({ error: "Ingen utklipp" });
    send(png);
  } catch (err) {
    console.error("Utklipp feilet:", err.message);
    res.status(502).json({ error: "Kunne ikke lage bildet" });
  }
});

module.exports = router;
