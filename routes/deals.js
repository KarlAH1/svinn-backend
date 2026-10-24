const router      = require("express").Router();
const requireAuth = require("../middleware/auth");
const { v4: uuid } = require("uuid");
const pool        = require("../db");
const { createDeal, sendMessage, dealAction } = require("../middleware/rateLimit");
const { validateMessage } = require("../middleware/validate");
const { dealFor, DEAL_SELECT, firstName } = require("../lib/shape");
const { tradingBlockReason, isBlockedBetween } = require("../lib/trust");
const { sendPush } = require("../lib/push");

const OPEN_STATUSES = ["reserved", "confirmed", "delayed"];

function formatTime(date) {
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(date));
}

async function loadDeal(dealId, userId) {
  const { rows } = await pool.query(`${DEAL_SELECT} WHERE d.id = $2`, [userId, dealId]);
  const row = rows[0];
  if (!row || (row.buyer_id !== userId && row.seller_id !== userId)) return null;
  return row;
}

async function systemMessage(dealId, senderId, text) {
  await pool.query(
    "INSERT INTO messages (id, deal_id, sender_id, text, kind) VALUES ($1,$2,$3,$4,'system')",
    [uuid(), dealId, senderId, text]
  );
}

function otherParty(row, userId) {
  return row.buyer_id === userId ? row.seller_id : row.buyer_id;
}

function myName(row, userId) {
  return firstName(row.buyer_id === userId ? row.buyer_name : row.seller_name);
}

// Rydder opp avtaler som har blitt hengende. Kjøres lat ved henting av avtaler.
async function sweep() {
  // Reservert uten avtalt tid, og hentevinduet er ute → avlyst.
  await pool.query(
    `WITH expired AS (
       UPDATE deals SET status = 'cancelled', cancel_reason = 'Hentevinduet gikk ut før dere avtalte tid'
        WHERE status = 'reserved' AND pickup_deadline < NOW()
        RETURNING listing_id)
     UPDATE listings SET status = 'expired' WHERE id IN (SELECT listing_id FROM expired)`
  );
  // Én part har bekreftet henting, og det har gått et døgn → fullført.
  await pool.query(
    `WITH done AS (
       UPDATE deals SET status = 'completed', completed_at = NOW()
        WHERE status IN ('confirmed','delayed')
          AND (completion_confirmed_by_buyer OR completion_confirmed_by_seller)
          AND COALESCE(meetup_at, pickup_deadline) < NOW() - INTERVAL '24 hours'
        RETURNING listing_id)
     UPDATE listings SET status = 'completed' WHERE id IN (SELECT listing_id FROM done)`
  );
}

