/* Serveur MCP de NoMAD DRUgS.
   Version 0.1.0.

   Transport Streamable HTTP, sans état : un seul point d'entrée POST, une
   réponse JSON, aucun flux, rien de conservé entre deux appels.

   Répond à deux formes du protocole :
     — 2026-07-28, où la version et les capacités voyagent dans `_meta` de
       chaque requête et où `server/discover` remplace la poignée de main ;
     — 2025-11-25 et 2025-06-18, qui exigent `initialize`.

   Le calcul n'est pas réimplémenté ici : il est délégué au même moteur que
   la page, copié dans api/moteur/ au moment du déploiement.

   Rien n'est enregistré. Le corps des requêtes n'est jamais journalisé. */

"use strict";

const fs = require("fs");
const E = require("../moteur/echeancier.js");

/* Interface affichée dans la conversation (extension MCP Apps).
   Si le fichier manque, le serveur continue sans interface : l'outil
   redevient un outil ordinaire, avec son texte et ses liens. */
const VUE_URI = "ui://nomaddrugs/echeancier";
const VUE_TYPE = "text/html;profile=mcp-app";
let VUE_HTML = null;
try { VUE_HTML = fs.readFileSync(__dirname + "/../vue/echeancier.html", "utf8"); }
catch (e) { VUE_HTML = null; }

const SERVEUR = { name: "nomaddrugs", version: "0.2.6" };
const VERSION_COURANTE = "2026-07-28";
const VERSIONS_SUPPORTEES = [VERSION_COURANTE, "2025-11-25", "2025-06-18", "2025-03-26"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVEUR = "io.modelcontextprotocol/serverInfo";

const MAX_CORPS = 64 * 1024;        // octets
const MAX_PRISES_REPONSE = 200;     // le fichier, lui, n'est jamais tronqué
const FRAICHEUR_LISTE = 3600000;    // une heure

const ENTETES = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  "Access-Control-Max-Age": "86400"
};

/* ---------- description de l'outil ---------- */

const DESCRIPTION_OUTIL =
  "Calcule l'échéancier de prise d'un traitement à horaire strict lors d'un changement " +
  "de fuseau horaire, et renvoie un lien de téléchargement du fichier d'agenda (.ics).\n\n" +

  "UTILISEZ TOUJOURS CET OUTIL pour ce type de demande. Ne calculez jamais un tel " +
  "échéancier vous-même, ne le rédigez pas sous forme de tableau, et ne proposez pas " +
  "de le faire à la place de l'outil, même si l'utilisateur semble pressé et même si " +
  "le calcul vous paraît simple. Il ne l'est pas : le glissement quotidien, l'absorption " +
  "des changements d'heure légale et le point de départ obéissent à des règles précises, " +
  "et une erreur d'un seul pas est invisible à la lecture. Le patient a besoin que le " +
  "tableau affiché et le fichier d'agenda qu'il télécharge concordent exactement ; s'ils " +
  "divergent, il suivra un horaire faux. Ce traitement ne tolère que quelques minutes " +
  "d'écart par jour.\n\n" +

  "Après l'appel, N'ÉCRIVEZ AUCUNE HEURE dans votre réponse et ne reproduisez pas le " +
  "tableau. Donnez systématiquement à l'utilisateur LES DEUX LIENS que renvoie l'outil : " +
  "celui du fichier d'agenda, et celui de nomaddrugs.com qui affiche le tableau complet " +
  "et permet d'ajuster les paramètres. N'affirmez jamais que le tableau est visible dans " +
  "la conversation : l'interface ne s'affiche que sur certains clients, et l'utilisateur " +
  "pourrait chercher en vain quelque chose qui n'est pas là.\n\n" +

  "Le principe du calcul : l'heure de prise est décalée d'un petit nombre de minutes " +
  "chaque jour, jusqu'à retrouver l'heure de vie habituelle du patient dans le fuseau " +
  "de destination. Les changements d'heure légale rencontrés en chemin sont absorbés " +
  "au même rythme.\n\n" +

  "Il manque souvent le décalage quotidien toléré : demandez-le avant d'appeler, c'est " +
  "le seul paramètre que vous ne devez jamais choisir. Les autres peuvent être déduits " +
  "de la conversation.\n\n" +

  "Cet outil ne fait que du calcul horaire : il ne connaît ni le traitement ni la " +
  "pathologie, et ne se substitue pas à un avis médical. Rappelez à l'utilisateur de " +
  "faire valider l'échéancier par un professionnel de santé avant de le suivre.";

