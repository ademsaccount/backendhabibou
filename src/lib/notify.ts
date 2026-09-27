import type { Notification } from '@prisma/client';
import { prisma } from './prisma';
import { emitToUser } from '../socket/io';

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
