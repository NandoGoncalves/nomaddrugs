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

## Adresse du serveur MCP

```
https://<votre-domaine>/api/mcp
```

Le serveur déduit l'adresse du site des en-têtes de la requête, donc les liens
qu'il renvoie suivent le domaine par lequel il a été appelé. Pour forcer une
autre base, définir la variable d'application `SITE_BASE` dans la configuration
de la Static Web App, par exemple `https://nomaddrugs.com`.

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
