/**
 * BACKFILL one-shot : empreintes des coupons de bienvenue DEJA accordes.
 *
 * Pourquoi : WelcomeCouponClaim n'existe que depuis la migration
 * 20261128120000_welcome_coupon_claim. Sans ce script, un ancien compte qui a
 * profite du coupon puis SUPPRIME son compte ne laisserait aucune empreinte :
 * la meme personne pourrait se re-inscrire et re-clamer le coupon gratuit.
 *
 * Ce script insere donc les empreintes HMAC des identifiants de tous les
 * comptes qui possedent DEJA un coupon source=WELCOME.
 *
 * - Idempotent : re-executer n'ecrit rien de plus (conflit unique ignore).
 * - Seules des empreintes sont ecrites, jamais d'identifiant en clair.
 * - N'imprime QUE des compteurs, jamais d'email / telephone / hash.
 * - Refuse de tourner si WELCOME_CLAIM_SECRET manque ou fait < 32 caracteres
 *   (sinon les empreintes locales ne correspondraient pas a celles de prod).
 *
 * Usage : npx tsx scripts/backfill-welcome-claims.ts
 */
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { buildWelcomeClaims } from '../src/lib/welcomeClaim';

const P2002 = 'P2002';

async function main(): Promise<void> {
  if (env.WELCOME_CLAIM_SECRET.trim().length < 32) {
    console.error(
      'REFUS: WELCOME_CLAIM_SECRET absent ou trop court (32 caracteres minimum) dans .env.',
    );
    console.error(
      'Utilise la MEME valeur que celle definie sur Render avant de lancer ce backfill.',
    );
    process.exit(1);
  }

  const users = await prisma.user.findMany({
    where: { coupons: { some: { source: 'WELCOME' } } },
    select: { email: true, phone: true, google_id: true, apple_id: true },
  });

  let scanned = 0;
  let inserted = 0;
  let alreadyPresent = 0;
  let failed = 0;
  let withoutIdentifier = 0;

  // Toutes les empreintes d'abord, puis UN select pour savoir lesquelles
  // existent deja : re-execution silencieuse (pas d'exception unique attendue).
  const claims: { kind: string; key_hash: string }[] = [];

  for (const user of users) {
    scanned += 1;
    const rows = buildWelcomeClaims({
      email: user.email,
      phone: user.phone,
      googleId: user.google_id,
      appleId: user.apple_id,
    });
    if (rows.length === 0) {
      withoutIdentifier += 1;
      continue;
    }
    claims.push(...rows);
  }

  const uniqueHashes = [...new Set(claims.map((claim) => claim.key_hash))];
  const alreadyRows = await prisma.welcomeCouponClaim.findMany({
    where: { key_hash: { in: uniqueHashes } },
    select: { key_hash: true },
  });
  const existing = new Set(alreadyRows.map((row) => row.key_hash));

  for (const claim of claims) {
    if (existing.has(claim.key_hash)) {
      alreadyPresent += 1;
      continue;
    }
    try {
      await prisma.welcomeCouponClaim.create({ data: claim });
      inserted += 1;
    } catch (err) {
      // Course entre deux executions : le concurrent a insere l'empreinte.
      if ((err as { code?: string })?.code === P2002) {
        alreadyPresent += 1;
      } else {
        failed += 1;
      }
    }
  }

  // Compteurs uniquement : aucun identifiant, aucun hash.
  console.log('--- backfill WelcomeCouponClaim ---');
  console.log('comptes avec coupon WELCOME analyses :', scanned);
  console.log('empreintes inserees                  :', inserted);
  console.log('empreintes deja presentes (ignorees) :', alreadyPresent);
  console.log('comptes sans identifiant exploitable  :', withoutIdentifier);
  console.log('erreurs                               :', failed);
  console.log('total empreintes en base              :', await prisma.welcomeCouponClaim.count());
}

main()
  .catch((err: unknown) => {
    // Jamais d'identifiant ni de hash dans les messages d'erreur.
    console.error(
      'ERREUR:',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
