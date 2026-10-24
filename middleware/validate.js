// Input validation and sanitization for all backend routes.
// Parameterized queries already prevent SQL injection; this handles
// length limits, type coercion, and stripping unwanted characters.

const { containsBlockedWords, isRestrictedProduct } = require("../lib/moderation");

const PRICE_MAX = 100_000;
const PRICE_MIN = 0;

function str(value, maxLen = 500) {
  if (value == null) return null;
  return String(value)
    .replace(/<[^>]*>/g, "")   // strip HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // strip control chars
    .trim()
    .slice(0, maxLen) || null;
}

function price(value) {
  const n = Number(value);
  if (isNaN(n) || n < PRICE_MIN || n > PRICE_MAX) return null;
  return Math.round(n * 100) / 100; // 2 decimal places max
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

function isValidPhone(phone) {
  if (!phone) return true; // optional
  return /^[+\d\s\-()]{7,20}$/.test(phone);
}

function isValidUuid(id) {
  return typeof id === "string" && id.length <= 128;
}

// ── Route-level validators ────────────────────────────────────────────────────

function validateRegister(req, res, next) {
  const { name, email, password, phone } = req.body;
  if (!str(name, 100))          return res.status(400).json({ error: "Ugyldig navn" });
  if (!isValidEmail(email))     return res.status(400).json({ error: "Ugyldig e-postadresse" });
  if (typeof password !== "string" || password.length < 6 || password.length > 128)
    return res.status(400).json({ error: "Passord må være 6–128 tegn" });
  if (!isValidPhone(phone))     return res.status(400).json({ error: "Ugyldig telefonnummer" });
  req.body.name  = str(name, 100);
  req.body.email = email.toLowerCase().trim();
  req.body.phone = str(phone, 20);
  next();
}

function validateLogin(req, res, next) {
  const { email, password } = req.body;
  if (!isValidEmail(email))     return res.status(400).json({ error: "Ugyldig e-postadresse" });
  if (typeof password !== "string" || password.length > 128)
    return res.status(400).json({ error: "Ugyldig passord" });
  req.body.email = email.toLowerCase().trim();
  next();
}

const CATEGORIES = [
  "bakery", "pasta", "sauce", "canned", "pantry", "breakfast", "snacks",
  "dairy", "frozen", "drinks", "produce", "meat", "other",
];
const STORAGE = ["fridge", "freezer", "pantry"];

function validateListing(req, res, next) {
  const b = req.body;
  const title = str(b.title, 200);
  if (!title) return res.status(400).json({ error: "Tittel er påkrevd (maks 200 tegn)" });
  if (containsBlockedWords(title)) return res.status(400).json({ error: "Tittelen inneholder ord vi ikke tillater." });
  if (isRestrictedProduct(`${title} ${b.brand || ""}`)) {
    return res.status(400).json({ error: "Alkohol, tobakk og legemidler kan ikke deles via Svinn." });
  }

  if (b.category && !CATEGORIES.includes(b.category))
    return res.status(400).json({ error: "Ugyldig kategori" });
  if (b.storage && !STORAGE.includes(b.storage))
    return res.status(400).json({ error: "Ugyldig oppbevaring" });
  if (b.expiry_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.expiry_date)))
    return res.status(400).json({ error: "Ugyldig dato" });

  const dealP = price(b.deal_price);
  if (b.deal_price != null && dealP === null)
    return res.status(400).json({ error: `Pris må være mellom ${PRICE_MIN} og ${PRICE_MAX}` });

  const origP = price(b.original_price ?? b.price);
  if (b.original_price != null && origP === null)
    return res.status(400).json({ error: `Ordinær pris må være mellom ${PRICE_MIN} og ${PRICE_MAX}` });

  const lat = b.lat != null ? Number(b.lat) : null;
  const lng = b.lng != null ? Number(b.lng) : null;
  if (lat !== null && (isNaN(lat) || lat < -90  || lat > 90))  return res.status(400).json({ error: "Ugyldig breddegrad" });
  if (lng !== null && (isNaN(lng) || lng < -180 || lng > 180)) return res.status(400).json({ error: "Ugyldig lengdegrad" });

  const weight = b.weight_g != null ? Math.round(Number(b.weight_g)) : null;
  const productImage = str(b.product_image_url, 500);

  req.body.title       = title;
  req.body.brand       = str(b.brand, 120);
  req.body.category    = b.category || "other";
  req.body.storage     = b.storage || null;
  req.body.address     = str(b.address, 300);
  req.body.area        = str(b.area, 120);
  req.body.barcode     = str(b.barcode, 30);
  req.body.weight_g    = weight && weight > 0 && weight < 100_000 ? weight : null;
  req.body.product_image_url = productImage && productImage.startsWith("https://") ? productImage : null;
  req.body.deal_price     = dealP;
  req.body.original_price = origP;
  req.body.lat = lat;
  req.body.lng = lng;
  next();
}

function validateMessage(req, res, next) {
  const text = str(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: "Meldingen kan ikke være tom" });
  if (containsBlockedWords(text)) {
    return res.status(400).json({ error: "Meldingen inneholder ord vi ikke tillater på Svinn." });
  }
  req.body.text = text;
  next();
}

function validateReport(req, res, next) {
  const { target_type, target_id, reason, note } = req.body;
  const validTypes = ["user", "listing", "deal", "problem"];
  if (!validTypes.includes(target_type)) return res.status(400).json({ error: "Ugyldig rapporttype" });
  const cleanReason = str(reason, 200);
  if (!cleanReason) return res.status(400).json({ error: "Årsak er påkrevd" });
  if (target_id && !isValidUuid(target_id)) return res.status(400).json({ error: "Ugyldig mål-ID" });
  req.body.reason = cleanReason;
  req.body.note   = str(note, 1000);
  req.body.target_id = target_id ? String(target_id).slice(0, 128) : null;
  next();
}

module.exports = { validateRegister, validateLogin, validateListing, validateMessage, validateReport };
