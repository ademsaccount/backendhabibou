import type { OrderStatus } from '@prisma/client';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { prisma } from './prisma';
import { logger } from './logger';

type ExpoSdk = typeof import('expo-server-sdk');

// Indirection via new Function : empeche tsc (module commonjs) et esbuild/tsx
// de reecrire import() en require(), ce qui casserait sur un package ESM-only.
const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<ExpoSdk>;

let sdkPromise: Promise<ExpoSdk> | undefined;

/** Lazy-load du SDK (ESM-only) : charge une seule fois, au premier usage. */
function getExpoSdk(): Promise<ExpoSdk> {
  if (!sdkPromise) sdkPromise = dynImport('expo-server-sdk');
  return sdkPromise;
}

/** Canal Android des pushes client — doit correspondre au defaultChannel du plugin habichou. */
export const ORDERS_CHANNEL_ID = 'orders';

export interface PushPayload {
  title: string;
  body: string;
  /** Canal Android (doit correspondre a un setNotificationChannelAsync cote app). */
  channelId?: string;
  /** Son : 'default' ou nom de fichier bundle (ex: incoming_order.wav). */
  sound?: string;
  /** Donnees arbitraires transmises telles quelles au client. */
  data?: Record<string, unknown>;
}

/** Titres/localisation d'un push client : une variante par langue, fallback fr. */
export type LocalizedPushTemplates = Record<'fr' | 'en' | 'ar', { title: string; body: string }>;

/** Push destination locale : payload deja localise + options canal. */
export interface LocalizedPushPayload {
  templates: LocalizedPushTemplates;
  channelId?: string;
  sound?: string;
  data?: Record<string, unknown>;
}

/** Choix de la variante selon le locale stocke sur User (aeb = derja = variante ar). */
function pickTemplate(
  templates: LocalizedPushTemplates,
  locale: string | null | undefined,
): { title: string; body: string } {
  if (locale === 'en') return templates.en;
  if (locale === 'aeb' || locale === 'ar') return templates.ar;
  return templates.fr;
}

/**
 * Envoie une liste de messages via Expo et purge les jetons DeviceNotRegistered.
 * Retourne le nombre de tickets ok.
 */
async function sendMessages(
  Expo: typeof import('expo-server-sdk').Expo,
  messages: ExpoPushMessage[],
): Promise<{ sent: number; invalid: Set<string> }> {
  const expo = new Expo();
  let sent = 0;
  const invalid = new Set<string>();
  for (const chunk of expo.chunkPushNotifications(messages)) {
    const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
    tickets.forEach((ticket, index) => {
      const to = chunk[index]?.to;
      const token = typeof to === 'string' ? to : undefined;
      if (ticket.status === 'ok') {
        sent += 1;
        return;
      }
      const error = ticket.details?.error;
      logger.warn('push', `ticket erreur=${error ?? 'inconnu'}`);
      // Jeton expire / app desinstallee : on l'efface pour ne pas reessayer.
      if (error === 'DeviceNotRegistered' && token) invalid.add(token);
    });
  }
  if (invalid.size > 0) {
    await prisma.user.updateMany({
      where: { expo_push_token: { in: [...invalid] } },
      data: { expo_push_token: null },
    });
    logger.info('push', `jetons invalides purgees=${invalid.size}`);
  }
  return { sent, invalid };
}

/**
 * Envoie une notification push aux admins ayant enregistre un jeton Expo.
 * Jamais bloquant : toute erreur est loguee, l'appelant n'est pas interrompu.
 */
export async function pushAdmins(payload: PushPayload): Promise<number> {
  try {
    const { Expo } = await getExpoSdk();
    const admins = await prisma.user.findMany({
      where: { role: 'admin', expo_push_token: { not: null } },
      select: { id: true, expo_push_token: true },
    });
    const tokens = admins
      .map((a) => a.expo_push_token)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (tokens.length === 0) return 0;

    const valid: string[] = [];
    for (const token of tokens) {
      if (Expo.isExpoPushToken(token)) valid.push(token);
      else logger.warn('push', `jeton mal forme ignore (admin=${admins.find((a) => a.expo_push_token === token)?.id})`);
    }
    if (valid.length === 0) return 0;

    const messages: ExpoPushMessage[] = valid.map((to) => ({
      to,
      title: payload.title,
      body: payload.body,
      sound: payload.sound ?? 'default',
      priority: 'high',
      channelId: payload.channelId,
      data: payload.data,
    }));

    const { sent } = await sendMessages(Expo, messages);
    logger.info('push', `push admin envoye=${sent}/${valid.length} canal=${payload.channelId ?? 'default'}`);
    return sent;
  } catch (err) {
    logger.error('push', 'échec envoi push', err instanceof Error ? err : String(err));
    return 0;
  }
}

