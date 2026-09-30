/* NoMAD DRUgS — moteur de calcul d'échéancier.
   Version 0.1.0.

   Sans aucune dépendance et sans accès au DOM : utilisable tel quel dans un
   navigateur (variable globale NomadEngine) et sous Node (module.exports).
   C'est la seule implémentation du calcul : la page et le serveur l'appellent
   tous deux, aucun des deux ne le réimplémente.

   Les fonctions de calcul sont reprises à l'identique de la page v0.0.10 ;
   seules les entrées et l'horodatage du fichier .ics ont été rendus injectables. */
(function (racine) {
"use strict";

const MOTEUR_VERSION = "0.1.0";

const FALLBACK_ZONES = ["Europe/Paris","Europe/London","Europe/Lisbon","Europe/Madrid","Europe/Berlin","Europe/Rome","Europe/Athens","Europe/Moscow","Africa/Casablanca","Africa/Abidjan","Africa/Lagos","Africa/Cairo","Africa/Nairobi","Africa/Johannesburg","America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Anchorage","America/Toronto","America/Mexico_City","America/Bogota","America/Lima","America/Santiago","America/Sao_Paulo","America/Buenos_Aires","Asia/Jerusalem","Asia/Dubai","Asia/Karachi","Asia/Kolkata","Asia/Kathmandu","Asia/Dhaka","Asia/Bangkok","Asia/Jakarta","Asia/Shanghai","Asia/Hong_Kong","Asia/Singapore","Asia/Seoul","Asia/Tokyo","Australia/Perth","Australia/Sydney","Pacific/Auckland","Pacific/Honolulu"];


function tzOffset(tz, ts) {
  /* Le formatage ne descend pas sous la seconde : on compare à un instant
     tronqué à la seconde, sinon le décalage traîne les millisecondes de ts. */
  const base = Math.floor(ts / 1000) * 1000;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(base))) p[part.type] = part.value;
  let h = parseInt(p.hour, 10);
  if (h === 24) h = 0;
  const asUTC = Date.UTC(+p.year, p.month - 1, +p.day, h, +p.minute, +p.second);
  return asUTC - base;
}

function utcFromLocal(tz, y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = guess - tzOffset(tz, guess);
  ts = guess - tzOffset(tz, ts);
  return ts;
}

function parseTimes(str) {
  const out = [];
  for (const raw of String(str).split(";")) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^(\d{1,2})\s*[:hH]\s*(\d{1,2})$/.exec(s);
    if (!m) return null;
    const hh = +m[1], mm = +m[2];
    if (hh > 23 || mm > 59) return null;
    out.push(hh * 60 + mm);
  }
  if (!out.length) return null;
  return out;
}

