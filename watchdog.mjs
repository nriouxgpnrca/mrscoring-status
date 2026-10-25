/**
 * watchdog.mjs - Chien de garde de MRScoring : verifie le site toutes les 5 min, hors de Vercel et sans acces a la base.
 *
 * Projet : MRScoring - concu par Nelson Rioux, code avec Claude
 * Historique, versions et dates : voir git log / git blame
 *
 * Decisions de Nelson (2026-10-24 et 25) :
 *  - la surveillance tourne hors de ce qu'elle surveille (GitHub Actions, depot public), ne depend ni du PC ni de Vercel;
 *  - une seule source de verite : status.json (branche data), lu par la page status.mrscoring.com ET par l'onglet Sante
 *    du Tableau de bord (plus de copie dans la base, qui divergeait);
 *  - aucun mot de passe de base dans GitHub : les verifications de fond sont faites par le site lui-meme
 *    (/api/health?full=1), le chien de garde les lit comme un visiteur;
 *  - un vrai 5 minutes : le calendrier de GitHub ne passait que toutes les 2 a 2,5 h. Un passage reste donc actif
 *    LOOP_MINUTES (5 h 40 dans GitHub), verifie toutes les 5 min et publie l'etat chaque fois; le workflow relance
 *    ensuite le passage suivant (watchdog.yml). Le calendrier GitHub reste en filet de securite.
 *
 * Toutes les 5 min : le site (page de connexion) et sa base (/api/health). Une fois l'heure : les services de fond
 * (/api/health?full=1 : import, fil, precalcul, remplissage de la base, sauvegarde du jeudi), le certificat https et
 * l'echeance du domaine. Gravite : critique (usagers touches), majeur (service de fond manque), mineur (a surveiller).
 * Courriel aux admins a l'ouverture et a la fermeture d'une panne critique ou majeure, resume le lundi.
 *
 * Usage : node watchdog.mjs <status.json>   (un passage; LOOP_MINUTES=340 PUBLISH=1 pour le mode GitHub)
 * Secrets (facultatifs) : RESEND_API_KEY et ALERT_EMAILS pour les courriels. GITHUB_TOKEN et GITHUB_REPOSITORY
 * (fournis par GitHub) pour publier l'etat sur la branche data.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { connect } from "node:tls";

const SITE = "https://app.mrscoring.com";
const HOST = new URL(SITE).hostname;
const DOMAIN = "mrscoring.com";
const TZ = "America/Toronto";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EVERY = 5 * MIN;
const SLOW_MS = 5000;
const KEEP_DAYS = 90;
const KEEP_INCIDENTS = 200;
const FROM = "MRScoring <veille@mrscoring.com>";

const CATEGORIES = {
  site: { fr: "Site web", en: "Website" },
  base: { fr: "Base de données", en: "Database" },
  donnees: { fr: "Imports et fil", en: "Imports and feed" },
  sauvegarde: { fr: "Sauvegarde", en: "Backup" },
  domaine: { fr: "Domaine et https", en: "Domain and https" },
};
const RANK = { mineur: 1, majeur: 2, critique: 3 };
const COLOR = { 0: "vert", 1: "jaune", 2: "orange", 3: "rouge" };

let now = new Date(); // heure du passage en cours (avancee a chaque tour de la boucle)
const iso = (d) => new Date(d).toISOString();
const dayOf = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
const hourOf = (d) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));
const fmtDuration = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} min` : ms < DAY ? `${(ms / HOUR).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} j`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resultat d'une verification : ok, ou en echec avec une gravite et une raison courte (francais et anglais).
const ok = (key, category) => ({ key, category, ok: true });
const bad = (key, category, severity, fr, en) => ({ key, category, ok: false, severity, reason: fr, reasonEn: en ?? fr });

// ---------------------------------------------------------------------------------------------------- toutes les 5 min

async function fetchTimed(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "MRScoring-watchdog/3.0" }, redirect: "follow" });
    const body = await res.text();
    return { status: res.status, ms: Date.now() - started, body };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, error: e.cause?.code ?? e.name ?? String(e) };
  }
}

const parse = (body) => {
  try {
    return JSON.parse(body ?? "");
  } catch {
    return null;
  }
};

// Le site et sa base. Un echec est revu 20 s plus tard : un accroc reseau n'est pas une panne.
async function probeSite() {
  let page = await fetchTimed(`${SITE}/login`);
  let health = await fetchTimed(`${SITE}/api/health`);
  if (page.status !== 200 || health.status !== 200) {
    await sleep(20_000);
    page = await fetchTimed(`${SITE}/login`);
    health = await fetchTimed(`${SITE}/api/health`);
  }
  const why = (r) => (r.status ? `HTTP ${r.status}` : r.error === "TimeoutError" ? "aucune réponse en 20 s" : r.error);
  const whyEn = (r) => (r.status ? `HTTP ${r.status}` : r.error === "TimeoutError" ? "no response within 20 s" : r.error);
  const db = parse(health.body)?.db;
  const results = [];
  if (page.status !== 200) results.push(bad("site", "site", "critique", `Site inaccessible : ${why(page)}`, `Website unreachable: ${whyEn(page)}`));
  else if (page.ms > SLOW_MS) results.push(bad("site", "site", "mineur", `Site lent : ${(page.ms / 1000).toFixed(1)} s`, `Website slow: ${(page.ms / 1000).toFixed(1)} s`));
  else results.push(ok("site", "site"));
  if (page.status === 200 && (health.status !== 200 || db !== "ok")) {
    results.push(bad("base", "base", "critique", "Le site ne joint plus sa base de données", "The website cannot reach its database"));
  } else results.push(ok("base", "base"));
  return { results, up: page.status === 200 && health.status === 200 && db === "ok", ms: page.ms };
}

// -------------------------------------------------------------------------------------------------- une fois l'heure

// Services de fond, verifies par le site lui-meme (aucun acces a la base ici). Site en panne : rien de neuf a lire.
async function backgroundChecks() {
  const r = await fetchTimed(`${SITE}/api/health?full=1`);
  const checks = parse(r.body)?.checks;
  if (r.status !== 200) return [];
  if (!Array.isArray(checks)) return [bad("background", "donnees", "mineur", "Vérifications de fond indisponibles", "Background checks unavailable")];
  return [ok("background", "donnees"), ...checks];
}

function certificateCheck() {
  return new Promise((done) => {
    const socket = connect({ host: HOST, port: 443, servername: HOST, timeout: 15_000 }, () => {
      const left = new Date(socket.getPeerCertificate().valid_to) - now;
      socket.end();
      const d = Math.floor(left / DAY);
      done(left < 7 * DAY ? bad("https", "domaine", "majeur", `Certificat https expire dans ${d} j`, `https certificate expires in ${d} days`)
        : left < 21 * DAY ? bad("https", "domaine", "mineur", `Certificat https expire dans ${d} j`, `https certificate expires in ${d} days`)
        : ok("https", "domaine"));
    });
    socket.on("error", () => done(ok("https", "domaine"))); // une vraie panne https est vue par la verification du site
    socket.on("timeout", () => { socket.destroy(); done(ok("https", "domaine")); });
  });
}

async function domainCheck() {
  try {
    const res = await fetch(`https://rdap.verisign.com/com/v1/domain/${DOMAIN}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return ok("domain", "domaine"); // registre momentanement illisible : pas une panne du site
    const exp = (await res.json()).events?.find((e) => e.eventAction === "expiration")?.eventDate;
    if (!exp) return ok("domain", "domaine");
    const d = Math.floor((new Date(exp) - now) / DAY);
    return d < 30 ? bad("domain", "domaine", "majeur", `Domaine ${DOMAIN} expire dans ${d} j`, `Domain ${DOMAIN} expires in ${d} days`)
      : d < 60 ? bad("domain", "domaine", "mineur", `Domaine ${DOMAIN} expire dans ${d} j`, `Domain ${DOMAIN} expires in ${d} days`)
      : ok("domain", "domaine");
  } catch {
    return ok("domain", "domaine");
  }
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

function tally(state, category, good) {
  const day = dayOf(now);
  state.daily[day] ??= {};
  const t = (state.daily[day][category] ??= { checks: 0, ok: 0 });
  t.checks++;
  if (good) t.ok++;
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

// ---------------------------------------------------------------------------------------------------------- courriels

async function email(subject, text) {
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!key || !to.length) return console.log(`(courriel non envoye, secrets absents) ${subject}`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, text }),
  });
  if (!res.ok) console.log(`Resend ${res.status} : ${(await res.text()).slice(0, 200)}`);
}

const SEVERITY_LABEL = { critique: "PANNE CRITIQUE", majeur: "Panne majeure", mineur: "À surveiller" };
const PAGE = "https://status.mrscoring.com";
const DASHBOARD = `${SITE}/admin/tableau-de-bord?vue=sante`;
const SUPABASE = "https://supabase.com/dashboard/project/ryxywyvantasahqpnjds";
const VERCEL = "https://vercel.com/mrscoring/mrscoring-web";

// Quoi faire, par service : les memes leviers que la fiche de panne de l'onglet Sante (mrscoring-web, playbook.ts).
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

// ---------------------------------------------------------------------------------------------------------- publier

// Etat sur la branche data, en un seul commit remplace a chaque fois (pas d'historique qui grossit). Le jeton n'est
// jamais affiche (sortie de git masquee).
function publish(file) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;
  const dir = dirname(resolve(file));
  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: "ignore" });
  try {
    if (!existsSync(resolve(dir, ".git"))) run("git init -q -b data");
    run("git add status.json");
    let first = false;
    try {
      run("git rev-parse -q --verify HEAD");
    } catch {
      first = true;
    }
    // Premier tour : un commit; ensuite, le meme commit est remplace (--amend) : un seul commit sur data.
    run(`git -c user.name="MRScoring watchdog" -c user.email="veille@mrscoring.com" commit -q --allow-empty ${first ? "" : "--amend"} -m "Etat du ${iso(now)}"`);
    run(`git push -q -f "https://x-access-token:${token}@github.com/${repo}.git" HEAD:data`);
  } catch {
    console.log("Publication de l'etat : echec (reessai au prochain tour)");
  }
}

// ------------------------------------------------------------------------------------------------------------ un tour

async function round(state) {
  const results = [];
  const site = await probeSite();
  results.push(...site.results);
  state.recent = [...state.recent.filter((p) => now - new Date(p.at) <= DAY), { at: iso(now), up: site.up, ms: site.ms }];
  tally(state, "disponibilite", site.up);

  if (!state.lastFullAt || now - new Date(state.lastFullAt) >= 55 * MIN) {
    const background = [...(await backgroundChecks()), await certificateCheck(), await domainCheck()];
    for (const r of background) tally(state, r.category, r.ok);
    results.push(...background);
    state.lastFullAt = iso(now);
  }

  for (const r of results) if (!state.seen.includes(r.category)) state.seen.push(r.category);
  const alerts = [];
  updateIncidents(state, results, alerts);
  state.checkedAt = iso(now);
  state.stats = stats(state);
  state.lights = lights(state);
  await sendAlerts(alerts, state);
  console.log(`${iso(now)} ${state.lights.global} · site ${site.up ? "OK" : "EN PANNE"} ${site.ms} ms · ${Object.keys(state.open).length} panne(s) ouverte(s)`);
}

async function main() {
  const file = process.argv[2] ?? "status.json";
  mkdirSync(dirname(resolve(file)), { recursive: true });
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
  for (const old of ["dbError", "lastWeeklyEmail"]) delete state[old]; // champs de l'ancienne version

  const end = Date.now() + Number(process.env.LOOP_MINUTES ?? 0) * MIN;
  for (;;) {
    now = new Date();
    await round(state);
    writeFileSync(file, JSON.stringify(state, null, 1));
    if (process.env.PUBLISH === "1") publish(file);
    // Prochain tour au prochain multiple de 5 min, tant qu'il reste du temps pour un tour complet.
    const next = Math.ceil((Date.now() + 1000) / EVERY) * EVERY;
    if (next + MIN > end) break;
    await sleep(next - Date.now());
  }
}

await main();
