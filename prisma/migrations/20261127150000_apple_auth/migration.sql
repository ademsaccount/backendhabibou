-- Sign in with Apple (iOS uniquement)
-- - apple_id : identifiant stable Apple (payload.sub), unique par compte.
-- - apple_refresh_token : refresh token Apple, utilise UNIQUEMENT pour revoquer
--   l'acces lors de la suppression du compte. Jamais expose par l'API.
-- - email devient nullable : Apple peut ne fournir aucun email, ou une adresse
--   relais privee (@privaterelay.appleid.com).
-- - auth_provider accepte desormais 'apple'.

ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'apple';

ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "apple_id" TEXT;
ALTER TABLE "User" ADD COLUMN "apple_refresh_token" TEXT;

CREATE UNIQUE INDEX "User_apple_id_key" ON "User"("apple_id");
