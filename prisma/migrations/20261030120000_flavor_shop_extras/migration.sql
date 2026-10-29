-- flavor (variante du plat : Margherita, Thon…) + garnitures au niveau du commerce.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "flavor" TEXT;

-- CreateTable
CREATE TABLE "RestaurantSupplement" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extra_price" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "for_fricasse" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantSupplement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantSauce" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantSauce_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantSupplement_restaurant_id_name_key" ON "RestaurantSupplement"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "RestaurantSupplement_restaurant_id_idx" ON "RestaurantSupplement"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantSauce_restaurant_id_name_key" ON "RestaurantSauce"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "RestaurantSauce_restaurant_id_idx" ON "RestaurantSauce"("restaurant_id");

-- AddForeignKey
ALTER TABLE "RestaurantSupplement" ADD CONSTRAINT "RestaurantSupplement_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantSauce" ADD CONSTRAINT "RestaurantSauce_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