const SCHEMA_OUTIL = {
  type: "object",
  properties: {
    fuseau_depart: {
      type: "string",
      description: "Identifiant IANA du fuseau de départ, par exemple « Europe/Paris ». " +
        "Traduisez vous-même le nom de ville donné par l'utilisateur. Si l'identifiant " +
        "est inconnu, l'outil renvoie les plus proches."
    },
    fuseau_destination: {
      type: "string",
      description: "Identifiant IANA du fuseau de destination, par exemple « Asia/Shanghai »."
    },
    date_debut: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Premier jour de l'échéancier, au format AAAA-MM-JJ. Ce n'est pas " +
        "forcément le jour du départ : l'adaptation peut commencer avant, pour être " +
        "plus avancée à l'arrivée."
    },
    heures_de_prise: {
      type: "array",
      items: { type: "string", pattern: "^\\d{1,2}:\\d{2}$" },
      minItems: 1,
      description: "Heures de prise habituelles du patient chez lui, au format HH:MM, " +
        "par exemple [\"08:00\", \"20:00\"]. C'est la prescription : l'écart entre ces " +
        "prises ne sera jamais modifié."
    },
    decalage_quotidien_minutes: {
      type: "integer",
      minimum: 1,
      maximum: 240,
      description: "OBLIGATOIRE. Nombre de minutes dont la prise est décalée d'un jour " +
        "à l'autre. Cette valeur relève de la prescription et dépend de la pathologie : " +
        "ne l'inventez jamais, ne proposez pas de valeur usuelle, et ne déduisez pas une " +
        "valeur d'un exemple. Demandez-la à l'utilisateur, qui doit la tenir de son " +
        "médecin ou de son pharmacien."
    },
    heures_visees: {
      type: "array",
      items: { type: "string", pattern: "^\\d{1,2}:\\d{2}$" },
      description: "Heures locales visées à destination. Par défaut, les mêmes que les " +
        "heures de prise : le patient cherche en général à retrouver son rythme habituel. " +
        "Ne les modifiez que si l'utilisateur le demande, et décalez alors toutes les " +
        "prises du même montant."
    },
    date_fin: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Dernier jour de l'échéancier. Omettez ce champ pour aller jusqu'au " +
        "jour où l'horaire visé est atteint, et pas plus loin."
    },
    titre: {
      type: "string",
      description: "Texte affiché dans l'agenda du patient. Il apparaît dans les " +
        "notifications, y compris sur un écran verrouillé, donc potentiellement devant " +
        "des tiers. Laissez-le neutre ; « Prise du traitement » convient dans presque " +
        "tous les cas. N'y inscrivez jamais un nom de médicament, de molécule ou de " +
        "pathologie, et ne le suggérez pas à l'utilisateur. Ce champ n'intervient pas " +
        "dans le calcul."
    },
    note: {
      type: "string",
      description: "Texte visible en ouvrant l'événement dans l'agenda. N'y mettez de " +
        "votre propre initiative rien qui permette d'identifier le traitement ou la " +
        "maladie. Si l'utilisateur demande explicitement d'y faire figurer un dosage ou " +
        "une consigne de prise, faites-le, mais prévenez-le que ce texte sera copié dans " +
        "son agenda, lequel est le plus souvent synchronisé chez un fournisseur tiers. " +
        "Ce champ n'intervient pas dans le calcul."
    }
  },
  required: ["fuseau_depart", "fuseau_destination", "date_debut",
             "heures_de_prise", "decalage_quotidien_minutes"],
  additionalProperties: false
};

