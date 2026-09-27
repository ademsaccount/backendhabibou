import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = 'Non authentifie', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }
  static forbidden(message = 'Acces refuse', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }
  static notFound(message = 'Ressource introuvable', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }
  static conflict(message: string, code = 'CONFLICT', details?: unknown) {
    return new ApiError(409, code, message, details);
  }
  static notImplemented(message: string, code = 'NOT_IMPLEMENTED') {
    return new ApiError(501, code, message);
  }
}

// `any` sur P : permet d'ecrire req.params.id sans cast dans les handlers.
type Handler = (req: Request<any, any, any, any>, res: Response, next: NextFunction) => Promise<unknown> | unknown;

export const asyncHandler =
  (fn: Handler) =>
  (req: Request<any, any, any, any>, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

interface PrismaLikeError {
  code?: string;
  meta?: unknown;
  message?: string;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const at = `${req.method} ${req.originalUrl}`;
  if (res.headersSent) {
    logger.error('error', `${at} error after headers sent`, err);
    return;
  }

  if (err instanceof ApiError) {
    const meta = err.status >= 500 ? err : `${err.code}: ${err.message}`;
    if (err.status >= 500) logger.error('error', `${at} ${err.status} ${err.code}`, meta);
    else logger.warn('error', `${at} ${err.status} ${err.code}: ${err.message}`);
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  if (err instanceof ZodError) {
    logger.warn('error', `${at} 400 VALIDATION_ERROR`, err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Donnees invalides',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  const prismaErr = err as PrismaLikeError & { name?: string; message?: string };
  if (prismaErr && typeof prismaErr === 'object' && prismaErr.name === 'PrismaClientInitializationError') {
    logger.error('error', `${at} 503 DATABASE_UNAVAILABLE`, err instanceof Error ? err : prismaErr.message);
    return res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Base de datos indisponible : verifie DATABASE_URL et que Supabase est joignable',
      },
    });
  }
  if (prismaErr && typeof prismaErr === 'object' && typeof prismaErr.code === 'string') {
    if (prismaErr.code === 'P2002') {
      logger.warn('error', `${at} 409 ALREADY_EXISTS`);
      return res.status(409).json({ error: { code: 'ALREADY_EXISTS', message: 'Cette valeur existe deja' } });
    }
    if (prismaErr.code === 'P2025') {
      logger.warn('error', `${at} 404 NOT_FOUND (P2025)`);
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ressource introuvable' } });
    }
  }

  const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
  logger.error('error', `${at} 500 INTERNAL_ERROR`, err instanceof Error ? err : message);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route introuvable' } });
}
