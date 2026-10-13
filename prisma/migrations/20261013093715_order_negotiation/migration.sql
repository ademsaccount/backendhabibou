-- CreateEnum
CREATE TYPE "PriceStatus" AS ENUM ('none', 'proposed', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "price_status" "PriceStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "proposed_price" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "OrderMessage" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "sender_role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "price" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderMessage_order_id_created_at_idx" ON "OrderMessage"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "OrderMessage" ADD CONSTRAINT "OrderMessage_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
