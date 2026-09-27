import type { Role } from '@prisma/client';
import type { SafeUser } from '../lib/user';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SafeUser;
      authPayload?: { sub: string; role: Role };
      validated?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