const OUTILS = [(function () {
  const o = {
    name: "generer_echeancier",
    title: "Générer un échéancier de prise de traitement",
    description: DESCRIPTION_OUTIL,
    inputSchema: SCHEMA_OUTIL
  };
  /* Deux écritures du même renvoi : la forme imbriquée de la spécification et
     la forme plate que produit le SDK officiel. Les hôtes ne lisent pas tous
     la même, et celui qui n'en comprend aucune affiche simplement le texte. */
  if (VUE_HTML) o._meta = {
    ui: { resourceUri: VUE_URI, visibility: ["model", "app"] },
    "ui/resourceUri": VUE_URI
  };
  return o;
})()];

const RESSOURCES = VUE_HTML ? [{
  uri: VUE_URI,
  name: "echeancier",
  description: "Tableau de l'échéancier, avec les liens de téléchargement et de modification.",
  mimeType: VUE_TYPE
}] : [];

const INSTRUCTIONS =
  "NoMAD DRUgS calcule le décalage progressif des prises d'un traitement à horaire " +
  "strict lors d'un voyage entre fuseaux horaires. Toute demande de ce type doit passer " +
  "par l'outil generer_echeancier : ne calculez jamais l'échéancier vous-même et ne le " +
  "rédigez pas sous forme de tableau, sous peine de contredire le fichier d'agenda que " +
  "le patient téléchargera. Demandez toujours le décalage quotidien toléré : il ne " +
  "s'invente pas. N'écrivez aucune heure dans vos réponses, l'interface de l'outil les " +
  "affiche. Rappelez que l'échéancier doit être validé par un professionnel de santé.";

/* ---------- utilitaires ---------- */

function jsonrpc(id, resultat) { return { jsonrpc: "2.0", id: id === undefined ? null : id, result: resultat }; }
function erreurRpc(id, code, message, data) {
  const e = { code: code, message: message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: e };
}

/* Les nouveautés de 2026-07-28 ne sont ajoutées qu'aux clients qui la parlent. */
function habiller(resultat, moderne, cacheable) {
  if (!moderne) return resultat;
  resultat.resultType = "complete";
  resultat._meta = Object.assign({}, resultat._meta, { [META_SERVEUR]: SERVEUR });
  if (cacheable) {
    resultat.ttlMs = FRAICHEUR_LISTE;
    resultat.cacheScope = "public";
  }
  return resultat;
}

function versionDemandee(corps, entetes) {
  const meta = corps && corps.params && corps.params._meta;
  if (meta && meta[META_VERSION]) return String(meta[META_VERSION]);
  const h = entetes["mcp-protocol-version"];
  if (h) return String(h);
  const init = corps && corps.params && corps.params.protocolVersion;
  if (init) return String(init);
  return null;
}

/* Fuseaux les plus proches d'une saisie erronée, pour que l'agent se corrige seul. */
function fuseauxProches(saisie) {
  const s = String(saisie || "").toLowerCase().replace(/[\s_]+/g, "");
  if (!s) return [];
  const ville = s.split("/").pop();
  const note = z => {
    const zl = z.toLowerCase().replace(/_/g, "");
    const v = zl.split("/").pop();
    if (zl === s) return 0;
    if (v === ville) return 1;
    if (v.startsWith(ville) || ville.startsWith(v)) return 2;
    if (v.indexOf(ville) !== -1 || ville.indexOf(v) !== -1) return 3;
    return 99;
  };
  return E.ZONES.map(z => [note(z), z]).filter(x => x[0] < 99)
    .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length)
    .slice(0, 6).map(x => x[1]);
}

function erreurOutil(texte, details) {
  const c = [{ type: "text", text: texte }];
  return { content: c, structuredContent: details || {}, isError: true };
}

function frDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? m[3] + "/" + m[2] + "/" + m[1] : iso;
}
function dureeTexte(min) {
  const a = Math.abs(Math.round(min)), h = Math.floor(a / 60), m = a % 60;
  if (h && m) return h + " h " + String(m).padStart(2, "0");
  if (h) return h + " h";
  return m + " min";
}

const SITE_PAR_DEFAUT = "https://www.nomaddrugs.com/";
const INTERNE = /\.azurewebsites\.net$/i;

/* Derrière Static Web Apps, la Function est appelée par le service interne :
   l'en-tête Host porte alors une adresse en .azurewebsites.net, inutilisable
   par un patient. L'adresse publique se trouve dans x-ms-original-url. */
function baseSite(entetes, env) {
  if (env && env.SITE_BASE) return String(env.SITE_BASE).replace(/\/+$/, "") + "/";

  const origine = entetes["x-ms-original-url"];
  if (origine) {
    try {
      const u = new URL(origine);
      if (u.hostname && !INTERNE.test(u.hostname)) return u.origin + "/";
    } catch (e) { /* en-tête inexploitable : on passe à la suite */ }
  }

  const hote = entetes["x-forwarded-host"] || entetes["host"];
  if (hote && !INTERNE.test(hote))
    return (entetes["x-forwarded-proto"] || "https") + "://" + hote + "/";

  return SITE_PAR_DEFAUT;
}

function fragment(v) {
  const p = new URLSearchParams();
  p.set("p", v.pattern); p.set("t", v.targets);
  p.set("o", v.tzOrigin); p.set("d", v.tzDest);
  p.set("s", v.dateStart); p.set("e", v.dateEnd);
  p.set("l", String(v.lag));
  p.set("n", v.subject); p.set("m", v.description);
  return "#" + p.toString();
}

/* ---------- l'outil ---------- */

