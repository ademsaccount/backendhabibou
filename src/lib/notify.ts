import type { Notification } from '@prisma/client';
import { prisma } from './prisma';
import { emitToUser } from '../socket/io';
import { pushNewMessageToUser } from './push';

export interface NotifyInput {
  user_id: string;
  title: string;
  body: string;
  type?: string;
  data?: Record<string, unknown>;
}

export async function notify(input: NotifyInput): Promise<Notification> {
  const notification = await prisma.notification.create({
    data: {
      user_id: input.user_id,
      title: input.title,
      body: input.body,
      type: input.type ?? 'info',
      data: (input.data ?? {}) as never,
    },
  });
  emitToUser(input.user_id, 'notification:new', notification);
  return notification;
}

export async function notifyAdmins(title: string, body: string, type = 'info', data?: Record<string, unknown>) {
  const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
  await Promise.all(admins.map((a) => notify({ user_id: a.id, title, body, type, data })));
}

/**
 * Notifie le livreur assigné (non-admin, autre que l'expéditeur) : in-app +
 * push sonore. Sans effet s'il n'y en a pas.
 */
export async function notifyAssignedLivreur(
  order: { id: string; livreur_id: string | null },
  senderId: string,
  preview: string,
): Promise<void> {
  if (!order.livreur_id) return;
  const assigned = await prisma.livreur.findUnique({
    where: { id: order.livreur_id },
    select: { user_id: true, user: { select: { role: true } } },
  });
  if (!assigned || assigned.user.role === 'admin' || assigned.user_id === senderId) return;
  await notify({
    user_id: assigned.user_id,
    title: 'Nouveau message',
    body: preview,
    type: 'order',
    data: { order_id: order.id },
  });
  try {
    await pushNewMessageToUser(assigned.user_id, order.id, preview);
  } catch (err) {
    void err;
  }
}
