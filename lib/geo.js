const crypto = require("crypto");

// Flytter et punkt 150–350 m i en fast retning per annonse, slik at kartet viser
// omtrentlig sted uten å avsløre adressen. Samme annonse gir alltid samme punkt.
function fuzzLocation(lat, lng, seed) {
  if (lat == null || lng == null) return { lat: null, lng: null };
  const hash = crypto.createHash("sha256").update(String(seed)).digest();
  const angle = (hash.readUInt16BE(0) / 65535) * 2 * Math.PI;
  const meters = 150 + (hash.readUInt16BE(2) / 65535) * 200;
  const dLat = (meters * Math.cos(angle)) / 111_320;
  const dLng = (meters * Math.sin(angle)) / (111_320 * Math.cos((Number(lat) * Math.PI) / 180));
  return {
    lat: Number((Number(lat) + dLat).toFixed(5)),
    lng: Number((Number(lng) + dLng).toFixed(5)),
  };
}

function osloToday() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
}

module.exports = { fuzzLocation, osloToday };
