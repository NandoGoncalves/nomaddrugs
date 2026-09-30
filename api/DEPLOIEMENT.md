# Déploiement de l'API

## Arborescence attendue

```
index.html
ics.html
moteur/
    echeancier.js        ← source unique du calcul
api/
    host.json
    package.json
    mcp/
        function.json
        index.js
    moteur/
        echeancier.js    ← copie fabriquée au déploiement, jamais commitée
```

Le dossier `api` est construit isolément par Azure et ne peut pas remonter
chercher un fichier au-dessus de lui : `require("../moteur/echeancier.js")`
depuis `api/mcp/` ne fonctionne que si la copie existe dans `api/moteur/`.
La source reste unique — la copie est un artefact de déploiement.

## À ajouter dans `.gitignore`

```
api/moteur/
```

## À modifier dans le workflow GitHub Actions

Avant l'étape `Azure/static-web-apps-deploy`, insérer :

```yaml
      - name: Copier le moteur dans l'API
        run: |
          mkdir -p api/moteur
          cp moteur/echeancier.js api/moteur/echeancier.js
```

Puis, dans les `with:` de l'étape de déploiement, remplacer :

```yaml
          api_location: ""
```

par :

```yaml
          api_location: "api"
```

## Version de Node

Les Functions managées de Static Web Apps acceptent Node 12 à 20, **pas au-delà**.
Deux fichiers doivent s'accorder :

- `api/package.json` → `"engines": { "node": "20" }` indique à Oryx quelle
  version installer au moment de la construction ;
- `staticwebapp.config.json`, à la racine du site → `"platform": { "apiRuntime": "node:20" }`
  indique à la plateforme sous quel runtime héberger la Function.

Sans le premier, Oryx prend la version la plus récente disponible et le
déploiement échoue avec « Failed to deploy the Azure Functions », alors même
que la construction a réussi.

## Adresse du serveur MCP

```
https://<votre-domaine>/api/mcp
```

Attention au domaine : si un domaine personnalisé est configuré, l'adresse
`*.azurestaticapps.net` répond par une redirection 301, que la plupart des
clients ne suivent pas sur une requête POST. Déclarez le domaine final.

### Adresse utilisée dans les liens renvoyés

Derrière Static Web Apps, la Function est appelée par le service interne :
l'en-tête `Host` porte alors une adresse en `.azurewebsites.net`, inutilisable
par un patient. Le serveur cherche donc l'adresse publique dans cet ordre :

1. la variable d'application `SITE_BASE`, si elle est définie ;
2. l'en-tête `x-ms-original-url`, qui porte l'adresse d'origine ;
3. `x-forwarded-host` ou `host`, s'ils ne sont pas internes ;
4. à défaut, `https://www.nomaddrugs.com/`.

Le plus sûr reste de définir `SITE_BASE` dans Configuration → Paramètres
d'application de la Static Web App, avec la valeur `https://www.nomaddrugs.com`.

## Vérification après déploiement

```bash
curl -s -X POST https://<votre-domaine>/api/mcp \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: server/discover" \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'
```

La réponse doit lister les versions supportées et annoncer la capacité `tools`.

## Confidentialité

La Function n'enregistre rien et ne journalise que le nom de la méthode
appelée, jamais le corps de la requête. Le niveau de journalisation est fixé à
`Warning` dans `host.json`.
