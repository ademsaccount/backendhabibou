-- Salades au niveau du commerce (garnitures fraîches, gratuites, jamais tarifées).

-- CreateTable
CREATE TABLE "RestaurantSalad" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantSalad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantSalad_restaurant_id_name_key" ON "RestaurantSalad"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "RestaurantSalad_restaurant_id_idx" ON "RestaurantSalad"("restaurant_id");

-- AddForeignKey
ALTER TABLE "RestaurantSalad" ADD CONSTRAINT "RestaurantSalad_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
