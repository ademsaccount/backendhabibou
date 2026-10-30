-- Catalogue global de garnitures (sauces / salades / supplements) + tables de liaison.
-- Sauces et salades : nouvelles tables "Sauce" / "Salad" (une ligne par nom normalisé,
-- image optionnelle) ; les tables RestaurantSauce / RestaurantSalad deviennent des
-- LIENS (restaurant <-> catalogue). Supplements : le catalogue global "Supplement"
-- existe déjà — on lui ajoute une image et RestaurantSupplement devient un lien
-- (restaurant <-> Supplement) qui conserve extra_price et for_fricasse du commerce.
-- La migration fonctionne aussi sur une base vide (toutes les étapes tolèrent 0 ligne).

-- ---------------------------------------------------------------------------
-- 1. Tables du catalogue : Sauce / Salad (+ image sur Supplement)
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "Sauce" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sauce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Salad" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Salad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sauce_name_key_key" ON "Sauce"("name_key");

-- CreateIndex
CREATE UNIQUE INDEX "Salad_name_key_key" ON "Salad"("name_key");

ALTER TABLE "Supplement" ADD COLUMN "image_url" TEXT;

-- ---------------------------------------------------------------------------
-- 2. Remplir les catalogues depuis les lignes par-commerce existantes :
--    UNE ligne catalogue par nom normalisé
--    (minuscules + trim + espaces internes réduits — SANS extension unaccent :
--    les variantes d'accents peuvent donc rester des lignes séparées ;
--    le code applicatif résoud les accents).
-- ---------------------------------------------------------------------------

INSERT INTO "Sauce" ("id", "name", "name_key", "created_at")
SELECT gen_random_uuid()::text, MIN("name"),
       regexp_replace(lower(TRIM("name")), '\s+', ' ', 'g'), NOW()
FROM "RestaurantSauce"
GROUP BY regexp_replace(lower(TRIM("name")), '\s+', ' ', 'g');

INSERT INTO "Salad" ("id", "name", "name_key", "created_at")
SELECT gen_random_uuid()::text, MIN("name"),
       regexp_replace(lower(TRIM("name")), '\s+', ' ', 'g'), NOW()
FROM "RestaurantSalad"
GROUP BY regexp_replace(lower(TRIM("name")), '\s+', ' ', 'g');

-- ---------------------------------------------------------------------------
-- 3. Supplements : réutiliser la ligne "Supplement" existante ayant le même
--    lower(trim(name)) ; sinon en créer une (default_extra_price = MIN des prix
--    du commerce pour ce nom ; MIN est utilisé comme prix déterministe).
-- ---------------------------------------------------------------------------

INSERT INTO "Supplement" ("id", "name", "default_extra_price", "in_catalog", "created_at")
SELECT gen_random_uuid()::text, MIN("name"), MIN("extra_price"), true, NOW()
FROM "RestaurantSupplement" r
WHERE NOT EXISTS (
  SELECT 1 FROM "Supplement" s
  WHERE lower(TRIM(s."name")) = lower(TRIM(r."name"))
)
GROUP BY lower(TRIM(r."name"));

-- ---------------------------------------------------------------------------
-- 4. Conversion des tables par-commerce en tables de LIAISON.
--    (Suppression préalable des doublons hypothétiques pointant vers la même
--    ligne catalogue — première occurrence conservée, ordre "id" déterministe.)
-- ---------------------------------------------------------------------------

-- RestaurantSupplement -> lien (restaurant_id, supplement_id)
DELETE FROM "RestaurantSupplement" r
USING "RestaurantSupplement" r2
WHERE r."restaurant_id" = r2."restaurant_id"
  AND lower(TRIM(r."name")) = lower(TRIM(r2."name"))
  AND r."id"::text > r2."id"::text;

ALTER TABLE "RestaurantSupplement" ADD COLUMN "supplement_id" TEXT;

UPDATE "RestaurantSupplement" r
SET "supplement_id" = s."id"
FROM "Supplement" s
WHERE lower(TRIM(r."name")) = lower(TRIM(s."name"));

ALTER TABLE "RestaurantSupplement" ALTER COLUMN "supplement_id" SET NOT NULL;

ALTER TABLE "RestaurantSupplement" DROP COLUMN "name";
ALTER TABLE "RestaurantSupplement" DROP COLUMN "id";
ALTER TABLE "RestaurantSupplement" DROP COLUMN "created_at";
ALTER TABLE "RestaurantSupplement" DROP CONSTRAINT IF EXISTS "RestaurantSupplement_restaurant_id_name_key";
DROP INDEX IF EXISTS "RestaurantSupplement_restaurant_id_idx";

