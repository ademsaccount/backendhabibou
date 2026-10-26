-- CreateEnum
CREATE TYPE "OrderShopStatusValue" AS ENUM ('preparing', 'picked_up');

-- CreateTable
CREATE TABLE "OrderShopStatus" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "status" "OrderShopStatusValue" NOT NULL DEFAULT 'preparing',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderShopStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderShopStatus_order_id_idx" ON "OrderShopStatus"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderShopStatus_order_id_restaurant_id_key" ON "OrderShopStatus"("order_id", "restaurant_id");

-- AddForeignKey
ALTER TABLE "OrderShopStatus" ADD CONSTRAINT "OrderShopStatus_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
