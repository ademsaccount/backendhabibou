import http from 'http';
import { env } from './config/env';
import { createApp } from './app';
import { logger } from './lib/logger';
import { initSocket } from './socket/io';
import { prisma } from './lib/prisma';

async function main() {
  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  server.on('error', (err) => {
    logger.error('server', `listen error on port ${env.PORT}`, err);
    process.exit(1);
  });

  server.listen(env.PORT, () => {
    logger.info('server', `Habichou API listening on http://localhost:${env.PORT}`);
    logger.info('server', `Health check -> http://localhost:${env.PORT}/health`);
    logger.info('server', `Socket.io -> ws://localhost:${env.PORT}`);
  });

  process.on('uncaughtException', (err) => {
    logger.error('server', 'uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('server', 'unhandledRejection', reason instanceof Error ? reason : String(reason));
  });

  const shutdown = async (signal: string) => {
    logger.info('server', `${signal} received, shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
