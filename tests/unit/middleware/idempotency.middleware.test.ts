import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdempotencyKeyRecord } from '../../../src/models/idempotency-key.model.js';
import {
  computeRequestHash,
  executeExternalIdempotent,
  executeIdempotent,
  requireIdempotencyKey,
  type DbExecutor,
  type IdempotencyStore,
} from '../../../src/middleware/idempotency.middleware.js';
import { HTTP_STATUS } from '../../../src/shared/constants/http-status.js';
import { isHttpError } from '../../../src/shared/errors/http-error.js';

const USER_ID = '018f6e72-23b0-7e28-9f20-b42e77b4a1a3';
const ENDPOINT = 'POST /api/v1/orders';
const KEY = 'idem-key-123';

function buildRecord(overrides: Partial<IdempotencyKeyRecord> = {}): IdempotencyKeyRecord {
  const now = new Date('2026-11-27T00:00:00.000Z');
  return {
    id: '018f6e72-9999-7e28-9f20-b42e77b4a1c5',
    userId: USER_ID,
    endpoint: ENDPOINT,
    key: KEY,
    requestHash: computeRequestHash({ amount: 50000, description: 'Order #1001' }),
    status: 'IN_PROGRESS',
    responseStatus: null,
    responseBody: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMockRequest(options: {
  headers?: Record<string, string | string[] | undefined>;
  userId?: string;
  body?: unknown;
} = {}) {
  return {
    headers: options.headers ?? {},
    user: options.userId
      ? { id: options.userId, email: 'user@test.com', role: 'user' }
      : undefined,
    body: options.body ?? { amount: 50000, description: 'Order #1001' },
  } as never;
}

function createMockResponse(validatedBody?: unknown) {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 200,
    writableFinished: false,
    locals: validatedBody !== undefined ? { validated: { body: validatedBody } } : {},
    status: vi.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn().mockImplementation((payload: unknown) => {
      res.writableFinished = true;
      return payload;
    }),
  });
  return res;
}

