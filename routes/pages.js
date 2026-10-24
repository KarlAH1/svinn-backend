// Offentlige sider: personvern, vilkår og support. App Store krever at disse har en fast URL.
const router = require("express").Router();
const { SUPPORT_EMAIL } = require("../lib/config");

const UPDATED = "24. oktober 2026";

function page(title, body) {
  return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Svinn</title>
<style>
  :root { --bg:#f7f5ef; --text:#14241b; --muted:#5d6f64; --brand:#173f2a; --line:#e3e0d6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1512; --text:#eef3ef; --muted:#9db0a4; --brand:#7fd1a1; --line:#25302a; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width:680px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:32px; line-height:1.2; margin:0 0 4px; color:var(--brand); }
  h2 { font-size:19px; margin:32px 0 6px; }
  p, li { color:var(--text); }
  .muted { color:var(--muted); font-size:14px; }
  a { color:var(--brand); }
  nav { display:flex; gap:16px; margin-bottom:32px; font-size:14px; }
  ul { padding-left:20px; }
</style>
</head>
<body><main>
<nav><a href="/personvern">Personvern</a><a href="/vilkar">Vilkår</a><a href="/support">Support</a></nav>
${body}
</main></body></html>`;
}

const PRIVACY = page("Personvernerklæring", `
<h1>Personvernerklæring</h1>
<p class="muted">Sist oppdatert ${UPDATED}</p>
<p>Svinn er en app der naboer gir bort uåpnet mat de ikke rekker å bruke. Vi samler bare inn det vi trenger for at det skal fungere, og vi selger aldri personopplysninger.</p>

<h2>Hvem er ansvarlig</h2>
<p>Svinn er behandlingsansvarlig. Kontakt: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

<h2>Hva vi lagrer</h2>
<ul>
  <li><b>Konto:</b> navnet du oppgir, og en anonym ID fra Sign in with Apple. Hvis du deler e-posten din med oss, lagrer vi den (den kan være en anonym videresendingsadresse fra Apple).</li>
  <li><b>Annonser:</b> varenavn, bilder av emballasje og datomerking, hentevindu og hentested. Andre brukere ser bare et omtrentlig område til en hentetid er avtalt. Da ser den du har avtale med adressen.</li>
  <li><b>Avtaler og meldinger:</b> reservasjoner, avtalte hentetider, meldinger mellom partene og vurderinger etter henting.</li>
  <li><b>Trygghet:</b> rapporter, blokkeringer og uteblivelser, for å holde Svinn trygt.</li>
  <li><b>Varsler:</b> et push-token fra telefonen din, hvis du tillater varsler.</li>
</ul>

<h2>Posisjon</h2>
<p>Appen bruker posisjonen din på telefonen for å vise mat i nærheten. Den lagres ikke hos oss. Når du legger ut en vare, lagrer vi hentestedet du velger.</p>

<h2>Hvem vi deler med</h2>
<ul>
  <li><b>Render</b> (drift av server) og <b>Aiven</b> (database) lagrer dataene på våre vegne.</li>
  <li><b>Apple</b> for innlogging, og <b>Expo</b> for å levere push-varsler.</li>
  <li><b>Kassalapp</b> mottar strekkoden når du skanner en vare, for å finne produktinformasjon. Ingen personopplysninger sendes.</li>
</ul>

<h2>Hvor lenge</h2>
<p>Vi lagrer opplysningene så lenge du har konto. Sletter du kontoen, slettes profilen, annonsene, bildene, meldingene og vurderingene dine permanent.</p>

<h2>Dine rettigheter</h2>
<p>Du kan be om innsyn, retting eller sletting, og du kan slette kontoen selv under <b>Profil → Slett konto</b>. Du kan klage til <a href="https://www.datatilsynet.no">Datatilsynet</a>.</p>
`);

const TERMS = page("Vilkår", `
<h1>Vilkår for bruk</h1>
<p class="muted">Sist oppdatert ${UPDATED}</p>

<h2>1. Hva Svinn er</h2>
<p>Svinn kobler naboer som vil gi bort uåpnet mat med naboer som vil hente den. Svinn er et teknisk mellomledd og selger ikke mat selv. Svinn er gratis å bruke.</p>

<h2>2. Hva du kan dele</h2>
<ul>
  <li>Kun <b>uåpnede</b> varer i <b>originalemballasjen</b>, kjøpt i en vanlig dagligvarebutikk.</li>
  <li>Aldri varer som har passert «best før» eller «siste forbruksdag».</li>
  <li>Ikke hjemmelaget mat, åpnede pakker, rester eller restaurantmat.</li>
  <li>Ikke alkohol, tobakk, nikotin eller legemidler.</li>
</ul>
<p>Du er selv ansvarlig for at maten du deler er trygg, riktig merket og oppbevart riktig fram til henting.</p>

<h2>3. Avtaler og henting</h2>
<p>Når du reserverer, avtaler dere en hentetid. Møt opp, eller avlys i god tid. Uteblir du to ganger i løpet av 30 dager, kan du ikke reservere på en stund.</p>

<h2>4. Null toleranse</h2>
<p>Vi stenger kontoer som deler forbudte eller utgåtte varer, trakasserer andre, lyver om varer eller misbruker vurderingene. Rapporter fra flere brukere stenger kontoen automatisk mens vi ser på saken. Du kan rapportere og blokkere andre brukere fra appen.</p>

<h2>5. Alder</h2>
<p>Du må være minst 18 år for å bruke Svinn.</p>

<h2>6. Ansvar</h2>
<p>Svinn leveres som den er. Svinn er ikke ansvarlig for maten som deles, for avtaler mellom brukere, eller for tap som oppstår ved bruk av appen, så langt loven tillater det.</p>

<h2>7. Endringer</h2>
<p>Vi kan oppdatere vilkårene. Ved vesentlige endringer sier vi fra i appen.</p>

<h2>8. Kontakt</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Norsk rett gjelder.</p>
`);

const SUPPORT = page("Support", `
<h1>Support</h1>
<p>Trenger du hjelp, vil du melde fra om noe, eller har du spørsmål? Send oss en e-post, så svarer vi så fort vi kan.</p>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
<h2>Slette konto</h2>
<p>Åpne Svinn, gå til <b>Profil → Slett konto</b>. Kontoen og alt innholdet ditt slettes permanent med en gang.</p>
<h2>Melde fra om en bruker</h2>
<p>Trykk på ⋯ på varen, avtalen eller profilen og velg <b>Rapporter</b>. Er det fare for liv og helse, ring 113.</p>
`);

function send(html) {
  return (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("html").send(html);
  };
}

router.get("/personvern", send(PRIVACY));
router.get("/vilkar", send(TERMS));
router.get("/support", send(SUPPORT));

module.exports = router;
