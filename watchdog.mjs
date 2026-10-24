/**
 * watchdog.mjs - Chien de garde de MRScoring : verifie le site toutes les 5 min, independamment de Vercel et du PC.
 *
 * Projet : MRScoring - concu par Nelson Rioux, code avec Claude
 * Historique, versions et dates : voir git log / git blame
 *
 * Decision de Nelson (2026-10-24) : la surveillance tourne hors de ce qu'elle surveille (GitHub Actions, depot public),
 * garde son propre etat (status.json, branche data) et publie des signaux lumineux (page status.mrscoring.com et
 * onglet Sante du Tableau de bord). Usage : node watchdog.mjs <status.json> (lu puis reecrit).
 *
 * A chaque passage (toutes les 5 min) : le site (page de connexion) et sa base (/api/health).
 * Une fois l'heure : les services de fond, lus directement dans la base (import, fil, precalcul, taille de la base,
 * sauvegarde du jeudi) et de l'exterieur (certificat https, echeance du domaine).
 * Gravite : critique (usagers touches : site ou base en panne), majeur (service de fond manque), mineur (a surveiller).
 * Une panne s'ouvre au premier echec confirme et se ferme au retour a la normale (journal). Courriel aux admins a
 * l'ouverture et a la fermeture d'une panne critique ou majeure, et un resume le lundi.
 * Secrets (GitHub > Settings > Secrets) : SITE_DATABASE_URL (pooler Supabase), RESEND_API_KEY, ALERT_EMAILS.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:tls";
import pg from "pg";

const SITE = "https://app.mrscoring.com";
const HOST = new URL(SITE).hostname;
const DOMAIN = "mrscoring.com";
const TZ = "America/Toronto";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SLOW_MS = 5000;
const KEEP_DAYS = 90;
const KEEP_INCIDENTS = 200;
const FROM = "MRScoring <veille@mrscoring.com>";

export const CATEGORIES = {
  site: { fr: "Site web", en: "Website" },
  base: { fr: "Base de données", en: "Database" },
  donnees: { fr: "Imports et fil", en: "Imports and feed" },
  sauvegarde: { fr: "Sauvegarde", en: "Backup" },
  domaine: { fr: "Domaine et https", en: "Domain and https" },
};
const RANK = { mineur: 1, majeur: 2, critique: 3 };
const COLOR = { 0: "vert", 1: "jaune", 2: "orange", 3: "rouge" };

const now = new Date();
const iso = (d) => new Date(d).toISOString();
const dayOf = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
const hourOf = (d) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));
const fmtDuration = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} min` : ms < DAY ? `${(ms / HOUR).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} j`);

// Resultat d'une verification : ok, ou en echec avec une gravite et une raison courte (francais et anglais).
const ok = (key, category) => ({ key, category, ok: true });
const bad = (key, category, severity, fr, en) => ({ key, category, ok: false, severity, reason: fr, reasonEn: en ?? fr });

// ---------------------------------------------------------------------------------------------------- toutes les 5 min

async function fetchTimed(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "MRScoring-watchdog/2.0" }, redirect: "follow" });
    const body = await res.text();
    return { status: res.status, ms: Date.now() - started, body };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, error: e.cause?.code ?? e.name ?? String(e) };
  }
}

// Le site et sa base. Un echec est revu 20 s plus tard : un accroc reseau n'est pas une panne.
async function probeSite() {
  let page = await fetchTimed(`${SITE}/login`);
  let health = await fetchTimed(`${SITE}/api/health`);
  if (page.status !== 200 || health.status !== 200) {
    await new Promise((r) => setTimeout(r, 20_000));
    page = await fetchTimed(`${SITE}/login`);
    health = await fetchTimed(`${SITE}/api/health`);
  }
  const results = [];
  const why = (r) => (r.status ? `HTTP ${r.status}` : r.error === "TimeoutError" ? "aucune réponse en 20 s" : r.error);
  const whyEn = (r) => (r.status ? `HTTP ${r.status}` : r.error === "TimeoutError" ? "no response within 20 s" : r.error);
  if (page.status !== 200) results.push(bad("site", "site", "critique", `Site inaccessible : ${why(page)}`, `Website unreachable: ${whyEn(page)}`));
  else if (page.ms > SLOW_MS) results.push(bad("site", "site", "mineur", `Site lent : ${(page.ms / 1000).toFixed(1)} s`, `Website slow: ${(page.ms / 1000).toFixed(1)} s`));
  else results.push(ok("site", "site"));
  let db = null;
  try {
    db = JSON.parse(health.body ?? "").db;
  } catch {
    // reponse illisible : jugee par son code HTTP
  }
  if (page.status === 200 && (health.status !== 200 || db !== "ok")) {
    results.push(bad("base", "base", "critique", "Le site ne joint plus sa base de données", "The website cannot reach its database"));
  } else results.push(ok("base", "base"));
  return { results, up: page.status === 200 && health.status === 200 && db === "ok", ms: page.ms };
}

// -------------------------------------------------------------------------------------------------- une fois l'heure

async function backgroundChecks(client) {
  const out = [];
  const one = async (sql) => (await client.query(sql)).rows[0];

  const last = await one("select max(started_at) at from import_runs where trigger = 'cron'");
  const silence = last.at ? now - new Date(last.at) : Infinity;
  out.push(silence > 8 * HOUR
    ? bad("imports", "donnees", "majeur", `Import automatique arrêté depuis ${fmtDuration(silence)}`, `Automatic import stopped for ${fmtDuration(silence)}`)
    : ok("imports", "donnees"));

  const runs = await one("select count(*) filter (where ok is false)::int failed, count(*) filter (where ok is not null)::int done from import_runs where trigger = 'cron' and started_at > now() - interval '24 hours'");
  out.push(runs.failed >= 3 && runs.failed > runs.done / 2
    ? bad("import-errors", "donnees", "mineur", `Erreurs d'import répétées : ${runs.failed} sur ${runs.done} en 24 h`, `Repeated import errors: ${runs.failed} of ${runs.done} in 24 h`)
    : ok("import-errors", "donnees"));

  const today = dayOf(now);
  const feed = await one(`select count(*)::int n from feed_items where feed_date = '${today}'`);
  // Fil vide : mineur. Le programme d'un jour peut ne rien produire (ex. samedi = recapitulatif des competitions, vide
  // si aucune n'a ete importee); un passage qui n'a pas eu lieu est deja vu par « imports » (majeur).
  out.push(!feed.n && hourOf(now) >= 7
    ? bad("feed", "donnees", "mineur", "Fil du jour vide : aucune nouvelle publiée", "Today's news feed is empty")
    : ok("feed", "donnees"));

  const gap = await one("select (select count(*) from competition_results) - (select count(*) from feed_results_mv) gap");
  out.push(Number(gap.gap) > 0
    ? bad("feed-results", "donnees", "mineur", "Nouveaux résultats pas encore dans le fil", "New results not yet in the feed")
    : ok("feed-results", "donnees"));

  const size = await one("select pg_database_size(current_database()) bytes, (select count(*) from pg_stat_activity)::int conns, current_setting('max_connections')::int maxc");
  const full = Number(size.bytes) / (8 * 1024 ** 3);
  out.push(full > 0.75 || size.conns > size.maxc * 0.8
    ? bad("db-capacity", "base", "mineur", `Base chargée : ${Math.round(full * 100)} % de l'espace, ${size.conns}/${size.maxc} connexions`, `Database busy: ${Math.round(full * 100)} % of space, ${size.conns}/${size.maxc} connections`)
    : ok("db-capacity", "base"));

  const backup = (await client.query("select at, ok from watchdog_heartbeats where source = 'backup' order by at desc limit 1")).rows[0];
  out.push(!backup
    ? bad("backup", "sauvegarde", "majeur", "Aucune sauvegarde notée", "No backup recorded")
    : !backup.ok
      ? bad("backup", "sauvegarde", "majeur", "Dernière sauvegarde en échec", "Last backup failed")
      : now - new Date(backup.at) > 8 * DAY
        ? bad("backup", "sauvegarde", "majeur", `Sauvegarde manquante depuis ${fmtDuration(now - new Date(backup.at))}`, `Backup missing for ${fmtDuration(now - new Date(backup.at))}`)
        : ok("backup", "sauvegarde"));
  return out;
}

function certificateCheck() {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port: 443, servername: HOST, timeout: 15_000 }, () => {
      const left = new Date(socket.getPeerCertificate().valid_to) - now;
      socket.end();
      const d = Math.floor(left / DAY);
      resolve(left < 7 * DAY ? bad("https", "domaine", "majeur", `Certificat https expire dans ${d} j`, `https certificate expires in ${d} days`)
        : left < 21 * DAY ? bad("https", "domaine", "mineur", `Certificat https expire dans ${d} j`, `https certificate expires in ${d} days`)
        : ok("https", "domaine"));
    });
    socket.on("error", () => resolve(ok("https", "domaine"))); // une vraie panne https est vue par la verification du site
    socket.on("timeout", () => { socket.destroy(); resolve(ok("https", "domaine")); });
  });
}

async function domainCheck() {
  const res = await fetch(`https://rdap.verisign.com/com/v1/domain/${DOMAIN}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return ok("domain", "domaine"); // registre momentanement illisible : pas une panne du site
  const exp = (await res.json()).events?.find((e) => e.eventAction === "expiration")?.eventDate;
  if (!exp) return ok("domain", "domaine");
  const d = Math.floor((new Date(exp) - now) / DAY);
  return d < 30 ? bad("domain", "domaine", "majeur", `Domaine ${DOMAIN} expire dans ${d} j`, `Domain ${DOMAIN} expires in ${d} days`)
    : d < 60 ? bad("domain", "domaine", "mineur", `Domaine ${DOMAIN} expire dans ${d} j`, `Domain ${DOMAIN} expires in ${d} days`)
    : ok("domain", "domaine");
}

// ------------------------------------------------------------------------------------------------------------- etat

function updateIncidents(state, results, alerts) {
  for (const r of results) {
    const open = state.open[r.key];
    if (!r.ok && !open) {
      const inc = { id: `${r.key}-${iso(now)}`, check_key: r.key, category: r.category, severity: r.severity, reason: r.reason, reasonEn: r.reasonEn, started_at: iso(now), ended_at: null };
      state.open[r.key] = inc;
      state.incidents.unshift(inc);
      if (RANK[r.severity] >= 2) alerts.push({ type: "open", inc });
    } else if (!r.ok && open && RANK[r.severity] > RANK[open.severity]) {
      Object.assign(open, { severity: r.severity, reason: r.reason, reasonEn: r.reasonEn }); // la panne s'aggrave
      const listed = state.incidents.find((i) => i.id === open.id);
      if (listed) Object.assign(listed, { severity: r.severity, reason: r.reason, reasonEn: r.reasonEn });
      if (RANK[r.severity] >= 2) alerts.push({ type: "open", inc: open });
    } else if (r.ok && open) {
      const listed = state.incidents.find((i) => i.id === open.id);
      if (listed) listed.ended_at = iso(now);
      delete state.open[r.key];
      if (RANK[open.severity] >= 2) alerts.push({ type: "close", inc: { ...open, ended_at: iso(now) } });
    }
  }
  state.incidents = state.incidents.slice(0, KEEP_INCIDENTS);
}

function tally(state, results) {
  const day = dayOf(now);
  state.daily[day] ??= {};
  const add = (category, good) => {
    const t = (state.daily[day][category] ??= { checks: 0, ok: 0 });
    t.checks++;
    if (good) t.ok++;
  };
  for (const r of results) if (r.key !== "site" && r.key !== "base") add(r.category, r.ok);
  const days = Object.keys(state.daily).sort();
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete state.daily[d];
}

// Disponibilite du site = page et base repondent (verifications de 5 min). 24 h : passages recents; 30 et 90 j : jours.
function stats(state) {
  const pct = (good, total) => (total ? Math.round((good / total) * 10000) / 100 : null);
  const recent = state.recent.filter((p) => now - new Date(p.at) <= DAY);
  const sum = (n) => {
    const days = Object.keys(state.daily).sort().slice(-n);
    let checks = 0, good = 0;
    for (const d of days) {
      const t = state.daily[d].disponibilite;
      if (t) { checks += t.checks; good += t.ok; }
    }
    return pct(good, checks);
  };
  const critical = state.incidents.filter((i) => i.severity === "critique");
  const openCritical = critical.some((i) => !i.ended_at);
  const lastEnd = critical.map((i) => i.ended_at).filter(Boolean).sort().pop();
  const since = lastEnd ?? state.monitoringSince;
  return {
    uptime24h: pct(recent.filter((p) => p.up).length, recent.length),
    uptime30d: sum(30),
    uptime90d: sum(90),
    daysWithoutOutage: openCritical ? 0 : Math.floor((now - new Date(since)) / DAY),
    daysWithoutOutageSince: openCritical ? null : since,
    monitoringSince: state.monitoringSince,
  };
}

function lights(state) {
  const cats = {};
  for (const [id, label] of Object.entries(CATEGORIES)) {
    const open = Object.values(state.open).filter((i) => i.category === id);
    const worst = open.reduce((m, i) => Math.max(m, RANK[i.severity]), 0);
    const known = state.seen.includes(id);
    cats[id] = { label: label.fr, labelEn: label.en, color: known ? COLOR[worst] : "gris", reasons: open.map((i) => ({ fr: i.reason, en: i.reasonEn, severity: i.severity })) };
  }
  const worst = Math.max(0, ...Object.values(state.open).map((i) => RANK[i.severity]));
  return { global: COLOR[worst], categories: cats };
}

// ---------------------------------------------------------------------------------------------- base et courriels

// full (une fois l'heure) : tout l'etat garde (rattrape une base qui etait injoignable); sinon les 2 derniers jours.
async function mirror(client, state, full) {
  await client.query("insert into watchdog_status (id, checked_at, status) values (1, $1, $2) on conflict (id) do update set checked_at = excluded.checked_at, status = excluded.status",
    [state.checkedAt, JSON.stringify({ lights: state.lights, stats: state.stats })]);
  const recent = (d) => full || !d || now - new Date(d) <= 2 * DAY;
  for (const i of state.incidents.filter((x) => recent(x.ended_at) || recent(x.started_at))) {
    await client.query(`insert into watchdog_incidents (id, check_key, category, severity, reason, started_at, ended_at) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (id) do update set severity = excluded.severity, reason = excluded.reason, ended_at = excluded.ended_at`,
      [i.id, i.check_key, i.category, i.severity, i.reason, i.started_at, i.ended_at]);
  }
  for (const [day, cats] of Object.entries(state.daily).filter(([d]) => full || d >= dayOf(now - DAY))) {
    for (const [category, t] of Object.entries(cats)) {
      await client.query("insert into watchdog_daily (day, category, checks, ok) values ($1,$2,$3,$4) on conflict (day, category) do update set checks = excluded.checks, ok = excluded.ok",
        [day, category, t.checks, t.ok]);
    }
  }
}

async function email(subject, text) {
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!key || !to.length) return console.log(`(courriel non envoye, secrets absents) ${subject}`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, text }),
  });
  if (!res.ok) console.log(`Resend ${res.status} : ${(await res.text()).slice(0, 200)}`);
}

const SEVERITY_LABEL = { critique: "PANNE CRITIQUE", majeur: "Panne majeure", mineur: "À surveiller" };
const PAGE = "https://status.mrscoring.com";
const DASHBOARD = `${SITE}/admin/tableau-de-bord?vue=sante`;
const SUPABASE = "https://supabase.com/dashboard/project/ryxywyvantasahqpnjds";
const VERCEL = "https://vercel.com/mrscoring/mrscoring-web";

// Quoi faire, par service : les memes leviers que la fiche de panne de l'onglet Sante (mrscoring-web, playbook.ts),
// pour agir directement depuis le courriel.
const ACTIONS = {
  site: [
    "1. Vercel en panne pour tous ? https://www.vercel-status.com",
    `2. Deploiement recent ? Revenir a la version d'avant (Instant Rollback) : ${VERCEL}/deployments`,
    `3. Sinon, redeployer la derniere version (Redeploy) : ${VERCEL}/deployments`,
  ],
  base: [
    "1. Supabase en panne pour tous ? https://status.supabase.com",
    `2. Redemarrer la base (Restart project, 2-3 min de coupure) : ${SUPABASE}/settings/general`,
    `3. Base saturee : augmenter la puissance : ${SUPABASE}/settings/compute-and-disk`,
  ],
  donnees: [
    `1. Lancer un passage d'import maintenant : ${SITE}/admin/competitions`,
    "2. Erreurs « WA 500 » : World Athletics en cause, le passage suivant reessaie seul.",
    `3. Aucun passage depuis des heures : taches planifiees Vercel : ${VERCEL}/settings/cron-jobs`,
  ],
  sauvegarde: [
    "1. Sur le PC : Planificateur de taches > « Backup MRScoring (Supabase) » > Executer (journal : D:\\Backup\\MRScoring\\backup.log).",
    `2. En attendant, sauvegardes quotidiennes Supabase (7 jours) : ${SUPABASE}/database/backups/scheduled`,
  ],
  domaine: [
    "1. Domaine : renouveler chez GoDaddy : https://dcc.godaddy.com/control/portfolio",
    `2. Certificat : verifier app.mrscoring.com dans Vercel : ${VERCEL}/settings/domains`,
  ],
};

async function sendAlerts(alerts, state) {
  for (const { type, inc } of alerts) {
    if (type === "open") {
      await email(`[MRScoring] ${SEVERITY_LABEL[inc.severity]} : ${inc.reason}`, [
        inc.reason,
        `Depuis : ${new Date(inc.started_at).toLocaleString("fr-CA", { timeZone: TZ })}`,
        "",
        "Que faire :",
        ...(ACTIONS[inc.category] ?? []),
        "",
        `Etat en direct : ${PAGE}`,
        `Fiche de panne et journal : ${DASHBOARD}`,
      ].join("\n"));
    } else {
      const dur = fmtDuration(new Date(inc.ended_at) - new Date(inc.started_at));
      await email(`[MRScoring] Rétabli après ${dur} : ${inc.reason}`, `${inc.reason}\nDurée : ${dur}\n\nJournal : ${DASHBOARD}`);
    }
  }
  // Resume du lundi, apres 8 h a Montreal (une seule fois) : un chien de garde muet ne prouve pas qu'il est vivant.
  const weekday = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short" }).format(now);
  if (weekday === "Mon" && hourOf(now) >= 8 && state.lastWeekly !== dayOf(now)) {
    state.lastWeekly = dayOf(now);
    const s = state.stats;
    const week = state.incidents.filter((i) => now - new Date(i.started_at) <= 7 * DAY);
    await email(`[MRScoring] Chien de garde, semaine : ${s.uptime30d ?? "—"} % sur 30 jours`, [
      `Signal général : ${state.lights.global}`,
      `Disponibilité : ${s.uptime24h ?? "—"} % (24 h), ${s.uptime30d ?? "—"} % (30 j), ${s.uptime90d ?? "—"} % (90 j)`,
      `Jours sans panne critique : ${s.daysWithoutOutage}`,
      "",
      week.length ? "Pannes de la semaine :" : "Aucune panne cette semaine.",
      ...week.map((i) => `- ${i.severity} · ${new Date(i.started_at).toLocaleString("fr-CA", { timeZone: TZ })} · ${i.reason}${i.ended_at ? ` (${fmtDuration(new Date(i.ended_at) - new Date(i.started_at))})` : " (en cours)"}`),
      "",
      `État en direct : ${PAGE}`,
    ].join("\n"));
  }
}

// ------------------------------------------------------------------------------------------------------------ main

async function main() {
  const file = process.argv[2] ?? "status.json";
  let state = {};
  try {
    state = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // premier passage
  }
  state.monitoringSince ??= iso(now);
  state.open ??= {};
  state.incidents ??= [];
  state.daily ??= {};
  state.recent ??= [];
  state.seen ??= [];

  const results = [];
  const site = await probeSite();
  results.push(...site.results);
  state.recent = [...state.recent.filter((p) => now - new Date(p.at) <= DAY), { at: iso(now), up: site.up, ms: site.ms }];
  const day = dayOf(now);
  state.daily[day] ??= {};
  const avail = (state.daily[day].disponibilite ??= { checks: 0, ok: 0 });
  avail.checks++;
  if (site.up) avail.ok++;

  // Adresse de la base : tolere un secret colle avec des guillemets, des espaces ou le prefixe « SITE_DATABASE_URL= ».
  // Si la connexion echoue, le code d'erreur (jamais l'adresse ni le mot de passe) est publie dans l'etat (dbError)
  // pour qu'on sache pourquoi sans fouiller le journal de GitHub.
  const url = (process.env.SITE_DATABASE_URL ?? "").trim().replace(/^SITE_DATABASE_URL\s*=\s*/, "").replace(/^["']|["']$/g, "");
  let client = null;
  state.dbError = null;
  try {
    if (!url) throw Object.assign(new Error("secret SITE_DATABASE_URL vide"), { code: "SECRET_VIDE" });
    if (!/^postgres(ql)?:\/\//.test(url)) throw Object.assign(new Error("le secret ne commence pas par postgresql://"), { code: "SECRET_FORMAT" });
    client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000, statement_timeout: 20_000 });
    await client.connect();
    // Bonne base ? Celle du site a la table watchdog_status (046-watchdog-incidents.sql); la base Forge, non.
    const site = (await client.query("select to_regclass('public.watchdog_status') is not null as ok")).rows[0].ok;
    if (!site) throw Object.assign(new Error("le secret pointe vers une autre base que celle du site (Forge ?)"), { code: "MAUVAISE_BASE" });
  } catch (e) {
    await client?.end().catch(() => {});
    state.dbError = { code: e.code ?? e.name ?? "inconnu", at: iso(now) };
    console.log(`Base injoignable pour le chien de garde : ${e.code ?? ""} ${e.message}`);
    client = null;
  }

  const fullPass = !state.lastFullAt || now - new Date(state.lastFullAt) >= 55 * MIN;
  if (fullPass) {
    const background = [];
    if (client) {
      try {
        background.push(...(await backgroundChecks(client)));
      } catch (e) {
        console.log(`Verifications de fond : ${e.message}`);
      }
    }
    background.push(await certificateCheck(), await domainCheck().catch(() => ok("domain", "domaine")));
    results.push(...background);
    tally(state, background);
    state.lastFullAt = iso(now);
  }

  for (const r of results) if (!state.seen.includes(r.category)) state.seen.push(r.category);
  const alerts = [];
  updateIncidents(state, results, alerts);
  state.checkedAt = iso(now);
  state.stats = stats(state);
  state.lights = lights(state);
  await sendAlerts(alerts, state);

  if (client) {
    try {
      await mirror(client, state, fullPass);
    } catch (e) {
      // Code et message de Postgres (ex. table inconnue) : jamais l'adresse ni le mot de passe.
      state.dbError = { code: e.code ?? "recopie", message: String(e.message).slice(0, 160), at: iso(now) };
      console.log(`Recopie dans la base : ${e.message}`);
    }
    await client.end();
  }
  writeFileSync(file, JSON.stringify(state, null, 1));
  console.log(`${state.lights.global} · site ${site.up ? "OK" : "EN PANNE"} ${site.ms} ms · ${Object.keys(state.open).length} panne(s) ouverte(s)`);
}

await main();
