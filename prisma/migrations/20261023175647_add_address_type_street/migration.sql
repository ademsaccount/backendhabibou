-- AlterTable
ALTER TABLE "Address" ADD COLUMN     "address_type" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN     "street_name" TEXT;