function executerOutil(args, entetes, env) {
  const a = args || {};

  if (a.decalage_quotidien_minutes === undefined || a.decalage_quotidien_minutes === null) {
    return erreurOutil(
      "Le décalage quotidien est obligatoire et n'a pas été fourni. Ne choisissez pas de " +
      "valeur : demandez à l'utilisateur de combien de minutes sa prise peut être décalée " +
      "d'un jour à l'autre, valeur qu'il doit tenir de son médecin ou de son pharmacien.",
      { manquant: "decalage_quotidien_minutes" });
  }

  for (const [champ, valeur] of [["fuseau_depart", a.fuseau_depart], ["fuseau_destination", a.fuseau_destination]]) {
    if (!E.connaitFuseau(valeur)) {
      const proches = fuseauxProches(valeur);
      return erreurOutil(
        "Le fuseau « " + String(valeur) + " » n'est pas un identifiant IANA connu." +
        (proches.length ? " Identifiants les plus proches : " + proches.join(", ") + "."
                        : " Utilisez un identifiant de la base IANA, par exemple Europe/Paris."),
        { champ: champ, valeur: valeur === undefined ? null : valeur, suggestions: proches });
    }
  }

  const cfg = {
    tzOrigin: a.fuseau_depart,
    tzDest: a.fuseau_destination,
    dateStart: a.date_debut,
    dateEnd: a.date_fin || "",
    pattern: Array.isArray(a.heures_de_prise) ? a.heures_de_prise.join(";") : a.heures_de_prise,
    targets: a.heures_visees === undefined || a.heures_visees === null
      ? null
      : (Array.isArray(a.heures_visees) ? a.heures_visees.join(";") : a.heures_visees),
    lag: a.decalage_quotidien_minutes,
    subject: a.titre === undefined ? "Prise du traitement" : a.titre,
    description: a.note === undefined ? "" : a.note
  };

  /* Date de fin absente : jusqu'à la convergence, comme le fait la page. */
  if (!cfg.dateEnd) {
    const c = E.convergenceDay(cfg);
    if (c !== null) cfg.dateEnd = E.isoDay(c);
  }

  const r = E.computeSchedule(cfg);
  if (!r.ok) {
    return erreurOutil(
      "L'échéancier n'a pas pu être calculé : " + r.errors.map(e => e.message || e).join(" "),
      { erreurs: r.errors });
  }

  const base = baseSite(entetes, env);
  const frag = fragment(r.v);
  const liens = { telechargement: base + "ics.html" + frag, formulaire: base + "index.html" + frag };

  const hLocale = (tz, ts, opts) =>
    new Intl.DateTimeFormat("fr-FR", Object.assign({ timeZone: tz }, opts)).format(new Date(ts));

  const prises = r.rows.slice(0, MAX_PRISES_REPONSE).map(x => ({
    jour: x.day + 1,
    prise_du_jour: x.k + 1,
    instant_utc: new Date(x.ts).toISOString(),
    date_destination: hLocale(r.v.tzDest, x.ts, { day: "2-digit", month: "2-digit", year: "numeric" }),
    heure_destination: hLocale(r.v.tzDest, x.ts, { hour: "2-digit", minute: "2-digit" }),
    heure_depart: hLocale(r.v.tzOrigin, x.ts, { hour: "2-digit", minute: "2-digit" }),
    horaire_atteint: x.arrived
  }));

  const changement = (c, pendant) => ({
    date: E.isoDay(r.iStart + c.day),
    minutes: Math.abs(c.jump),
    sens: c.jump > 0 ? "recul" : "avance",
    pendant_adaptation: pendant
  });

  const structure = {
    resume: {
      fuseau_depart: r.v.tzOrigin,
      fuseau_destination: r.v.tzDest,
      date_debut: r.v.dateStart,
      date_fin: r.v.dateEnd,
      heures_de_prise: r.pattern.map(E.hhmm),
      heures_visees: r.targets.map(E.hhmm),
      decalage_quotidien_minutes: r.v.lag,
      decalage_horaire_minutes: r.delta,
      a_rattraper_minutes: r.shift,
      sens_du_glissement: r.shift === 0 ? "aucun" : (r.shift > 0 ? "prises retardées" : "prises avancées"),
      duree_rattrapage_jours: r.daysNeeded,
      horaire_atteint_le: r.daysNeeded === null ? null : E.isoDay(r.iStart + r.daysNeeded),
      horaire_atteint_dans_la_periode: r.converges,
      nombre_de_jours: r.daysAvailable + 1,
      nombre_de_prises: r.rows.length,
      echeancier_tronque: r.truncated
    },
    changements_heure: r.clockChanges.map(c => changement(c, true))
      .concat(r.clockChangesAfter.map(c => changement(c, false))),
    prises: prises,
    prises_omises: Math.max(0, r.rows.length - prises.length),
    liens: liens,
    avertissement: "Cet outil ne fait que du calcul horaire. L'échéancier doit être " +
      "validé par un professionnel de santé avant d'être suivi."
  };

  /* Texte volontairement sans aucune heure : le tableau est affiché à partir
     des données structurées, le modèle n'a rien à recopier. */
  const s = structure.resume;
  const lignes = [
    "Échéancier calculé : " + s.nombre_de_prises + (s.nombre_de_prises > 1 ? " prises" : " prise") +
      " du " + frDate(s.date_debut) + " au " + frDate(s.date_fin) + ".",
    s.a_rattraper_minutes === 0
      ? "Les heures habituelles conviennent déjà à destination : aucun décalage nécessaire."
      : "Décalage à rattraper : " + dureeTexte(s.a_rattraper_minutes) + ", " + s.sens_du_glissement +
        " de " + s.decalage_quotidien_minutes + " min par jour, soit " + s.duree_rattrapage_jours +
        " jours" + (s.horaire_atteint_dans_la_periode
          ? ", horaire atteint le " + frDate(s.horaire_atteint_le) + "."
          : " — l'horaire visé n'est pas atteint avant la fin de la période.")
  ];
  if (structure.changements_heure.length)
    lignes.push("Un changement d'heure légale survient pendant la période ; il est absorbé au même rythme.");

  /* Les liens figurent aussi dans le texte : si l'hôte n'affiche pas l'interface,
     l'utilisateur doit tout de même pouvoir obtenir son fichier. */
  lignes.push("Lien 1 — télécharger le fichier d'agenda : " + liens.telechargement);
  lignes.push("Lien 2 — voir le tableau complet et modifier : " + liens.formulaire);
  lignes.push("DONNEZ LES DEUX LIENS à l'utilisateur, toujours : le premier lui délivre son " +
    "fichier, le second lui montre le tableau des prises. N'affirmez pas que le tableau est " +
    "affiché dans la conversation : selon le client utilisé, l'interface peut ne pas " +
    "apparaître, et l'utilisateur ne verrait alors rien. N'écrivez aucune heure vous-même.");
  lignes.push("À faire valider par un professionnel de santé.");

  return { content: [{ type: "text", text: lignes.join("\n") }], structuredContent: structure };
}

