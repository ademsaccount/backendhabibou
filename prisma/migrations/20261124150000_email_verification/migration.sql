-- Verification de l'email a l'inscription (code a 6 chiffres par email).
-- - User.email_verified_at : date de verification (null = non verifie).
--   GRANDFATHERING : tous les comptes existants sont marques verifies, donc
--   aucun utilisateur deja inscrit n'est bloque apres le deploiement.
-- - EmailVerificationCode : hash SHA-256 du code (jamais le code en clair),
--   expires_at / attempts comme les codes de reinitialisation, et
--   consumed_at pour l'usage unique (un code valide ne peut plus servir).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "email_verified_at" TIMESTAMP(3);

-- Grandfathering : les comptes existants sont considers verifies.
UPDATE "User" SET "email_verified_at" = NOW();

-- CreateTable
CREATE TABLE "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailVerificationCode_user_id_idx" ON "EmailVerificationCode"("user_id");

-- AddForeignKey
ALTER TABLE "EmailVerificationCode" ADD CONSTRAINT "EmailVerificationCode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
