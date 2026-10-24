// Sentrale produktbrytere. Styres med miljøvariabler i Render, så de kan endres uten ny app-versjon.
module.exports = {
  // Ved lansering er all mat gratis (gi bort). Sett FREE_ONLY=false når betaling skal åpnes.
  FREE_ONLY: process.env.FREE_ONLY !== "false",
  // 7 kr/mnd-abonnementet holdes skjult til denne slås på.
  SUBSCRIPTION_ENABLED: process.env.SUBSCRIPTION_ENABLED === "true",
  // E-post/passord-innlogging er kun for lokal utvikling. Produksjon bruker Sign in with Apple.
  ALLOW_PASSWORD_AUTH: process.env.ALLOW_PASSWORD_AUTH === "true" || process.env.NODE_ENV !== "production",
  MAX_NO_SHOWS_30D: 2,
  AUTO_SUSPEND_REPORTERS: 3,
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID || "no.svinn.app",
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || "svinnapp@gmail.com",
};
