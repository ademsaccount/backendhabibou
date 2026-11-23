-- Connexion Google (ID token natif)
-- - google_id : identifiant stable Google (payload.sub), unique par compte
-- - auth_provider : origine du compte ('local' | 'google')
-- - password_hash devient nullable : un compte 100% Google n'a pas de mot de passe
--   (les comptes existants et la connexion par mot de passe restent inchanges)
--
-- avatar_url existe deja dans le schema User : aucune colonne a ajouter.

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('local', 'google');

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN     "google_id" TEXT;
ALTER TABLE "User" ADD COLUMN     "auth_provider" "AuthProvider" NOT NULL DEFAULT 'local';

-- CreateIndex
CREATE UNIQUE INDEX "User_google_id_key" ON "User"("google_id");
