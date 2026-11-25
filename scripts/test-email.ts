/**
 * Envoi manuel d'un email de test via le meme service Mailjet que l'API.
 *
 * Usage :
 *   npx tsx scripts/test-email.ts destinataire@exemple.com [fr|en|aeb]
 *
 * Aucune route HTTP n'est exposee. Le script n'affiche jamais les cles API,
 * le header Authorization ni le code envoye.
 */
import { isMailConfigured, sendPasswordResetCode } from '../src/lib/mailer';

async function main(): Promise<void> {
  const to = process.argv[2]?.trim();
  const locale = process.argv[3]?.trim() || 'fr';

  if (!to) {
    console.error('Usage: npx tsx scripts/test-email.ts <adresse@exemple.com> [fr|en|aeb]');
    process.exitCode = 1;
    return;
  }

  if (!isMailConfigured()) {
    console.error(
      'Mailjet non configure : renseigne MAILJET_API_KEY, MAILJET_SECRET_KEY, ' +
        'MAILJET_SENDER_EMAIL et MAILJET_SENDER_NAME.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    // Meme gabarit que le parcours « mot de passe oublie » ; le code n'est
    // enregistre nulle part, cet envoi ne permet donc aucun reset.
    await sendPasswordResetCode(to, '000000', locale);
    console.log(`Email de test envoye a ${to} (locale=${locale}).`);
  } catch (error) {
    console.error(
      `Echec de l'envoi : ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

void main();
