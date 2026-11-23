-- Reinitialisation de mot de passe par code a 6 chiffres envoye par email.
-- - code_hash : sha256 du code (le code en clair n'est jamais stocke)
-- - expires_at : duree de vie courte (PASSWORD_RESET_TTL_MIN, 15 min par defaut)
-- - attempts : limite le nombre d'essais avant suppression du code
-- Un seul code actif par utilisateur (les anciens sont supprimes a chaque envoi).

-- CreateTable
CREATE TABLE "PasswordResetCode" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PasswordResetCode_user_id_idx" ON "PasswordResetCode"("user_id");

-- AddForeignKey
ALTER TABLE "PasswordResetCode" ADD CONSTRAINT "PasswordResetCode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
