import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { db } from '../config/db.js';
import {
  idempotencyKeys,
  type IdempotencyKeyRecord,
} from '../models/idempotency-key.model.js';
import { HTTP_STATUS } from '../shared/constants/http-status.js';
import { createHttpError } from '../shared/errors/http-error.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const DEFAULT_TTL_MS = 86_400_000; // 24 hours

export interface AcquireIdempotencyInput {
  userId: string;
  endpoint: string;
  key: string;
  requestHash: string;
  expiresAt: Date;
}

export interface IdempotencyStore {
  tryAcquire(input: AcquireIdempotencyInput): Promise<IdempotencyKeyRecord | null>;
  findByKey(userId: string, endpoint: string, key: string): Promise<IdempotencyKeyRecord | null>;
  markCompleted(
    id: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void>;
  deleteById(id: string): Promise<void>;
}

export interface IdempotencyMiddlewareOptions {
  ttlMs?: number;
  store?: IdempotencyStore;
}

const drizzleIdempotencyStore: IdempotencyStore = {
  async tryAcquire(input: AcquireIdempotencyInput): Promise<IdempotencyKeyRecord | null> {
    const [inserted] = await db
      .insert(idempotencyKeys)
      .values({
        userId: input.userId,
        endpoint: input.endpoint,
        key: input.key,
        requestHash: input.requestHash,
        status: 'IN_PROGRESS',
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing({
        target: [idempotencyKeys.userId, idempotencyKeys.endpoint, idempotencyKeys.key],
      })
      .returning();

    return inserted ?? null;
  },

  async findByKey(
    userId: string,
    endpoint: string,
    key: string,
  ): Promise<IdempotencyKeyRecord | null> {
    const [record] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.endpoint, endpoint),
          eq(idempotencyKeys.key, key),
        ),
      )
      .limit(1);

    return record ?? null;
  },

  async markCompleted(
    id: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    await db
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus,
        responseBody,
      })
      .where(eq(idempotencyKeys.id, id));
  },

  async deleteById(id: string): Promise<void> {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
  },
};

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }

  const record = value as Record<string, unknown>;
  const sortedEntries = Object.keys(record)
    .sort()
    .map((key) => [key, canonicalizeValue(record[key])] as const);

  return Object.fromEntries(sortedEntries);
}

export function computeRequestHash(payload: unknown): string {
  const canonicalJson = JSON.stringify(canonicalizeValue(payload ?? null));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

function extractIdempotencyKey(req: Request): string {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  if (typeof raw !== 'string') {
    throw createHttpError(
      HTTP_STATUS.HTTP_400_BAD_REQUEST,
      'Idempotency-Key header is required',
    );
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw createHttpError(
      HTTP_STATUS.HTTP_400_BAD_REQUEST,
      'Idempotency-Key header cannot be empty',
    );
  }

  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw createHttpError(
      HTTP_STATUS.HTTP_400_BAD_REQUEST,
      `Idempotency-Key header cannot exceed ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }

  return trimmed;
}

function attachResponsePersistenceHooks(
  res: Response,
  recordId: string,
  store: IdempotencyStore,
): void {
  let responseCaptured = false;
  let capturedBody: Record<string, unknown> = {};
  let finalized = false;

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown): Response => {
    responseCaptured = true;
    capturedBody =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : { data: body };
    return originalJson(body);
  }) as Response['json'];

  const cleanupInProgress = (): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    void store.deleteById(recordId);
  };

  res.on('finish', () => {
    if (finalized) {
      return;
    }
    finalized = true;

    if (res.statusCode < HTTP_STATUS.HTTP_500_INTERNAL_SERVER_ERROR && responseCaptured) {
      void store.markCompleted(recordId, res.statusCode, capturedBody);
      return;
    }

    void store.deleteById(recordId);
  });

  res.on('close', () => {
    if (!res.writableFinished) {
      cleanupInProgress();
    }
  });
}

export function requireIdempotencyKey(
  endpoint: string,
  options: IdempotencyMiddlewareOptions = {},
): RequestHandler {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const store = options.store ?? drizzleIdempotencyStore;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        next(createHttpError(HTTP_STATUS.HTTP_401_UNAUTHORIZED, 'Authentication required'));
        return;
      }

      const key = extractIdempotencyKey(req);
      const payload = res.locals.validated?.body ?? req.body;
      const requestHash = computeRequestHash(payload);
      const acquireInput: AcquireIdempotencyInput = {
        userId,
        endpoint,
        key,
        requestHash,
        expiresAt: new Date(Date.now() + ttlMs),
      };

      let acquired = await store.tryAcquire(acquireInput);

      if (!acquired) {
        const existing = await store.findByKey(userId, endpoint, key);
        if (existing && existing.expiresAt.getTime() <= Date.now()) {
          await store.deleteById(existing.id);
          acquired = await store.tryAcquire(acquireInput);
        }

        if (!acquired) {
          if (!existing) {
            next(
              createHttpError(
                HTTP_STATUS.HTTP_409_CONFLICT,
                'A request with this Idempotency-Key is currently in progress',
              ),
            );
            return;
          }

          if (existing.requestHash !== requestHash) {
            next(
              createHttpError(
                HTTP_STATUS.HTTP_422_UNPROCESSABLE_ENTITY,
                'Idempotency-Key cannot be reused with a different request payload',
              ),
            );
            return;
          }

          if (existing.status === 'IN_PROGRESS') {
            next(
              createHttpError(
                HTTP_STATUS.HTTP_409_CONFLICT,
                'A request with this Idempotency-Key is currently in progress',
              ),
            );
            return;
          }

          res
            .status(existing.responseStatus ?? HTTP_STATUS.HTTP_200_OK)
            .json(existing.responseBody ?? {});
          return;
        }
      }

      attachResponsePersistenceHooks(res, acquired.id, store);
      next();
    } catch (error) {
      next(error);
    }
  };
}
