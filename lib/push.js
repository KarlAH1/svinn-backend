// Push-varsler via Expo sin push-tjeneste. Feil her skal aldri stoppe en forespørsel.
const pool = require("../db");

async function sendPush(userId, { title, body, data = {} }) {
  try {
    const { rows } = await pool.query("SELECT token FROM push_tokens WHERE user_id = $1", [userId]);
    if (!rows.length) return;
    const messages = rows.map((r) => ({ to: r.token, title, body, data, sound: "default" }));
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.warn("Push feilet:", err.message);
  }
}

module.exports = { sendPush };
