-- CreateEnum
CREATE TYPE "StoryMedia" AS ENUM ('image', 'video');

-- CreateTable
CREATE TABLE "Story" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "media_url" TEXT NOT NULL,
    "media_type" "StoryMedia" NOT NULL,
    "text" TEXT,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Story_restaurant_id_idx" ON "Story"("restaurant_id");

-- CreateIndex
CREATE INDEX "Story_expires_at_idx" ON "Story"("expires_at");

-- AddForeignKey
ALTER TABLE "Story" ADD CONSTRAINT "Story_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
