import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { logger } from '../lib/logger';
import { requireAuth } from '../middleware/auth';
import { uploadBuffer } from '../lib/upload';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

export const notificationRouter = Router();
notificationRouter.use(requireAuth);

notificationRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const notifications = await prisma.notification.findMany({
      where: { user_id: req.user!.id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json(notifications);
  }),
);

notificationRouter.put(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!n || n.user_id !== req.user!.id) throw ApiError.notFound('Notification introuvable');
    const updated = await prisma.notification.update({ where: { id: n.id }, data: { is_read: true } });
    res.json(updated);
  }),
);

notificationRouter.put(
  '/read-all',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.notification.updateMany({
      where: { user_id: req.user!.id, is_read: false },
      data: { is_read: true },
    });
    res.json({ updated: count });
  }),
);

export const uploadRouter = Router();
uploadRouter.use(requireAuth);

uploadRouter.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Fichier manquant (champ "file")', 'FILE_REQUIRED');
    if (!req.file.mimetype.startsWith('image/')) {
      throw ApiError.badRequest('Seuls les images sont acceptees', 'INVALID_FILE_TYPE');
    }
    const folder = typeof req.query.folder === 'string' ? req.query.folder : 'misc';
    const safeFolder = folder.replace(/[^a-z0-9_-]/gi, '');
    const start = process.hrtime.bigint();
    logger.info(
      'upload',
      `POST /uploads start folder=${safeFolder} file=${req.file.originalname} mime=${req.file.mimetype} size=${req.file.size}B user=${req.user!.id}`,
    );
    try {
      const url = await uploadBuffer(req.file.buffer, req.file.mimetype, safeFolder);
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info('upload', `POST /uploads ok url=${url} ${durationMs.toFixed(1)}ms`);
      res.status(201).json({ url });
    } catch (err) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger.error(
        'upload',
        `POST /uploads failed folder=${safeFolder} size=${req.file.size}B ${durationMs.toFixed(1)}ms`,
        err instanceof Error ? err : String(err),
      );
      throw err;
    }
  }),
);