function hhmm(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function normalizeShift(mins) {
  let m = ((mins % 1440) + 1440) % 1440;
  if (m >= 720) m -= 1440;
  return m;
}

function ymd(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

function dayIndex(dateStr) {
  const p = ymd(dateStr);
  return p ? Date.UTC(p.y, p.m - 1, p.d) / 86400000 : null;
}

function fromDayIndex(i) {
  const dt = new Date(i * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function isoDay(i) {
  const d = fromDayIndex(i), p = n => String(n).padStart(2, "0");
  return d.y + "-" + p(d.m) + "-" + p(d.d);
}

const MAX_EVENTS = 3000;

const MAX_WALK = 500;

/* Parcourt l'échéancier jour après jour.
   `rem` est le reste à rattraper, en minutes signées : il part du décalage
   initial et se réduit du lag chaque jour. Un changement d'heure légale à
   destination allonge ou raccourcit la journée ; cet écart est réinjecté dans
   `rem` pour être absorbé au même rythme, au lieu d'être encaissé d'un coup.
   `onDay` reçoit chaque journée et peut renvoyer false pour arrêter.
   Renvoie l'indice du premier jour où l'horaire est atteint, ou null. */
function walkSchedule(tzDest, iStart, targets, shift, lag, maxDays, onDay) {
  let rem = shift, prevFirst = null, reached = null;
  for (let d = 0; d <= maxDays; d++) {
    const date = fromDayIndex(iStart + d);
    const T = targets.map(g =>
      utcFromLocal(tzDest, date.y, date.m, date.d, Math.floor(g / 60), g % 60));

    let jump = 0;
    if (prevFirst !== null) {
      jump = (T[0] - prevFirst) / 60000 - 1440;   // 0 sauf changement d'heure légale
      rem += jump;
      rem -= Math.sign(rem) * Math.min(lag, Math.abs(rem));
      if (Math.abs(rem) < 1e-6) rem = 0;
    }
    prevFirst = T[0];

    const arrived = rem === 0;
    if (arrived && reached === null) reached = d;
    if (onDay(d, T, rem, arrived, jump) === false) return reached;
  }
  return reached;
}

function convergenceOffset(v, iStart, targets, shift) {
  let found = null;
  walkSchedule(v.tzDest, iStart, targets, shift, v.lag, MAX_WALK,
    (d, T, rem, arrived) => { if (arrived) { found = d; return false; } });
  return found;
}

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function utf8Width(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c < 0x10000) return 3;
  return 4;
}

function fold(line) {
  if (line.length < 70) return line;
  let out = "", len = 0;
  for (const ch of line) {
    const w = utf8Width(ch);
    if (len + w > 73) { out += "\r\n "; len = 1; }
    out += ch; len += w;
  }
  return out;
}

function icsStamp(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "T" +
         p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
}

let ZONES;
try { ZONES = Intl.supportedValuesOf("timeZone"); }
catch (e) { ZONES = FALLBACK_ZONES; }
if (!ZONES || !ZONES.length) ZONES = FALLBACK_ZONES;
const ZONESET = new Set(ZONES);

/* Accepte les heures sous forme de tableau de minutes ou de chaîne "HH:MM;HH:MM". */
function formatTimes(v) {
  return Array.isArray(v) ? v.map(hhmm).join(";") : (v === null || v === undefined ? "" : String(v));
}

/* Ramène une entrée quelconque à la forme que le calcul attend.
   `targets` absent recopie `pattern` ; une chaîne vide reste une erreur. */
function normaliser(input) {
  const i = input || {};
  const pattern = formatTimes(i.pattern);
  return {
    pattern: pattern,
    targets: (i.targets === null || i.targets === undefined) ? pattern : formatTimes(i.targets),
    subject: String(i.subject === undefined || i.subject === null ? "" : i.subject).trim() || "Prise du traitement",
    description: String(i.description === undefined || i.description === null ? "" : i.description),
    tzOrigin: String(i.tzOrigin === undefined || i.tzOrigin === null ? "" : i.tzOrigin).trim(),
    tzDest: String(i.tzDest === undefined || i.tzDest === null ? "" : i.tzDest).trim(),
    dateStart: String(i.dateStart === undefined || i.dateStart === null ? "" : i.dateStart),
    dateEnd: String(i.dateEnd === undefined || i.dateEnd === null ? "" : i.dateEnd),
    lag: Math.round(+i.lag)
  };
}

function computeSchedule(input) {
  const v = normaliser(input);
  const errors = [];

  const pattern = parseTimes(v.pattern);
  const targets = parseTimes(v.targets);
  if (!pattern) errors.push("Ajoutez au moins une heure de prise habituelle.");
  if (!targets) errors.push("Ajoutez au moins une heure visée sur place.");
  if (!ZONESET.has(v.tzOrigin)) errors.push("Choisissez un fuseau de départ dans la liste proposée.");
  if (!ZONESET.has(v.tzDest)) errors.push("Choisissez un fuseau de destination dans la liste proposée.");

  const iStart = dayIndex(v.dateStart), iEnd = dayIndex(v.dateEnd);
  if (iStart === null) errors.push("Indiquez le premier jour de l\'échéancier.");
  if (iEnd === null) errors.push("Indiquez le dernier jour de l'échéancier, ou videz le champ pour aller jusqu'au jour où l'horaire visé est atteint.");
  if (iStart !== null && iEnd !== null && iEnd < iStart) errors.push("Le dernier jour de l\'échéancier tombe avant le premier.");

  if (pattern && targets && pattern.length !== targets.length)
    errors.push("Il faut autant d'heures visées que d'heures de prise : " + pattern.length + " ici.");

  let shift = null, uniform = true;
  if (pattern && targets && pattern.length === targets.length) {
    const deltas = pattern.map((p, i) => normalizeShift(targets[i] - p));
    uniform = deltas.every(d => d === deltas[0]);
    if (!uniform) {
      errors.push("Les heures visées ne décalent pas toutes les prises du même montant. L'écart entre deux prises doit rester celui de la prescription.");
    }
  }

  if (!v.lag || v.lag < 1) errors.push("Le décalage quotidien doit valoir au moins 1 minute.");

  if (errors.length) return { ok: false, errors };

  const ref = fromDayIndex(iStart);
  const refTs = utcFromLocal(v.tzDest, ref.y, ref.m, ref.d, 12, 0);
  const delta = (tzOffset(v.tzDest, refTs) - tzOffset(v.tzOrigin, refTs)) / 60000;
  shift = normalizeShift((targets[0] - pattern[0]) - delta);

  const dir = shift === 0 ? 0 : (shift > 0 ? 1 : -1);
  const daysAvailable = iEnd - iStart;

  const rows = [], clockChanges = [];
  let truncated = false;
  const reached = walkSchedule(v.tzDest, iStart, targets, shift, v.lag, daysAvailable,
    (d, T, rem, arrived, jump) => {
      if (jump !== 0) clockChanges.push({ day: d, jump });
      for (let k = 0; k < targets.length; k++) {
        if (rows.length >= MAX_EVENTS) { truncated = true; return false; }
        rows.push({ ts: T[k] - rem * 60000, day: d, k, arrived });
      }
    });

  /* La durée du rattrapage se déduit du parcours : elle tient compte des
     changements d'heure, donc elle peut dépasser décalage ÷ lag. */
  const full = reached !== null ? reached : convergenceOffset(v, iStart, targets, shift);
  const daysNeeded = full === null ? null : full;

  /* Les changements d'heure sont séparés selon qu'ils tombent pendant
     l'adaptation ou après : ils n'appellent pas la même explication. */
  const inAdapt = c => daysNeeded === null || c.day <= daysNeeded;

  return {
    ok: true, v, pattern, targets, delta, shift, dir, iStart,
    daysNeeded, daysAvailable, rows, truncated,
    clockChanges: clockChanges.filter(inAdapt),
    clockChangesAfter: clockChanges.filter(c => !inAdapt(c)),
    converges: daysNeeded !== null && daysNeeded <= daysAvailable
  };
}

function convergenceDay(input) {
  const v = normaliser(input);
  const pattern = parseTimes(v.pattern), targets = parseTimes(v.targets);
  const iStart = dayIndex(v.dateStart);
  if (!pattern || !targets || pattern.length !== targets.length) return null;
  if (!ZONESET.has(v.tzOrigin) || !ZONESET.has(v.tzDest)) return null;
  if (iStart === null || !(v.lag >= 1)) return null;
  const ref = fromDayIndex(iStart);
  const refTs = utcFromLocal(v.tzDest, ref.y, ref.m, ref.d, 12, 0);
  const delta = (tzOffset(v.tzDest, refTs) - tzOffset(v.tzOrigin, refTs)) / 60000;
  const shift = normalizeShift((targets[0] - pattern[0]) - delta);
  if (shift === 0) return null;
  const off = convergenceOffset(v, iStart, targets, shift);
  return off === null ? null : iStart + off;
}

function buildIcs(r, options) {
  const v = r.v;
  const opt = options || {};
  const now = icsStamp(opt.now === undefined ? Date.now() : opt.now);
  const rand = opt.uidPrefix === undefined ? Math.random().toString(36).slice(2, 8) : opt.uidPrefix;
  const L = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NoMAD DRUgS//Echeancier " + (opt.appVersion || MOTEUR_VERSION) + "//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + icsEscape(v.subject)
  ];

  const alarm = () => {
    L.push("BEGIN:VALARM");
    L.push("ACTION:DISPLAY");
    L.push("TRIGGER;RELATED=START:PT0S");
    L.push("DESCRIPTION:" + icsEscape(v.subject));
    L.push("END:VALARM");
  };

  r.rows.forEach((row, i) => {
    const desc = [
      v.description,
      /* Le numéro de jour compte l'adaptation : il n'a plus d'objet une fois l'horaire atteint. */
      row.arrived
        ? (r.targets.length > 1 ? "Prise " + (row.k + 1) + " sur " + r.targets.length : "")
        : (r.targets.length > 1
            ? "Prise " + (row.k + 1) + " sur " + r.targets.length + " — jour " + (row.day + 1)
            : "Jour " + (row.day + 1)),
      row.arrived ? "Horaire cible atteint." : "Adaptation en cours."
    ].filter(Boolean).join("\n");

    L.push("BEGIN:VEVENT");
    L.push("UID:" + rand + "-" + i + "@nomaddrugs");
    L.push("DTSTAMP:" + now);
    L.push("SEQUENCE:0");
    L.push("DTSTART:" + icsStamp(row.ts));
    L.push("DTEND:" + icsStamp(row.ts + 5 * 60000));
    L.push("SUMMARY:" + icsEscape(v.subject));
    L.push("DESCRIPTION:" + icsEscape(desc));
    L.push("TRANSP:TRANSPARENT");
    alarm();
    L.push("END:VEVENT");
  });

  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

const API = {
  VERSION: MOTEUR_VERSION,
  ZONES: ZONES,
  ZONESET: ZONESET,
  MAX_EVENTS: MAX_EVENTS,
  connaitFuseau: function (tz) { return ZONESET.has(tz); },
  computeSchedule: computeSchedule,
  convergenceDay: convergenceDay,
  buildIcs: buildIcs,
  parseTimes: parseTimes,
  formatTimes: formatTimes,
  hhmm: hhmm,
  tzOffset: tzOffset,
  utcFromLocal: utcFromLocal,
  dayIndex: dayIndex,
  fromDayIndex: fromDayIndex,
  isoDay: isoDay,
  normalizeShift: normalizeShift
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
racine.NomadEngine = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
