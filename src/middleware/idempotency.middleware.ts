import { createHash } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
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
const DEFAULT_IN_PROGRESS_LEASE_MS = 60_000; // 60 seconds
const DEFAULT_COMPLETED_TTL_MS = 86_400_000; // 24 hours

export type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    expiresAt: Date,
    executor?: DbExecutor,
  ): Promise<void>;
  deleteById(id: string): Promise<void>;
  runInTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
}

export interface IdempotencyExecutionContext {
  recordId: string;
  completedTtlMs: number;
  store: IdempotencyStore;
}

export interface IdempotencyMiddlewareOptions {
  ttlMs?: number;
  inProgressLeaseMs?: number;
  store?: IdempotencyStore;
}

const drizzleIdempotencyStore: IdempotencyStore = {
  async tryAcquire(input: AcquireIdempotencyInput): Promise<IdempotencyKeyRecord | null> {
    // Atomically insert a new IN_PROGRESS row or take over an expired row in a single statement,
    // avoiding delete-then-insert races and stale in-memory reads.
    const [acquired] = await db
      .insert(idempotencyKeys)
      .values({
        userId: input.userId,
        endpoint: input.endpoint,
        key: input.key,
        requestHash: input.requestHash,
        status: 'IN_PROGRESS',
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [idempotencyKeys.userId, idempotencyKeys.endpoint, idempotencyKeys.key],
        set: {
          requestHash: input.requestHash,
          status: 'IN_PROGRESS',
          responseStatus: null,
          responseBody: null,
          expiresAt: input.expiresAt,
          updatedAt: sql`NOW()`,
        },
        setWhere: lte(idempotencyKeys.expiresAt, sql`NOW()`),
      })
      .returning();

    return acquired ?? null;
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
    expiresAt: Date,
    executor: DbExecutor = db,
  ): Promise<void> {
    await executor
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus,
        responseBody,
        expiresAt,
      })
      .where(eq(idempotencyKeys.id, id));
  },

  async deleteById(id: string): Promise<void> {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
  },

  async runInTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return db.transaction(fn);
  },
};

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
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

function toResponseBody<T>(result: T): Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { data: result };
}

async function runBestEffortCompensate<TPrepared>(
  compensate: ((prepared: TPrepared, error: unknown) => Promise<void>) | undefined,
  prepared: TPrepared,
  error: unknown,
): Promise<void> {
  if (!compensate) {
    return;
  }

  try {
    await compensate(prepared, error);
  } catch {
    // Best-effort compensation must not mask the original persistence error.
  }
}

/**
 * Runs an idempotent mutation and marks the idempotency record COMPLETED inside
 * the same database transaction, ensuring both commit atomically before the HTTP
 * response is sent. Cleans up the IN_PROGRESS lock if the transaction fails.
 */
export async function executeIdempotent<T>(
  res: Response,
  statusCode: number,
  operation: (tx?: DbExecutor) => Promise<T>,
): Promise<T> {
  const ctx = res.locals.idempotency;
  if (!ctx) {
    return operation();
  }

  try {
    return await ctx.store.runInTransaction(async (tx) => {
      const result = await operation(tx);
      const completedExpiresAt = new Date(Date.now() + ctx.completedTtlMs);
      await ctx.store.markCompleted(
        ctx.recordId,
        statusCode,
        toResponseBody(result),
        completedExpiresAt,
        tx,
      );
      return result;
    });
  } catch (error) {
    await ctx.store.deleteById(ctx.recordId);
    throw error;
  }
}

/**
 * Runs a two-phase idempotent mutation for endpoints that call an external API
 * (such as PayOS). Phase 1 (`prepare`) executes outside any database transaction,
 * and Phase 2 (`commitInTx`) persists the result and marks the idempotency record
 * COMPLETED atomically in one transaction. Cleans up IN_PROGRESS and invokes
 * optional best-effort `compensate` if Phase 2 fails.
 */
export async function executeExternalIdempotent<TPrepared, TResult>(
  res: Response,
  statusCode: number,
  prepare: () => Promise<TPrepared>,
  commitInTx: (prepared: TPrepared, tx?: DbExecutor) => Promise<TResult>,
  compensate?: (prepared: TPrepared, error: unknown) => Promise<void>,
): Promise<TResult> {
  const ctx = res.locals.idempotency;
  if (!ctx) {
    const prepared = await prepare();
    try {
      return await commitInTx(prepared);
    } catch (error) {
      await runBestEffortCompensate(compensate, prepared, error);
      throw error;
    }
  }

  let prepared: TPrepared;
  try {
    prepared = await prepare();
  } catch (error) {
    await ctx.store.deleteById(ctx.recordId);
    throw error;
  }

  try {
    return await ctx.store.runInTransaction(async (tx) => {
      const result = await commitInTx(prepared, tx);
      const completedExpiresAt = new Date(Date.now() + ctx.completedTtlMs);
      await ctx.store.markCompleted(
        ctx.recordId,
        statusCode,
        toResponseBody(result),
        completedExpiresAt,
        tx,
      );
      return result;
    });
  } catch (error) {
    await runBestEffortCompensate(compensate, prepared, error);
    await ctx.store.deleteById(ctx.recordId);
    throw error;
  }
}

export function requireIdempotencyKey(
  endpoint: string,
  options: IdempotencyMiddlewareOptions = {},
): RequestHandler {
  const completedTtlMs = options.ttlMs ?? DEFAULT_COMPLETED_TTL_MS;
  const inProgressLeaseMs = options.inProgressLeaseMs ?? DEFAULT_IN_PROGRESS_LEASE_MS;
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

      const acquired = await store.tryAcquire({
        userId,
        endpoint,
        key,
        requestHash,
        expiresAt: new Date(Date.now() + inProgressLeaseMs),
      });

      if (!acquired) {
        const existing = await store.findByKey(userId, endpoint, key);

        // The active record may have been rolled back/deleted between tryAcquire() and findByKey().
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

      res.locals.idempotency = { recordId: acquired.id, completedTtlMs, store };
      next();
    } catch (error) {
      next(error);
    }
  };
}
