# Habichou — API (backendHabichou)

Node.js + Express + TypeScript + Prisma (PostgreSQL/Supabase) + Socket.io.

**Le contrat d'API complet est dans [`../API.md`](../API.md)** (à lire en premier — c'est la source de vérité partagée avec les apps `habichou` et `sudo_habichou`). Une collection de requêtes prêtes à l'emploi est dans [`requests.http`](./requests.http).

## Lancement

```bash
# 1. Variables d'environnement
cp .env.example .env
#    → remplir DATABASE_URL (Supabase pooler aws-1-eu-west-1), SUPABASE_URL,
#      SUPABASE_SERVICE_ROLE_KEY, secrets JWT (generes deja si .env cree par l'agent)
#    → mot de passe Supabase : percent-encode les caracteres speciaux
#       @ → %40   # → %23   / → %2F   ? → %3F   % → %25   : → %3A

# 2. Base de donnees
npm install
npm run db:generate        # genere le client Prisma
npm run db:sql             # (re-)genere prisma/migrations/0_init/migration.sql sans connexion
npm run db:migrate         # applique les migrations (prisma migrate deploy)
npm run db:seed            # donnees de test

# 3. Serveur
npm run dev                # http://localhost:4000 (tsx watch)
npm run build && npm start # production
npm run typecheck
```

## Comptes seed (mot de passe commun : `Habichou2026!`)

| Rôle | Email |
|---|---|
| admin | `admin@habichou.ma` |
| client | `client@habichou.ma` |
| livreur | `livreur@habichou.ma` |

## Structure

```
prisma/schema.prisma      # modele de donnees (tous indexes geo/statuts)
prisma/migrations/0_init  # SQL initial (genere depuis le schema)
prisma/seed.ts            # comptes + 5 commerces + produits + 1 demande libre
src/config/env.ts         # validation zod des variables
src/lib/                  # prisma, jwt, geo (haversine), errors, notify, stripe, upload
src/middleware/           # requireAuth, requireRole, validate (zod)
src/routes/               # auth, public+adresses, orders, custom-requests,
                          # admin (dashboard/commerces/commandes/livreurs), livreur, uploads
src/services/order.service.ts  # transitions de statut, assignation, notifs
src/socket/io.ts          # auth JWT au handshake, rooms, events temps reel
```

## Evenements Socket.io

`order:status_update`, `livreur:location_update`, `custom_request:quoted`, `notification:new` — voir `../API.md`.

## Varibles d'environnement

Voir `.env.example`. `DATABASE_URL` est **obligatoire** ; `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` sont requis uniquement pour `POST /uploads` (Supabase Storage, bucket `habichou`) ; `STRIPE_SECRET_KEY` optionnel (sinon paiement carte simulé).

## Tests

Ouvrez `requests.http` avec l'extension VS Code **REST Client** (ou importez dans Postman) : chaque endpoint est exemplifié, dans l'ordre du flux (inscription → connexion → … → livraison).
# deliver-add
# backendhabibou