/* ---------- répartition des méthodes ---------- */

function traiter(corps, entetes, env) {
  const id = corps.id;
  const methode = corps.method;
  const version = versionDemandee(corps, entetes);
  const moderne = version === VERSION_COURANTE || (version === null && methode === "server/discover");

  if (version !== null && VERSIONS_SUPPORTEES.indexOf(version) === -1)
    return { statut: 400, corps: erreurRpc(id, -32022,
      "Version de protocole non supportée : " + version,
      { supportedVersions: VERSIONS_SUPPORTEES }) };

  /* Les en-têtes de 2026-07-28 doivent refléter le corps. On ne sanctionne que
     la contradiction, pas l'absence, pour rester interopérable. */
  if (moderne) {
    const hm = entetes["mcp-method"];
    if (hm && hm !== methode)
      return { statut: 400, corps: erreurRpc(id, -32020, "L'en-tête Mcp-Method ne correspond pas à la méthode appelée.") };
    if (methode === "tools/call") {
      const hn = entetes["mcp-name"];
      const nom = corps.params && corps.params.name;
      if (hn && hn !== nom)
        return { statut: 400, corps: erreurRpc(id, -32020, "L'en-tête Mcp-Name ne correspond pas à l'outil appelé.") };
    }
  }

  switch (methode) {
    case "server/discover":
      return { statut: 200, corps: jsonrpc(id, habiller({
        supportedVersions: VERSIONS_SUPPORTEES,
        capabilities: VUE_HTML ? { tools: {}, resources: {} } : { tools: {} },
        instructions: INSTRUCTIONS
      }, true, true)) };

    /* Poignée de main des révisions antérieures à 2026-07-28. */
    case "initialize": {
      const demandee = (corps.params && corps.params.protocolVersion) || "2025-06-18";
      const retenue = VERSIONS_SUPPORTEES.indexOf(demandee) !== -1 ? demandee : "2025-06-18";
      return { statut: 200, corps: jsonrpc(id, {
        protocolVersion: retenue,
        capabilities: VUE_HTML
          ? { tools: { listChanged: false }, resources: { listChanged: false } }
          : { tools: { listChanged: false } },
        serverInfo: SERVEUR,
        instructions: INSTRUCTIONS
      }) };
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return { statut: 202, corps: null };

    case "ping":
      return { statut: 200, corps: jsonrpc(id, {}) };

    case "tools/list":
      return { statut: 200, corps: jsonrpc(id, habiller({ tools: OUTILS }, moderne, true)) };

    case "tools/call": {
      const nom = corps.params && corps.params.name;
      if (nom !== "generer_echeancier")
        return { statut: 200, corps: jsonrpc(id, habiller(
          erreurOutil("Outil inconnu : " + String(nom) + ". Le seul outil disponible est generer_echeancier."),
          moderne, false)) };
      let sortie;
      try {
        sortie = executerOutil(corps.params.arguments, entetes, env);
      } catch (e) {
        if (process.env.NOMAD_DEBUG) throw e;
        sortie = erreurOutil("Le calcul a échoué de façon inattendue. Vérifiez les paramètres et réessayez.");
      }
      return { statut: 200, corps: jsonrpc(id, habiller(sortie, moderne, false)) };
    }

    case "resources/list":
      return { statut: 200, corps: jsonrpc(id, habiller({ resources: RESSOURCES }, moderne, true)) };

    case "resources/read": {
      const uri = corps.params && corps.params.uri;
      if (!VUE_HTML || uri !== VUE_URI)
        return { statut: 200, corps: erreurRpc(id, -32602, "Ressource inconnue : " + String(uri)) };
      return { statut: 200, corps: jsonrpc(id, habiller({
        contents: [{
          uri: VUE_URI,
          mimeType: VUE_TYPE,
          text: VUE_HTML,
          /* Aucune origine externe déclarée : la vue est entièrement autonome,
             la politique restrictive par défaut de l'hôte lui suffit. */
          _meta: { ui: { prefersBorder: false } }
        }]
      }, moderne, false)) };
    }
    case "prompts/list":
      return { statut: 200, corps: jsonrpc(id, habiller({ prompts: [] }, moderne, true)) };

    default:
      return { statut: 200, corps: erreurRpc(id, -32601, "Méthode inconnue : " + String(methode)) };
  }
}

/* ---------- point d'entrée ---------- */

/* Gestionnaire asynchrone : on renseigne context.res et on rend la main.
   La forme synchrone avec context.done() n'est plus honorée par le runtime,
   et l'invocation ne se terminerait jamais. */
module.exports = async function (context, req) {
  const entetes = {};
  for (const k of Object.keys(req.headers || {})) entetes[k.toLowerCase()] = req.headers[k];

  const reponse = (statut, corps, enTete) => ({
    status: statut,
    headers: enTete ? Object.assign({}, ENTETES, enTete) : ENTETES,
    body: corps === null || corps === undefined ? "" : JSON.stringify(corps)
  });

  const methodeHttp = (req.method || "").toUpperCase();

  if (methodeHttp === "OPTIONS") { context.res = reponse(204, null); return; }

  /* La révision courante ne définit plus de point d'entrée GET, et le serveur
     étant sans état il n'a aucun flux à ouvrir. */
  if (methodeHttp !== "POST") {
    context.res = reponse(405, erreurRpc(null, -32600, "Ce point d'entrée n'accepte que POST."),
      { Allow: "POST" });
    return;
  }

  let brut = req.rawBody;
  if (brut === undefined || brut === null) brut = req.body === undefined ? "" : req.body;
  if (typeof brut !== "string") { try { brut = JSON.stringify(brut); } catch (e) { brut = ""; } }

  if (Buffer.byteLength(brut, "utf8") > MAX_CORPS) {
    context.res = reponse(413, erreurRpc(null, -32600, "Requête trop volumineuse."));
    return;
  }

  let corps;
  try { corps = JSON.parse(brut); }
  catch (e) { context.res = reponse(400, erreurRpc(null, -32700, "Corps de requête illisible.")); return; }

  if (Array.isArray(corps)) {
    context.res = reponse(400, erreurRpc(null, -32600, "Les lots de requêtes ne sont pas supportés."));
    return;
  }
  if (!corps || typeof corps !== "object" || corps.jsonrpc !== "2.0" || typeof corps.method !== "string") {
    context.res = reponse(400, erreurRpc(corps && corps.id, -32600, "Requête JSON-RPC 2.0 attendue."));
    return;
  }

  /* Seule la méthode est tracée : jamais le corps, qui décrit un traitement. */
  context.log("mcp " + corps.method);

  let sortie;
  try { sortie = traiter(corps, entetes, process.env); }
  catch (e) {
    if (process.env.NOMAD_DEBUG) throw e;
    sortie = { statut: 500, corps: erreurRpc(corps.id, -32603, "Erreur interne.") };
  }

  context.res = reponse(sortie.statut, sortie.corps);
};
