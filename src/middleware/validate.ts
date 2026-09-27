import type { NextFunction, Request, Response } from 'express';

/** Structure minimale partagee par tout schema zod (evite les problemes de generiques). */
export interface AnySchema {
  parse(data: unknown): unknown;
}

type Wrapper = { body?: AnySchema; query?: AnySchema; params?: AnySchema };

function isEnvelopeSchema(input: AnySchema | Wrapper): input is AnySchema {
  return typeof (input as AnySchema).parse === 'function';
}

/**
 * Accepte les deux styles utilises dans les routes :
 *  - validate(z.object({ body: ..., params: ... }))  → enveloppe zod unique
 *  - validate({ body: schema, params: schema })       → objet wrapper
 */
export function validate(input: AnySchema | Wrapper) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (isEnvelopeSchema(input)) {
        const envelope = input.parse({ body: req.body ?? {}, query: req.query ?? {}, params: req.params ?? {} }) as {
          body?: unknown;
          query?: unknown;
          params?: unknown;
        };
        if (envelope && typeof envelope === 'object') {
          if ('body' in envelope) req.body = envelope.body;
          if ('params' in envelope && envelope.params) {
            Object.assign(req.params as Record<string, unknown>, envelope.params);
          }
          req.validated = envelope;
        }
        return next();
      }

      const validated: { body?: unknown; query?: unknown; params?: unknown } = {};
      if (input.body) validated.body = input.body.parse(req.body ?? {});
      if (input.query) validated.query = input.query.parse(req.query ?? {});
      if (input.params) {
        validated.params = input.params.parse(req.params ?? {});
        Object.assign(req.params as Record<string, unknown>, validated.params);
      }
      req.validated = validated;
      if (input.body) req.body = validated.body;
      next();
    } catch (err) {
      next(err);
    }
  };
}
