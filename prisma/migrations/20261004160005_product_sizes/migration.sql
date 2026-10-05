-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "size_label" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "size_label" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sizes" JSONB;
