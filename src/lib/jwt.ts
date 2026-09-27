import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import type { Role, User } from '@prisma/client';
import { env } from '../config/env';
import { ApiError } from './errors';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  type: 'access';
}

export function signAccessToken(user: Pick<User, 'id' | 'role'>): string {
  const payload: AccessTokenPayload = { sub: user.id, role: user.role, type: 'access' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL } as SignOptions);
}

export function signRefreshToken(user: Pick<User, 'id' | 'role'>): string {
  const payload = { sub: user.id, role: user.role, type: 'refresh' };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_TTL } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    if (payload.type !== 'access') throw new Error('wrong type');
    return payload;
  } catch {
    throw ApiError.unauthorized('Token invalide ou expire', 'INVALID_TOKEN');
  }
}

export function verifyRefreshToken(token: string): { sub: string } {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string; type: string };
    if (payload.type !== 'refresh') throw new Error('wrong type');
    return payload;
  } catch {
    throw ApiError.unauthorized('Refresh token invalide', 'INVALID_REFRESH_TOKEN');
  }
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function extractBearer(header?: string): string {
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('En-tête Authorization manquant (Bearer <token>)');
  }
  return header.slice(7).trim();
}
