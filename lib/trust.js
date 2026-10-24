// Felles regler for tillit: utestengelse, blokkering og uteblivelser.
const pool = require("../db");
const { MAX_NO_SHOWS_30D } = require("./config");

async function getTrustState(userId) {
  const { rows } = await pool.query(
    `SELECT u.suspended_at,
            (SELECT COUNT(*)::int FROM deals d
              WHERE d.status = 'no_show'
                AND d.created_at > NOW() - INTERVAL '30 days'
                AND ((d.no_show_party = 'buyer' AND d.buyer_id = u.id)
                  OR (d.no_show_party = 'seller' AND d.seller_id = u.id))) AS no_shows_30d
       FROM users u WHERE u.id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const { suspended_at, no_shows_30d } = rows[0];
  return {
    suspended: Boolean(suspended_at),
    noShows30d: no_shows_30d,
    blockedByNoShows: no_shows_30d >= MAX_NO_SHOWS_30D,
  };
}

// Returnerer en feilmelding hvis brukeren ikke kan reservere eller dele mat, ellers null.
async function tradingBlockReason(userId) {
  const state = await getTrustState(userId);
  if (!state) return "Fant ikke kontoen din. Logg inn på nytt.";
  if (state.suspended) return "Kontoen din er midlertidig stengt mens vi ser på en rapport. Kontakt oss hvis du mener dette er feil.";
  if (state.blockedByNoShows) return `Du har uteblitt fra ${state.noShows30d} hentinger de siste 30 dagene, og kan ikke reservere før det har gått litt tid.`;
  return null;
}

async function isBlockedBetween(a, b) {
  const { rows } = await pool.query(
    "SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1",
    [a, b]
  );
  return rows.length > 0;
}

module.exports = { getTrustState, tradingBlockReason, isBlockedBetween };
