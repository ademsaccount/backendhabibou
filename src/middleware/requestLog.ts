import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const scope = req.path === '/health' ? 'health' : 'http';

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const user = req.user ? ` user=${req.user.id}` : '';
    const message = `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms${user}`;
    if (scope === 'health') logger.debug(scope, message);
    else if (res.statusCode >= 500) logger.error(scope, message);
    else if (res.statusCode >= 400) logger.warn(scope, message);
    else logger.info(scope, message);
  });

  next();
}
