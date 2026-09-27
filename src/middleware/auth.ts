import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { extractBearer, verifyAccessToken } from '../lib/jwt';
import { toSafeUser } from '../lib/user';

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req.headers.authorization);
    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw ApiError.unauthorized('Utilisateur introuvable', 'USER_NOT_FOUND');
    req.user = toSafeUser(user);
    req.authPayload = { sub: user.id, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden(`Route reservee aux roles : ${roles.join(', ')}`));
    }
    next();
  };
}
