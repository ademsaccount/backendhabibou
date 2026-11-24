-- Coupon de bienvenue : chaque NOUVEAU compte verifie recoit UN coupon
-- "livraison offerte" (type FREE_DELIVERY, source WELCOME), sans expiration.
-- - UNIQUE (user_id, source) : un seul coupon bienvenue par utilisateur, jamais
--   recupere ni accorde deux fois (pas de backfill pour les comptes existants).
-- - Index (user_id, status) : lecture "mes coupons" (disponibles en premier).
-- - Order.coupon_id (unique) : la commande qui a consomme le coupon.
-- - Order.delivery_discount : montant de frais de livraison remis (meme type
--   monetaire Float que total_price / delivery_fee).

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('AVAILABLE', 'USED');

-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('FREE_DELIVERY');

-- CreateEnum
CREATE TYPE "CouponSource" AS ENUM ('WELCOME');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "coupon_id" TEXT;
ALTER TABLE "Order" ADD COLUMN "delivery_discount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "CouponType" NOT NULL DEFAULT 'FREE_DELIVERY',
    "source" "CouponSource" NOT NULL,
    "status" "CouponStatus" NOT NULL DEFAULT 'AVAILABLE',
    "used_at" TIMESTAMP(3),
    "order_id" TEXT,
    "seen_at" TIMESTAMP(3),
    "welcome_notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_user_id_source_key" ON "Coupon"("user_id", "source");

-- CreateIndex
CREATE INDEX "Coupon_user_id_status_idx" ON "Coupon"("user_id", "status");

-- CreateIndex
CREATE INDEX "Coupon_user_id_idx" ON "Coupon"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_coupon_id_key" ON "Order"("coupon_id");

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
