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

/**
 * Envoie une notification push aux admins ayant enregistre un jeton Expo.
 * Jamais bloquant : toute erreur est loguee, l'appelant n'est pas interrompu.
 */
export async function pushAdmins(payload: PushPayload): Promise<number> {
  try {
    const { Expo } = await getExpoSdk();
    const expo = new Expo();
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

    logger.info('push', `push admin envoye=${sent}/${valid.length} canal=${payload.channelId ?? 'default'}`);
    return sent;
  } catch (err) {
    logger.error('push', 'échec envoi push', err instanceof Error ? err : String(err));
    return 0;
  }
}
