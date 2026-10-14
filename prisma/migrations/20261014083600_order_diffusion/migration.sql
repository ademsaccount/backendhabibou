-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "diffused_at" TIMESTAMP(3),
ADD COLUMN     "diffused_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rejected_by" TEXT[] DEFAULT ARRAY[]::TEXT[];