describe('idempotency.middleware', () => {
  let store: IdempotencyStore;
  const fakeTx = {} as DbExecutor;

  beforeEach(() => {
    store = {
      tryAcquire: vi.fn(),
      findByKey: vi.fn(),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      deleteById: vi.fn().mockResolvedValue(undefined),
      runInTransaction: vi.fn().mockImplementation(async <T>(fn: (tx: DbExecutor) => Promise<T>) => fn(fakeTx)),
    };
  });

  describe('computeRequestHash', () => {
    it('produces identical SHA-256 hashes regardless of object key order', () => {
      const hashA = computeRequestHash({ amount: 50000, description: 'Order #1' });
      const hashB = computeRequestHash({ description: 'Order #1', amount: 50000 });

      expect(hashA).toHaveLength(64);
      expect(hashA).toBe(hashB);
    });

    it('produces different hashes for different payloads', () => {
      const hashA = computeRequestHash({ amount: 50000, description: 'Order #1' });
      const hashB = computeRequestHash({ amount: 50001, description: 'Order #1' });

      expect(hashA).not.toBe(hashB);
    });

    it('produces different hashes for payloads with different Date timestamps', () => {
      const hashA = computeRequestHash({ scheduledAt: new Date('2026-11-27T00:00:00.000Z') });
      const hashB = computeRequestHash({ scheduledAt: new Date('2026-11-27T01:00:00.000Z') });

      expect(hashA).not.toBe(hashB);
    });
  });

  describe('requireIdempotencyKey & executeIdempotent', () => {
    it('rejects with 400 when Idempotency-Key header is missing or blank', async () => {
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const nextMissing = vi.fn();
      await middleware(
        createMockRequest({ userId: USER_ID }),
        createMockResponse() as never,
        nextMissing,
      );

      expect(nextMissing).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: HTTP_STATUS.HTTP_400_BAD_REQUEST }),
      );

      const nextBlank = vi.fn();
      await middleware(
        createMockRequest({ userId: USER_ID, headers: { 'idempotency-key': '   ' } }),
        createMockResponse() as never,
        nextBlank,
      );

      expect(nextBlank).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: HTTP_STATUS.HTTP_400_BAD_REQUEST }),
      );
    });

    it('rejects with 400 when Idempotency-Key exceeds 128 characters', async () => {
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const next = vi.fn();

      await middleware(
        createMockRequest({
          userId: USER_ID,
          headers: { 'idempotency-key': 'k'.repeat(129) },
        }),
        createMockResponse() as never,
        next,
      );

      const err = next.mock.calls[0]?.[0];
      expect(isHttpError(err)).toBe(true);
      expect(err).toMatchObject({ statusCode: HTTP_STATUS.HTTP_400_BAD_REQUEST });
    });

    it('rejects with 401 when req.user is missing', async () => {
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const next = vi.fn();

      await middleware(
        createMockRequest({ headers: { 'idempotency-key': KEY } }),
        createMockResponse() as never,
        next,
      );

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: HTTP_STATUS.HTTP_401_UNAUTHORIZED }),
      );
    });

    it('awaits markCompleted inside transaction before executeIdempotent resolves', async () => {
      const acquired = buildRecord();
      store.tryAcquire = vi.fn().mockResolvedValue(acquired);

      let resolveMarkCompleted: (() => void) | undefined;
      store.markCompleted = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveMarkCompleted = resolve;
          }),
      );

      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      await middleware(req, res as never, next);
      expect(next).toHaveBeenCalledWith();

      const responsePayload = { id: 'order-1', amount: 50000 };
      let settled = false;
      const execution = executeIdempotent(
        res as never,
        HTTP_STATUS.HTTP_201_CREATED,
        async () => responsePayload,
      ).then((result) => {
        settled = true;
        return result;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(store.markCompleted).toHaveBeenCalledWith(
        acquired.id,
        HTTP_STATUS.HTTP_201_CREATED,
        responsePayload,
        expect.any(Date),
        fakeTx,
      );

      resolveMarkCompleted?.();
      await expect(execution).resolves.toEqual(responsePayload);
      expect(settled).toBe(true);
      expect(store.deleteById).not.toHaveBeenCalled();
    });

    it('uses short IN_PROGRESS lease on acquire and extends expiresAt to 24h on markCompleted', async () => {
      const acquired = buildRecord();
      store.tryAcquire = vi.fn().mockResolvedValue(acquired);

      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      const beforeAcquire = Date.now();
      await middleware(req, res as never, next);

      const acquireInput = (store.tryAcquire as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        expiresAt: Date;
      };
      const leaseMs = acquireInput.expiresAt.getTime() - beforeAcquire;
      expect(leaseMs).toBeGreaterThanOrEqual(55_000);
      expect(leaseMs).toBeLessThanOrEqual(65_000);

      const beforeComplete = Date.now();
      await executeIdempotent(res as never, HTTP_STATUS.HTTP_201_CREATED, async () => ({
        id: 'order-1',
      }));

      const completedExpiresAt = (store.markCompleted as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[3] as Date;
      const completedTtlMs = completedExpiresAt.getTime() - beforeComplete;
      expect(completedTtlMs).toBeGreaterThanOrEqual(86_390_000);
      expect(completedTtlMs).toBeLessThanOrEqual(86_410_000);
    });

    it('does not cache 4xx HttpError thrown by operation', async () => {
      const acquired = buildRecord();
      store.tryAcquire = vi.fn().mockResolvedValue(acquired);
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse();
      await middleware(req, res as never, vi.fn());

      await expect(
        executeIdempotent(res as never, HTTP_STATUS.HTTP_201_CREATED, async () => {
          throw Object.assign(new Error('Rate limited'), {
            statusCode: HTTP_STATUS.HTTP_429_TOO_MANY_REQUESTS,
          });
        }),
      ).rejects.toThrow('Rate limited');

      expect(store.markCompleted).not.toHaveBeenCalled();
      expect(store.deleteById).toHaveBeenCalledWith(acquired.id);
    });

    it('marks COMPLETED for 204 No Content operations via executeIdempotent', async () => {
      const acquired = buildRecord();
      store.tryAcquire = vi.fn().mockResolvedValue(acquired);
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse();
      await middleware(req, res as never, vi.fn());

      await executeIdempotent(res as never, HTTP_STATUS.HTTP_204_NO_CONTENT, async () => null);

      expect(store.markCompleted).toHaveBeenCalledWith(
        acquired.id,
        HTTP_STATUS.HTTP_204_NO_CONTENT,
        { data: null },
        expect.any(Date),
        fakeTx,
      );
    });

    it('deletes IN_PROGRESS record and rethrows when operation fails inside transaction', async () => {
      const acquired = buildRecord();
      store.tryAcquire = vi.fn().mockResolvedValue(acquired);
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse();
      const next = vi.fn();

      await middleware(req, res as never, next);

      await expect(
        executeIdempotent(res as never, HTTP_STATUS.HTTP_201_CREATED, async () => {
          throw new Error('DB insert failed');
        }),
      ).rejects.toThrow('DB insert failed');

      expect(store.deleteById).toHaveBeenCalledWith(acquired.id);
      expect(store.markCompleted).not.toHaveBeenCalled();
    });

    it('does not delete IN_PROGRESS record when client socket closes mid-flight', async () => {
      const acquired = buildRecord();
      store.tryAcquire = vi.fn().mockResolvedValue(acquired);
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse();
      const next = vi.fn();

      await middleware(req, res as never, next);

      res.writableFinished = false;
      res.emit('close');
      await Promise.resolve();

      expect(store.deleteById).not.toHaveBeenCalled();
    });

    it('replays stored response when key is COMPLETED and payload matches', async () => {
      const storedBody = { id: 'order-1', amount: 50000 };
      store.tryAcquire = vi.fn().mockResolvedValue(null);
      store.findByKey = vi.fn().mockResolvedValue(
        buildRecord({
          status: 'COMPLETED',
          responseStatus: HTTP_STATUS.HTTP_201_CREATED,
          responseBody: storedBody,
        }),
      );
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      await middleware(req, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(HTTP_STATUS.HTTP_201_CREATED);
      expect(res.json).toHaveBeenCalledWith(storedBody);
    });

    it('rejects with 422 when COMPLETED key is reused with a different payload', async () => {
      store.tryAcquire = vi.fn().mockResolvedValue(null);
      store.findByKey = vi.fn().mockResolvedValue(
        buildRecord({
          status: 'COMPLETED',
          requestHash: computeRequestHash({ amount: 99999, description: 'Different' }),
        }),
      );
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      await middleware(req, res as never, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: HTTP_STATUS.HTTP_422_UNPROCESSABLE_ENTITY }),
      );
    });

    it('rejects with 422 when IN_PROGRESS key is reused with a different payload', async () => {
      store.tryAcquire = vi.fn().mockResolvedValue(null);
      store.findByKey = vi.fn().mockResolvedValue(
        buildRecord({
          status: 'IN_PROGRESS',
          requestHash: computeRequestHash({ amount: 99999, description: 'Different' }),
        }),
      );
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      await middleware(req, res as never, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: HTTP_STATUS.HTTP_422_UNPROCESSABLE_ENTITY }),
      );
    });

    it('rejects with 409 when another request with same key is still IN_PROGRESS', async () => {
      store.tryAcquire = vi.fn().mockResolvedValue(null);
      store.findByKey = vi.fn().mockResolvedValue(
        buildRecord({
          status: 'IN_PROGRESS',
        }),
      );
      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      await middleware(req, res as never, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: HTTP_STATUS.HTTP_409_CONFLICT }),
      );
    });

    it('relies on atomic tryAcquire for expired keys without calling deleteById', async () => {
      const fresh = buildRecord({ id: 'fresh-id' });
      store.tryAcquire = vi.fn().mockResolvedValueOnce(fresh);

      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      await middleware(req, res as never, next);

      expect(store.deleteById).not.toHaveBeenCalled();
      expect(store.findByKey).not.toHaveBeenCalled();
      expect(store.tryAcquire).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('executeExternalIdempotent', () => {
    it('runs prepare outside transaction and commits result + markCompleted inside transaction', async () => {
      let txEntered = false;
      store.runInTransaction = vi.fn(async (fn) => {
        txEntered = true;
        return fn(fakeTx);
      });
      const callOrder: string[] = [];

      const res = createMockResponse({ orderId: 'order-1' });
      (res.locals as Record<string, unknown>).idempotency = {
        recordId: 'rec-ext-1',
        store,
        completedTtlMs: 86_400_000,
      };

      const prepare = vi.fn(async () => {
        callOrder.push('prepare');
        expect(txEntered).toBe(false);
        return { orderCode: 12345 };
      });
      const commitInTx = vi.fn(async (prepared: { orderCode: number }, tx?: DbExecutor) => {
        callOrder.push('commitInTx');
        expect(tx).toBe(fakeTx);
        return { id: 'pay-1', orderCode: prepared.orderCode };
      });
      const compensate = vi.fn(async () => undefined);

      const result = await executeExternalIdempotent(
        res as never,
        HTTP_STATUS.HTTP_201_CREATED,
        prepare,
        commitInTx,
        compensate,
      );

      expect(result).toEqual({ id: 'pay-1', orderCode: 12345 });
      expect(callOrder).toEqual(['prepare', 'commitInTx']);
      expect(store.markCompleted).toHaveBeenCalledWith(
        'rec-ext-1',
        HTTP_STATUS.HTTP_201_CREATED,
        { id: 'pay-1', orderCode: 12345 },
        expect.any(Date),
        fakeTx,
      );
      expect(compensate).not.toHaveBeenCalled();
      expect(store.deleteById).not.toHaveBeenCalled();
    });

    it('deletes IN_PROGRESS record without starting transaction or compensating when prepare fails', async () => {
      const res = createMockResponse({ orderId: 'order-1' });
      (res.locals as Record<string, unknown>).idempotency = {
        recordId: 'rec-ext-2',
        store,
        completedTtlMs: 86_400_000,
      };

      const prepareError = new Error('PayOS upstream failure');
      const prepare = vi.fn(async () => {
        throw prepareError;
      });
      const commitInTx = vi.fn();
      const compensate = vi.fn();

      await expect(
        executeExternalIdempotent(
          res as never,
          HTTP_STATUS.HTTP_201_CREATED,
          prepare,
          commitInTx,
          compensate,
        ),
      ).rejects.toThrow(prepareError);

      expect(store.runInTransaction).not.toHaveBeenCalled();
      expect(commitInTx).not.toHaveBeenCalled();
      expect(compensate).not.toHaveBeenCalled();
      expect(store.deleteById).toHaveBeenCalledWith('rec-ext-2');
    });

    it('calls compensate and deletes IN_PROGRESS record when commitInTx fails', async () => {
      const res = createMockResponse({ orderId: 'order-1' });
      (res.locals as Record<string, unknown>).idempotency = {
        recordId: 'rec-ext-3',
        store,
        completedTtlMs: 86_400_000,
      };

      const preparedData = { orderCode: 98765 };
      const dbError = new Error('unique constraint violation');
      const prepare = vi.fn(async () => preparedData);
      const commitInTx = vi.fn(async () => {
        throw dbError;
      });
      const compensate = vi.fn(async () => undefined);

      await expect(
        executeExternalIdempotent(
          res as never,
          HTTP_STATUS.HTTP_201_CREATED,
          prepare,
          commitInTx,
          compensate,
        ),
      ).rejects.toThrow(dbError);

      expect(compensate).toHaveBeenCalledWith(preparedData, dbError);
      expect(store.deleteById).toHaveBeenCalledWith('rec-ext-3');
      expect(store.markCompleted).not.toHaveBeenCalled();
    });

    it('preserves original commitInTx error and deletes IN_PROGRESS even if compensate throws', async () => {
      const res = createMockResponse({ orderId: 'order-1' });
      (res.locals as Record<string, unknown>).idempotency = {
        recordId: 'rec-ext-4',
        store,
        completedTtlMs: 86_400_000,
      };

      const dbError = new Error('DB commit failed');
      const prepare = vi.fn(async () => ({ orderCode: 55555 }));
      const commitInTx = vi.fn(async () => {
        throw dbError;
      });
      const compensate = vi.fn(async () => {
        throw new Error('compensate failed');
      });

      await expect(
        executeExternalIdempotent(
          res as never,
          HTTP_STATUS.HTTP_201_CREATED,
          prepare,
          commitInTx,
          compensate,
        ),
      ).rejects.toThrow(dbError);

      expect(compensate).toHaveBeenCalledTimes(1);
      expect(store.deleteById).toHaveBeenCalledWith('rec-ext-4');
    });

    it('runs prepare and commitInTx directly when idempotency context is absent', async () => {
      const res = createMockResponse({ orderId: 'order-1' });
      const prepare = vi.fn(async () => ({ orderCode: 11111 }));
      const commitInTx = vi.fn(async (prepared: { orderCode: number }, tx?: DbExecutor) => {
        expect(tx).toBeUndefined();
        return { ok: true, orderCode: prepared.orderCode };
      });
      const compensate = vi.fn();

      const result = await executeExternalIdempotent(
        res as never,
        HTTP_STATUS.HTTP_201_CREATED,
        prepare,
        commitInTx,
        compensate,
      );

      expect(result).toEqual({ ok: true, orderCode: 11111 });
      expect(compensate).not.toHaveBeenCalled();
    });

    it('invokes best-effort compensate when idempotency context is absent and commitInTx fails', async () => {
      const res = createMockResponse({ orderId: 'order-1' });
      const preparedData = { orderCode: 22222 };
      const dbError = new Error('tx failure');
      const prepare = vi.fn(async () => preparedData);
      const commitInTx = vi.fn(async () => {
        throw dbError;
      });
      const compensate = vi.fn(async () => undefined);

      await expect(
        executeExternalIdempotent(
          res as never,
          HTTP_STATUS.HTTP_201_CREATED,
          prepare,
          commitInTx,
          compensate,
        ),
      ).rejects.toThrow(dbError);

      expect(compensate).toHaveBeenCalledWith(preparedData, dbError);
    });
  });
});
