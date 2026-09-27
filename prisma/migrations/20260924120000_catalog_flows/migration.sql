-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "dish_type" TEXT,
ADD COLUMN     "medication_category_id" TEXT;

-- CreateTable
CREATE TABLE "ProductIngredientOption" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extra_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_default_checked" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductIngredientOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductIngredientOption_product_id_idx" ON "ProductIngredientOption"("product_id");

-- CreateIndex
CREATE INDEX "MedicationCategory_is_active_sort_order_idx" ON "MedicationCategory"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "Product_dish_type_idx" ON "Product"("dish_type");

-- CreateIndex
CREATE INDEX "Product_medication_category_id_idx" ON "Product"("medication_category_id");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_medication_category_id_fkey" FOREIGN KEY ("medication_category_id") REFERENCES "MedicationCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredientOption" ADD CONSTRAINT "ProductIngredientOption_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

