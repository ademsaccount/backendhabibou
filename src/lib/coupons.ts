import { prisma } from './prisma';
import { logger } from './logger';
import { notify } from './notify';
import { pushToUser, ORDERS_CHANNEL_ID, type LocalizedPushTemplates } from './push';

/**
 * Coupon de bienvenue : UN coupon "livraison offerte" par nouveau compte verifie.
 *
 * Regles :
 * - accorde UNIQUEMENT a la verification du compte (verify-email, Google
 *   nouveau compte, reset-password qui verifie un compte non verifie) ;
 *   jamais a l'inscription et jamais en backfill pour les comptes existants ;
 * - UNIQUE (user_id, source) en base : un double appel ne cree rien de plus ;
 * - aucun chemin ci-dessous ne leve : tout est best-effort pour ne jamais
 *   casser un flux d'authentification.
 */

const P2002 = 'P2002';

/** Push bienvenue : memes regles de langue que les pushes commande (aeb -> ar). */
export const WELCOME_PUSH_TEMPLATES: LocalizedPushTemplates = {
  fr: {
    title: 'Bienvenue chez Habichou 🎉',
    body: "Votre première livraison est offerte ! Activez votre coupon dans le panier quand vous voulez.",
  },
  en: {
    title: 'Welcome to Habichou 🎉',
    body: 'Your first delivery is on us! Activate your coupon in the cart whenever you want.',
  },
  ar: {
    title: 'مرحباً بك في هابيشو 🎉',
    body: 'توصيلك الأول مجاني! فعّل كوبونك في السلة متى شئت.',
  },
};

/** Texte in-app (meme contenu, localise selon la locale de l'utilisateur). */
function pickLocalized(templates: LocalizedPushTemplates, locale: string | null | undefined): {
  title: string;
  body: string;
} {
  if (locale === 'en') return templates.en;
  if (locale === 'aeb' || locale === 'ar') return templates.ar;
  return templates.fr;
}

/**
 * Accorde le coupon de bienvenue si l'utilisateur n'en a pas encore.
 * Idempotent (UNIQUE user_id+source) et jamais jetant : renvoie true si un
 * coupon existe pour l'utilisateur apres l'appel.
 */
export async function grantWelcomeCoupon(userId: string): Promise<boolean> {
  try {
    await prisma.coupon.create({
      data: { user_id: userId, source: 'WELCOME', type: 'FREE_DELIVERY' },
    });
    logger.info('coupon', `coupon bienvenue accorde user=${userId}`);
    return true;
  } catch (err) {
    // Deja accorde (unique) : normal, pas une erreur.
    if ((err as { code?: string })?.code === P2002) return true;
    logger.error('coupon', 'echec attribution coupon bienvenue', err instanceof Error ? err : String(err));
    // Existe-t-il quand meme ? (erreur reseau transitoire, on ne bloque jamais)
    try {
      const existing = await prisma.coupon.findUnique({
        where: { user_id_source: { user_id: userId, source: 'WELCOME' } },
        select: { id: true },
      });
      return Boolean(existing);
    } catch {
      return false;
    }
  }
}

/**
 * Envoie la notification de bienvenue (in-app + push) une seule fois.
 * - in-app : entree Notification type `welcome_coupon` (idempotent) ;
 * - push : envoye seulement si l'utilisateur a un jeton ; `welcome_notified_at`
 *   n'est positionne qu'apres un envoi reussi (sinon envoi differe au
 *   prochain enregistrement de jeton).
 * Jamais jetant.
 */
export async function sendWelcomeCouponNotification(userId: string): Promise<void> {
  try {
    const coupon = await prisma.coupon.findUnique({
      where: { user_id_source: { user_id: userId, source: 'WELCOME' } },
      select: { id: true, status: true, welcome_notified_at: true },
    });
    if (!coupon || coupon.welcome_notified_at) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    const localized = pickLocalized(WELCOME_PUSH_TEMPLATES, user?.locale);

    // Entree in-app (une seule : garde par type deja cree pour cet utilisateur).
    const existingNotif = await prisma.notification.findFirst({
      where: { user_id: userId, type: 'welcome_coupon' },
      select: { id: true },
    });
    if (!existingNotif) {
      await notify({
        user_id: userId,
        title: localized.title,
        body: localized.body,
        type: 'welcome_coupon',
        data: { type: 'welcome_coupon' },
      });
    }

    // Push : seulement si un jeton est enregistre (sinon differe).
    const sent = await pushToUser(userId, {
      templates: WELCOME_PUSH_TEMPLATES,
      channelId: ORDERS_CHANNEL_ID,
      data: { type: 'welcome_coupon' },
    });
    if (sent > 0) {
      await prisma.coupon.update({
        where: { id: coupon.id },
        data: { welcome_notified_at: new Date() },
      });
      logger.info('coupon', `push bienvenue envoye user=${userId}`);
    }
  } catch (err) {
    logger.error('coupon', 'echec notification bienvenue', err instanceof Error ? err : String(err));
  }
}

/**
 * Envoi differe : appele quand le premier jeton push est enregistre.
 * Si le coupon bienvenue existe toujours, n'a pas ete notify et est toujours
 * AVAILABLE, on envoie la notification maintenant. Jamais jetant.
 */
export async function sendDeferredWelcomeNotification(userId: string): Promise<void> {
  try {
    const coupon = await prisma.coupon.findUnique({
      where: { user_id_source: { user_id: userId, source: 'WELCOME' } },
      select: { status: true, welcome_notified_at: true },
    });
    if (!coupon || coupon.welcome_notified_at || coupon.status !== 'AVAILABLE') return;
    await sendWelcomeCouponNotification(userId);
  } catch (err) {
    logger.error('coupon', 'echec notification bienvenue differee', err instanceof Error ? err : String(err));
  }
}
