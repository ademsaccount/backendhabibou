-- Anti-abus du coupon de bienvenue : table d'empreintes (jamais d'identifiant
-- en clair) qui survit a la suppression de compte.
--
-- AUCUNE foreign key vers "User" : c'est voulu. La suppression de compte
-- supprime toutes les donnees personnelles (coupon compris) mais laisse ces
-- empreintes, pour qu'un re-inscription avec le meme email / telephone /
-- sub Google / sub Apple ne re-debloque pas un nouveau coupon gratuit.
--
-- key_hash est UNIQUE : une meme identite ne peut reclamer qu'une fois.

CREATE TABLE "WelcomeCouponClaim" (
    "id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WelcomeCouponClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WelcomeCouponClaim_key_hash_key" ON "WelcomeCouponClaim"("key_hash");
