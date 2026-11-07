-- CreateTable
CREATE TABLE "SavedCart" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'untitled',
    "items" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedCart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedCart_user_id_idx" ON "SavedCart"("user_id");

-- AddForeignKey
ALTER TABLE "SavedCart" ADD CONSTRAINT "SavedCart_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
