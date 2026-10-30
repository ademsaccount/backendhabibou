# extras-images — import en masse des images du catalogue garnitures

Ce dossier est lu par `npm run extras:import-images` (script
`scripts/import-extras-images.ts`). Chaque image devient (ou met à jour) une
ligne du CATALOGUE GLOBAL des garnitures : `Sauce`, `Salad` ou `Supplement`
(partagée par tous les commerces, avec image visible côté client).

## Règles

1. Un sous-dossier par type : `sauces/`, `salads/`, `supplements/`.
2. Extensions acceptées : `.png`, `.jpg`, `.jpeg`, `.webp`.
3. Le nom affiché de la garniture :
   - `names.json` du même dossier si présent (`{ "slug": "Nom affiché" }`) — prioritaire ;
   - sinon le slug : Tirets/underscores = espaces, première lettre en majuscule
     (`harissa` -> `Harissa`, `salade-mechwia` -> `Salade mechwia`).
4. La ligne du catalogue est trouvée ou créée par NOM NORMALISÉ : casse, accents
   et espaces multiples ignorés — « Thon » et « thon » pointent sur une seule ligne.
5. Stockage : même bucket que la route `/uploads`, chemin STABLE
   `extras/<type>/<slug>.<ext>`. Un re-run REMPLACE l'image (upsert) et ajoute un
   cache-buster `?v=<mtime>` à l'URL publique.
6. Idempotent : rejouable sans créer de doublon ; une ligne de catalogue déjà
   imageée est ré-écrasée par la nouvelle image (re-run = nouvelle version).

## Jalons de qualité (avertissements, jamais des erreurs)

- image pas « à peu près carrée » (ratio 1 ± 5 %) ;
- fichier > 300 Ko ;
- dimensions non décodables (fichier corrompu).

## Flags

| flag             | effet                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| `--dry-run`      | imprime le plan, n'écrit RIEN (aucun upload, aucune écriture en base)       |
| `--seed-defaults`| crée les garnitures par défaut SANS image (Harissa, Laitue, Thon…)          |
| `--yes`          | saute la demande de confirmation                                            |

Le script affiche uniquement l'HÔTE de la base avant toute écriture, puis
demande une confirmation (sauf `--yes`). Il lit le `.env` du backend comme les
autres scripts (DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, bucket
SUPABASE_STORAGE_BUCKET).
