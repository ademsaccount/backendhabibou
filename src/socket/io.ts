import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import { env } from '../config/env';
import { verifyAccessToken } from '../lib/jwt';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

let io: Server | null = null;

interface AuthedSocket extends Socket {
  data: { userId: string; role: string };
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    },
  });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization?.startsWith('Bearer ')
          ? socket.handshake.headers.authorization.slice(7)
          : undefined);
      if (!token) {
        logger.warn('socket', 'handshake rejected: missing token');
        return next(new Error('UNAUTHORIZED'));
      }
      const payload = verifyAccessToken(token);
      (socket as AuthedSocket).data = { userId: payload.sub, role: payload.role };
      next();
    } catch {
      logger.warn('socket', 'handshake rejected: invalid token');
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, role } = (socket as AuthedSocket).data;
    logger.info('socket', `connected socket=${socket.id} user=${userId} role=${role}`);
    socket.join(`user:${userId}`);
    if (role === 'admin') socket.join('admins');

    socket.on('order:subscribe', async (payload: { order_id?: string }, ack?: (r: unknown) => void) => {
      try {
        const orderId = payload?.order_id;
        if (!orderId) return ack?.({ error: { code: 'BAD_REQUEST', message: 'order_id requis' } });
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (!order) return ack?.({ error: { code: 'NOT_FOUND', message: 'Commande introuvable' } });
        let allowed = role === 'admin' || order.user_id === userId;
        // --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
        // if (!allowed && role === 'livreur') {
        //   const livreur = await prisma.livreur.findUnique({ where: { user_id: userId } });
        //   allowed = Boolean(livreur && order.livreur_id === livreur.id);
        // }
        // --- FIN DÉSACTIVÉ ---
        if (!allowed) return ack?.({ error: { code: 'FORBIDDEN', message: 'Acces refuse' } });
        socket.join(`order:${orderId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ error: { code: 'INTERNAL_ERROR', message: 'Erreur serveur' } });
      }
    });

    socket.on('order:unsubscribe', (payload: { order_id?: string }) => {
      if (payload?.order_id) socket.leave(`order:${payload.order_id}`);
    });

    socket.on('livreur:location', async (payload: { lat: number; lng: number; order_id?: string }) => {
      try {
        // --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
        // if (role !== 'livreur') return;
        if (role !== 'admin') return;
        // --- FIN DÉSACTIVÉ ---
        if (typeof payload?.lat !== 'number' || typeof payload?.lng !== 'number') return;
        // --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
        // const livreur = await prisma.livreur.findUnique({ where: { user_id: userId } });
        // if (!livreur) return;
        // await prisma.livreur.update({
        //   where: { id: livreur.id },
        //   data: { current_lat: payload.lat, current_lng: payload.lng },
        // });
        const livreur = await prisma.livreur.upsert({
          where: { user_id: userId },
          update: { current_lat: payload.lat, current_lng: payload.lng },
          create: { user_id: userId, current_lat: payload.lat, current_lng: payload.lng },
        });
        // --- FIN DÉSACTIVÉ ---
        const eventPayload = {
          livreur_id: livreur.id,
          user_id: userId,
          lat: payload.lat,
          lng: payload.lng,
          order_id: payload.order_id ?? null,
          at: new Date().toISOString(),
        };
        if (payload.order_id) {
          io?.to(`order:${payload.order_id}`).emit('livreur:location_update', eventPayload);
        }
        io?.to('admins').emit('livreur:location_update', eventPayload);
      } catch (err) {
        logger.error('socket', `livreur:location handler failed user=${userId}`, err instanceof Error ? err : String(err));
      }
    });

    socket.on('disconnect', () => {
      logger.debug('socket', `disconnected socket=${socket.id} user=${userId}`);
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.io non initialise');
  return io;
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToOrder(orderId: string, event: string, payload: unknown) {
  io?.to(`order:${orderId}`).emit(event, payload);
}

export function emitToAdmins(event: string, payload: unknown) {
  io?.to('admins').emit(event, payload);
}