ALTER TABLE "RestaurantSupplement"
  ADD CONSTRAINT "RestaurantSupplement_pkey" PRIMARY KEY ("restaurant_id", "supplement_id");

CREATE INDEX "RestaurantSupplement_supplement_id_idx" ON "RestaurantSupplement"("supplement_id");

ALTER TABLE "RestaurantSupplement"
  ADD CONSTRAINT "RestaurantSupplement_supplement_id_fkey"
  FOREIGN KEY ("supplement_id") REFERENCES "Supplement"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RestaurantSauce -> lien (restaurant_id, sauce_id)
DELETE FROM "RestaurantSauce" r
USING "RestaurantSauce" r2
WHERE r."restaurant_id" = r2."restaurant_id"
  AND regexp_replace(lower(TRIM(r."name")), '\s+', ' ', 'g')
      = regexp_replace(lower(TRIM(r2."name")), '\s+', ' ', 'g')
  AND r."id"::text > r2."id"::text;

ALTER TABLE "RestaurantSauce" ADD COLUMN "sauce_id" TEXT;

UPDATE "RestaurantSauce" r
SET "sauce_id" = s."id"
FROM "Sauce" s
WHERE regexp_replace(lower(TRIM(r."name")), '\s+', ' ', 'g') = s."name_key";

ALTER TABLE "RestaurantSauce" ALTER COLUMN "sauce_id" SET NOT NULL;

ALTER TABLE "RestaurantSauce" DROP COLUMN "name";
ALTER TABLE "RestaurantSauce" DROP COLUMN "id";
ALTER TABLE "RestaurantSauce" DROP COLUMN "created_at";
ALTER TABLE "RestaurantSauce" DROP CONSTRAINT IF EXISTS "RestaurantSauce_restaurant_id_name_key";
DROP INDEX IF EXISTS "RestaurantSauce_restaurant_id_idx";

ALTER TABLE "RestaurantSauce"
  ADD CONSTRAINT "RestaurantSauce_pkey" PRIMARY KEY ("restaurant_id", "sauce_id");

CREATE INDEX "RestaurantSauce_sauce_id_idx" ON "RestaurantSauce"("sauce_id");

ALTER TABLE "RestaurantSauce"
  ADD CONSTRAINT "RestaurantSauce_sauce_id_fkey"
  FOREIGN KEY ("sauce_id") REFERENCES "Sauce"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RestaurantSalad -> lien (restaurant_id, salad_id)
DELETE FROM "RestaurantSalad" r
USING "RestaurantSalad" r2
WHERE r."restaurant_id" = r2."restaurant_id"
  AND regexp_replace(lower(TRIM(r."name")), '\s+', ' ', 'g')
      = regexp_replace(lower(TRIM(r2."name")), '\s+', ' ', 'g')
  AND r."id"::text > r2."id"::text;

ALTER TABLE "RestaurantSalad" ADD COLUMN "salad_id" TEXT;

UPDATE "RestaurantSalad" r
SET "salad_id" = s."id"
FROM "Salad" s
WHERE regexp_replace(lower(TRIM(r."name")), '\s+', ' ', 'g') = s."name_key";

ALTER TABLE "RestaurantSalad" ALTER COLUMN "salad_id" SET NOT NULL;

ALTER TABLE "RestaurantSalad" DROP COLUMN "name";
ALTER TABLE "RestaurantSalad" DROP COLUMN "id";
ALTER TABLE "RestaurantSalad" DROP COLUMN "created_at";
ALTER TABLE "RestaurantSalad" DROP CONSTRAINT IF EXISTS "RestaurantSalad_restaurant_id_name_key";
DROP INDEX IF EXISTS "RestaurantSalad_restaurant_id_idx";

ALTER TABLE "RestaurantSalad"
  ADD CONSTRAINT "RestaurantSalad_pkey" PRIMARY KEY ("restaurant_id", "salad_id");

CREATE INDEX "RestaurantSalad_salad_id_idx" ON "RestaurantSalad"("salad_id");

ALTER TABLE "RestaurantSalad"
  ADD CONSTRAINT "RestaurantSalad_salad_id_fkey"
  FOREIGN KEY ("salad_id") REFERENCES "Salad"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