/**
 * Push localise a UN utilisateur (token + locale lus en base).
 * Jamais bloquant : toute erreur est loguee, retourne 0 en cas d'echec.
 */
export async function pushToUser(userId: string, payload: LocalizedPushPayload): Promise<number> {
  try {
    const { Expo } = await getExpoSdk();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, expo_push_token: true, locale: true },
    });
    if (!user?.expo_push_token) return 0;
    if (!Expo.isExpoPushToken(user.expo_push_token)) {
      logger.warn('push', `jeton mal forme ignore (user=${userId})`);
      return 0;
    }

    const { title, body } = pickTemplate(payload.templates, user.locale);
    const message: ExpoPushMessage = {
      to: user.expo_push_token,
      title,
      body,
      sound: payload.sound ?? 'default',
      priority: 'high',
      channelId: payload.channelId ?? ORDERS_CHANNEL_ID,
      data: payload.data,
    };

    const { sent } = await sendMessages(Expo, [message]);
    logger.info('push', `push user envoye=${sent} user=${userId} canal=${message.channelId ?? 'default'}`);
    return sent;
  } catch (err) {
    logger.error('push', 'échec envoi push user', err instanceof Error ? err : String(err));
    return 0;
  }
}

/** Statuts pour lesquels le client recoit un push (chaque changement du stepper). */
const PUSHABLE_STATUSES: OrderStatus[] = [
  'confirmed',
  'preparing',
  'picked_up',
  'on_the_way',
  'delivered',
  'cancelled',
];

const ORDER_STATUS_TEMPLATES: Partial<Record<OrderStatus, LocalizedPushTemplates>> = {
  confirmed: {
    fr: { title: 'Commande mise à jour', body: 'Votre commande est confirmée' },
    en: { title: 'Order update', body: 'Your order has been confirmed' },
    ar: { title: 'تحديث الطلب', body: 'تم تأكيد طلبك' },
  },
  preparing: {
    fr: { title: 'Commande mise à jour', body: 'Votre commande est en préparation' },
    en: { title: 'Order update', body: 'Your order is being prepared' },
    ar: { title: 'تحديث الطلب', body: 'طلبك قيد التحضير' },
  },
  picked_up: {
    fr: { title: 'Commande mise à jour', body: 'Le livreur a récupéré votre commande' },
    en: { title: 'Order update', body: 'The courier has picked up your order' },
    ar: { title: 'تحديث الطلب', body: 'السائق تسلم طلبك' },
  },
  on_the_way: {
    fr: { title: 'Commande mise à jour', body: 'Votre commande est en route' },
    en: { title: 'Order update', body: 'Your order is on the way' },
    ar: { title: 'تحديث الطلب', body: 'طلبك في الطريق' },
  },
  delivered: {
    fr: { title: 'Commande mise à jour', body: 'Votre commande a été livrée' },
    en: { title: 'Order update', body: 'Your order has been delivered' },
    ar: { title: 'تحديث الطلب', body: 'تم توصيل طلبك' },
  },
  cancelled: {
    fr: { title: 'Commande mise à jour', body: 'Votre commande a été annulée' },
    en: { title: 'Order update', body: 'Your order has been cancelled' },
    ar: { title: 'تحديث الطلب', body: 'تم إلغاء طلبك' },
  },
};

/**
 * Push au client de la commande sur changement de statut (chaque marche du stepper).
 * Best effort : ne leve jamais (pushToUser avale deja ses erreurs).
 */
export async function pushOrderStatusToUser(
  userId: string,
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  if (!PUSHABLE_STATUSES.includes(status)) return;
  const templates = ORDER_STATUS_TEMPLATES[status];
  if (!templates) return;
  await pushToUser(userId, {
    templates,
    channelId: ORDERS_CHANNEL_ID,
    data: { type: 'order_status', order_id: orderId, status, url: `/order/${orderId}` },
  });
}

/** Push au client : devis de demande custom recu. Best effort. */
export async function pushCustomQuoteToUser(
  userId: string,
  customRequestId: string,
  price: number,
): Promise<void> {
  const amount = price.toFixed(2);
  await pushToUser(userId, {
    templates: {
      fr: { title: 'Devis reçu', body: `Prix proposé : ${amount} MAD` },
      en: { title: 'Quote received', body: `Proposed price: ${amount} MAD` },
      ar: { title: 'وصل عرض السعر', body: `السعر المقترح: ${amount} MAD` },
    },
    channelId: ORDERS_CHANNEL_ID,
    data: {
      type: 'custom_quote',
      custom_request_id: customRequestId,
      url: `/request/${customRequestId}`,
    },
  });
}
