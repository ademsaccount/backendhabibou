-- Catalogues globaux ingredients / supplements + liaisons produit.
-- Migre les donnees de "ProductIngredientOption" puis supprime l'ancienne table.

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "in_catalog" BOOLEAN NOT NULL DEFAULT true,
    "created_by_admin" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIngredient" (
    "product_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductIngredient_pkey" PRIMARY KEY ("product_id","ingredient_id")
);

-- CreateTable
CREATE TABLE "Supplement" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_extra_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "in_catalog" BOOLEAN NOT NULL DEFAULT true,
    "created_by_admin" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSupplement" (
    "product_id" TEXT NOT NULL,
    "supplement_id" TEXT NOT NULL,
    "extra_price_override" DOUBLE PRECISION,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductSupplement_pkey" PRIMARY KEY ("product_id","supplement_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient"("name");

-- CreateIndex
CREATE INDEX "ProductIngredient_ingredient_id_idx" ON "ProductIngredient"("ingredient_id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplement_name_key" ON "Supplement"("name");

-- CreateIndex
CREATE INDEX "ProductSupplement_supplement_id_idx" ON "ProductSupplement"("supplement_id");

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSupplement" ADD CONSTRAINT "ProductSupplement_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSupplement" ADD CONSTRAINT "ProductSupplement_supplement_id_fkey" FOREIGN KEY ("supplement_id") REFERENCES "Supplement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration : lignes sans prix supplementaire -> ingredients informatifs
INSERT INTO "Ingredient" ("id", "name", "in_catalog", "created_at")
SELECT gen_random_uuid()::text, src."name", TRUE, NOW()
FROM (SELECT DISTINCT "name" FROM "ProductIngredientOption" WHERE "extra_price" = 0) AS src
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProductIngredient" ("product_id", "ingredient_id", "sort_order")
SELECT pio."product_id", ing."id", MIN(pio."sort_order")
FROM "ProductIngredientOption" pio
JOIN "Ingredient" ing ON ing."name" = pio."name"
WHERE pio."extra_price" = 0
GROUP BY pio."product_id", ing."id"
ON CONFLICT DO NOTHING;

-- DataMigration : lignes payantes -> supplements (catalogue verrouille : prix conserve)
INSERT INTO "Supplement" ("id", "name", "default_extra_price", "in_catalog", "created_at")
SELECT gen_random_uuid()::text, src."name", src."price", TRUE, NOW()
FROM (
  SELECT "name", MAX("extra_price") AS "price"
  FROM "ProductIngredientOption"
  WHERE "extra_price" > 0
  GROUP BY "name"
) AS src
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProductSupplement" ("product_id", "supplement_id", "extra_price_override", "sort_order")
SELECT pio."product_id", sup."id", MIN(pio."extra_price"), MIN(pio."sort_order")
FROM "ProductIngredientOption" pio
JOIN "Supplement" sup ON sup."name" = pio."name"
WHERE pio."extra_price" > 0
GROUP BY pio."product_id", sup."id"
ON CONFLICT DO NOTHING;

-- DropForeignKey
ALTER TABLE "ProductIngredientOption" DROP CONSTRAINT "ProductIngredientOption_product_id_fkey";

-- DropTable
DROP TABLE "ProductIngredientOption";
