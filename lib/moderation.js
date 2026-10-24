// Enkelt innholdsfilter for tekst brukere skriver (meldinger, visningsnavn, titler).
// Apple krever filtrering av støtende innhold i apper med brukerinnhold.
const BLOCKED_WORDS = [
  "neger", "nigger", "faggot", "kuksuger", "fitte", "hore",
  "dreper deg", "drep deg", "kill yourself",
];

// Varer som aldri kan deles via Svinn (alkohol, tobakk, legemidler).
const RESTRICTED_PRODUCTS = [
  "alkohol", "vin", "rødvin", "hvitvin", "øl", "pils", "vodka", "whisky", "gin", "likør",
  "cider", "champagne", "prosecco", "akevitt", "snus", "tobakk", "sigarett", "nikotin",
  "vape", "ibux", "paracet", "paracetamol", "ibuprofen", "medisin",
];

// \b fungerer ikke med æøå, så vi lager ordgrenser selv.
function hasWord(text, word) {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9æøå])${escaped}($|[^a-z0-9æøå])`, "i").test(String(text || "").toLowerCase());
}

function containsBlockedWords(text) {
  return BLOCKED_WORDS.some((w) => hasWord(text, w));
}

function isRestrictedProduct(text) {
  return RESTRICTED_PRODUCTS.some((w) => hasWord(text, w));
}

module.exports = { containsBlockedWords, isRestrictedProduct };