// GET /deals — mine avtaler (aktive + siste 90 dager)
router.get("/", requireAuth, async (req, res) => {
  try {
    await sweep().catch((err) => console.warn("Sweep feilet:", err.message));
    const { rows } = await pool.query(
      `${DEAL_SELECT}
        WHERE (d.buyer_id = $1 OR d.seller_id = $1)
          AND (d.status = ANY($2) OR d.created_at > NOW() - INTERVAL '90 days')
        ORDER BY d.created_at DESC LIMIT 100`,
      [req.user.id, OPEN_STATUSES]
    );
    res.json(rows.map((r) => dealFor(r, req.user.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// GET /deals/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const row = await loadDeal(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Ikke funnet" });
    res.json(dealFor(row, req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /deals — reserver. Atomisk: kun én kjøper kan vinne.
router.post("/", requireAuth, createDeal, async (req, res) => {
  const { listing_id, proposed_at } = req.body;
  if (!listing_id) return res.status(400).json({ error: "listing_id er påkrevd" });

  try {
    const blockReason = await tradingBlockReason(req.user.id);
    if (blockReason) return res.status(403).json({ error: blockReason });

    const { rows: found } = await pool.query("SELECT seller_id FROM listings WHERE id = $1", [listing_id]);
    if (!found.length) return res.status(404).json({ error: "Fant ikke varen" });
    if (found[0].seller_id === req.user.id) return res.status(400).json({ error: "Dette er din egen vare" });
    if (await isBlockedBetween(req.user.id, found[0].seller_id)) {
      return res.status(403).json({ error: "Du kan ikke reservere denne varen." });
    }

    const client = await pool.connect();
    let dealId;
    let listing;
    try {
      await client.query("BEGIN");
      const { rows: claimed } = await client.query(
        `UPDATE listings SET status = 'reserved'
          WHERE id = $1 AND status = 'active' AND pickup_deadline > NOW()
          RETURNING *`,
        [listing_id]
      );
      if (!claimed.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Noen andre rakk å reservere denne. Det dukker opp mer mat hele tiden!" });
      }
      listing = claimed[0];

      let proposal = proposed_at ? new Date(proposed_at) : null;
      if (proposal && (isNaN(proposal) || proposal > new Date(listing.pickup_deadline))) proposal = null;

      dealId = uuid();
      await client.query(
        `INSERT INTO deals
          (id, listing_id, buyer_id, seller_id, title, category, address,
           deal_price, original_price, pickup_deadline, proposed_at, proposed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          dealId, listing_id, req.user.id, listing.seller_id, listing.title, listing.category,
          listing.address, listing.deal_price, listing.original_price, listing.pickup_deadline,
          proposal ? proposal.toISOString() : null, proposal ? "buyer" : null,
        ]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const row = await loadDeal(dealId, req.user.id);
    const buyer = myName(row, req.user.id);
    const when = row.proposed_at ? ` ${formatTime(row.proposed_at)}` : "";
    await systemMessage(dealId, req.user.id, `${buyer} reserverte ${listing.title}${when ? ` og foreslo${when}` : ""}.`);
    sendPush(listing.seller_id, {
      title: "Noen vil redde maten din! 🎉",
      body: row.proposed_at
        ? `${buyer} vil hente ${listing.title}${when}. Trykk for å godta.`
        : `${buyer} reserverte ${listing.title}. Avtal en tid.`,
      data: { dealId },
    });

    res.status(201).json(dealFor(row, req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /deals/:id/propose — foreslå hentetid
router.post("/:id/propose", requireAuth, dealAction, async (req, res) => {
  try {
    const row = await loadDeal(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Ikke funnet" });
    if (row.status !== "reserved") return res.status(409).json({ error: "Tiden er allerede avtalt." });

    const at = new Date(req.body.at);
    if (isNaN(at) || at < new Date(Date.now() - 5 * 60000)) return res.status(400).json({ error: "Velg et tidspunkt fram i tid." });
    if (at > new Date(new Date(row.pickup_deadline).getTime() + 12 * 3600000)) {
      return res.status(400).json({ error: "Tidspunktet er etter hentevinduet." });
    }

    const role = row.buyer_id === req.user.id ? "buyer" : "seller";
    await pool.query("UPDATE deals SET proposed_at = $1, proposed_by = $2 WHERE id = $3", [at.toISOString(), role, row.id]);
    await systemMessage(row.id, req.user.id, `${myName(row, req.user.id)} foreslo ${formatTime(at)}.`);
    sendPush(otherParty(row, req.user.id), {
      title: "Nytt forslag til hentetid",
      body: `${myName(row, req.user.id)} foreslår ${formatTime(at)} for ${row.title}.`,
      data: { dealId: row.id },
    });

    res.json(dealFor(await loadDeal(row.id, req.user.id), req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /deals/:id/accept — godta forslaget → bekreftet, adressen vises
router.post("/:id/accept", requireAuth, dealAction, async (req, res) => {
  try {
    const row = await loadDeal(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Ikke funnet" });
    const role = row.buyer_id === req.user.id ? "buyer" : "seller";
    if (row.status !== "reserved" || !row.proposed_at) return res.status(409).json({ error: "Det er ikke noe forslag å godta." });
    if (row.proposed_by === role) return res.status(409).json({ error: "Venter på at den andre godtar." });

    await pool.query(
      "UPDATE deals SET status = 'confirmed', meetup_at = proposed_at, confirmed_at = NOW() WHERE id = $1",
      [row.id]
    );
    await systemMessage(row.id, req.user.id, `Avtalt! Henting ${formatTime(row.proposed_at)}.`);
    sendPush(otherParty(row, req.user.id), {
      title: "Hentingen er avtalt ✅",
      body: `${row.title} · ${formatTime(row.proposed_at)}`,
      data: { dealId: row.id },
    });

    res.json(dealFor(await loadDeal(row.id, req.user.id), req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /deals/:id/complete — hver part bekrefter selv. Rollen kommer fra innloggingen.
async function complete(req, res) {
  try {
    const row = await loadDeal(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Ikke funnet" });
    if (!OPEN_STATUSES.includes(row.status)) return res.status(409).json({ error: "Avtalen er allerede avsluttet." });

    const field = row.buyer_id === req.user.id ? "completion_confirmed_by_buyer" : "completion_confirmed_by_seller";
    const { rows: updated } = await pool.query(
      `UPDATE deals SET ${field} = TRUE WHERE id = $1 RETURNING completion_confirmed_by_buyer, completion_confirmed_by_seller`,
      [row.id]
    );
    const d = updated[0];
    if (d.completion_confirmed_by_buyer && d.completion_confirmed_by_seller) {
      await pool.query("UPDATE deals SET status = 'completed', completed_at = NOW() WHERE id = $1", [row.id]);
      await pool.query("UPDATE listings SET status = 'completed' WHERE id = $1", [row.listing_id]);
      sendPush(otherParty(row, req.user.id), {
        title: "Mat er reddet! 💚",
        body: `${row.title} har fått et nytt hjem. Takk for at du bidro!`,
        data: { dealId: row.id },
      });
    } else {
      sendPush(otherParty(row, req.user.id), {
        title: "Bekreft hentingen",
        body: `${myName(row, req.user.id)} har bekreftet at ${row.title} er hentet.`,
        data: { dealId: row.id },
      });
    }

    res.json(dealFor(await loadDeal(row.id, req.user.id), req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
}
router.post("/:id/complete", requireAuth, dealAction, complete);
router.patch("/:id/complete", requireAuth, dealAction, complete);

// POST /deals/:id/cancel
async function cancel(req, res) {
  try {
    const row = await loadDeal(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Ikke funnet" });
    if (!OPEN_STATUSES.includes(row.status)) return res.status(409).json({ error: "Avtalen er allerede avsluttet." });

    const role = row.buyer_id === req.user.id ? "buyer" : "seller";
    const reason = String(req.body?.reason || req.body?.cancel_reason || "").trim().slice(0, 300) || null;
    await pool.query(
      "UPDATE deals SET status = 'cancelled', cancel_reason = $1, cancelled_by = $2 WHERE id = $3",
      [reason, role, row.id]
    );
    // Kjøper avlyser → varen blir tilgjengelig igjen. Selger avlyser → varen trekkes.
    await pool.query(
      `UPDATE listings SET status = CASE WHEN $2 = 'buyer' AND pickup_deadline > NOW() THEN 'active' ELSE 'withdrawn' END
        WHERE id = $1`,
      [row.listing_id, role]
    );
    await systemMessage(row.id, req.user.id, `${myName(row, req.user.id)} avlyste avtalen.${reason ? ` «${reason}»` : ""}`);
    sendPush(otherParty(row, req.user.id), {
      title: "Avtalen ble avlyst",
      body: `${myName(row, req.user.id)} avlyste ${row.title}.`,
      data: { dealId: row.id },
    });

    res.json(dealFor(await loadDeal(row.id, req.user.id), req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
}
router.post("/:id/cancel", requireAuth, dealAction, cancel);
router.patch("/:id/cancel", requireAuth, dealAction, cancel);

// POST /deals/:id/no-show — den andre parten kom ikke
router.post("/:id/no-show", requireAuth, dealAction, async (req, res) => {
  try {
    const row = await loadDeal(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Ikke funnet" });
    if (row.status !== "confirmed" || !row.meetup_at) {
      return res.status(409).json({ error: "Du kan bare melde uteblivelse etter en avtalt hentetid." });
    }
    if (new Date(row.meetup_at) > new Date(Date.now() - 15 * 60000)) {
      return res.status(409).json({ error: "Gi det 15 minutter etter avtalt tid før du melder uteblivelse." });
    }

    const absent = row.buyer_id === req.user.id ? "seller" : "buyer";
    await pool.query("UPDATE deals SET status = 'no_show', no_show_party = $1 WHERE id = $2", [absent, row.id]);
    await pool.query(
      `UPDATE listings SET status = CASE WHEN pickup_deadline > NOW() THEN 'active' ELSE 'expired' END WHERE id = $1`,
      [row.listing_id]
    );
    await systemMessage(row.id, req.user.id, `${myName(row, req.user.id)} meldte at den andre ikke møtte opp.`);
    sendPush(otherParty(row, req.user.id), {
      title: "Registrert som uteblitt",
      body: `Du ble meldt som uteblitt fra ${row.title}. To uteblivelser på 30 dager gir midlertidig stopp. Ta kontakt hvis dette er feil.`,
      data: { dealId: row.id },
    });

    res.json(dealFor(await loadDeal(row.id, req.user.id), req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /deals/:id/rating
router.post("/:id/rating", requireAuth, dealAction, async (req, res) => {
  const score = Number(req.body?.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return res.status(400).json({ error: "Velg 1–5 stjerner" });
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t) => String(t).slice(0, 40)).slice(0, 6) : [];
  const comment = req.body?.comment ? String(req.body.comment).slice(0, 500) : null;

  try {
    const row = await loadDeal(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Ikke funnet" });
    if (row.status !== "completed") return res.status(409).json({ error: "Du kan vurdere etter at maten er hentet." });

    const isBuyer = row.buyer_id === req.user.id;
    const toUser = isBuyer ? row.seller_id : row.buyer_id;
    const context = isBuyer ? "buyer_rates_seller" : "seller_rates_buyer";
    await pool.query(
      `INSERT INTO ratings (deal_id, from_user_id, to_user_id, role_context, score, reason_tags, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (deal_id, from_user_id) DO NOTHING`,
      [row.id, req.user.id, toUser, context, score, tags, comment]
    );
    const prefix = isBuyer ? "seller" : "buyer";
    await pool.query(
      `UPDATE users SET
         ${prefix}_rating = (SELECT ROUND(AVG(score)::numeric, 2) FROM ratings WHERE to_user_id = $1 AND role_context = $2),
         ${prefix}_rating_count = (SELECT COUNT(*) FROM ratings WHERE to_user_id = $1 AND role_context = $2)
       WHERE id = $1`,
      [toUser, context]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// GET /deals/:id/messages
router.get("/:id/messages", requireAuth, async (req, res) => {
  try {
    const { rows: deal } = await pool.query("SELECT buyer_id, seller_id FROM deals WHERE id = $1", [req.params.id]);
    if (!deal.length) return res.status(404).json({ error: "Ikke funnet" });
    if (deal[0].buyer_id !== req.user.id && deal[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: "Ikke tilgang" });
    }
    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.deal_id, m.sender_id, m.text, m.kind, m.sent_at, u.display_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.deal_id = $1 ORDER BY m.sent_at ASC`,
      [req.params.id]
    );
    res.json(msgs.map((m) => ({ ...m, sender_name: firstName(m.sender_name), mine: m.sender_id === req.user.id })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

// POST /deals/:id/messages
router.post("/:id/messages", requireAuth, sendMessage, validateMessage, async (req, res) => {
  const { text } = req.body;
  try {
    const { rows: deal } = await pool.query(
      `SELECT d.buyer_id, d.seller_id, d.status, d.title, bu.display_name AS buyer_name, su.display_name AS seller_name
         FROM deals d JOIN users bu ON bu.id = d.buyer_id JOIN users su ON su.id = d.seller_id
        WHERE d.id = $1`,
      [req.params.id]
    );
    if (!deal.length) return res.status(404).json({ error: "Ikke funnet" });
    const row = deal[0];
    if (row.buyer_id !== req.user.id && row.seller_id !== req.user.id) {
      return res.status(403).json({ error: "Ikke tilgang" });
    }
    if (await isBlockedBetween(row.buyer_id, row.seller_id)) {
      return res.status(403).json({ error: "Du kan ikke sende meldinger til denne brukeren." });
    }
    const id = uuid();
    await pool.query(
      "INSERT INTO messages (id, deal_id, sender_id, text, kind) VALUES ($1,$2,$3,$4,'text')",
      [id, req.params.id, req.user.id, text.trim()]
    );
    const { rows } = await pool.query(
      `SELECT m.id, m.deal_id, m.sender_id, m.text, m.kind, m.sent_at, u.display_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
      [id]
    );
    sendPush(otherParty(row, req.user.id), {
      title: `${myName(row, req.user.id)} · ${row.title}`,
      body: text.trim().slice(0, 140),
      data: { dealId: req.params.id },
    });
    res.status(201).json({ ...rows[0], sender_name: firstName(rows[0].sender_name), mine: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Serverfeil" });
  }
});

module.exports = router;
