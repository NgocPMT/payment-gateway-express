import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdempotencyKeyRecord } from '../../../src/models/idempotency-key.model.js';
import {
  computeRequestHash,
  requireIdempotencyKey,
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

  beforeEach(() => {
    store = {
      tryAcquire: vi.fn(),
      findByKey: vi.fn(),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      deleteById: vi.fn().mockResolvedValue(undefined),
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
  });

  describe('requireIdempotencyKey', () => {
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

    it('calls next and marks record COMPLETED when handler responds with 201 JSON', async () => {
      const acquired = buildRecord();
      store.tryAcquire = vi.fn().mockResolvedValue(acquired);
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
      res.status(HTTP_STATUS.HTTP_201_CREATED).json(responsePayload);
      res.emit('finish');
      await Promise.resolve();

      expect(store.markCompleted).toHaveBeenCalledWith(
        acquired.id,
        HTTP_STATUS.HTTP_201_CREATED,
        responsePayload,
      );
      expect(store.deleteById).not.toHaveBeenCalled();
    });

    it('deletes IN_PROGRESS record when handler responds with 5xx error', async () => {
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

      res.status(HTTP_STATUS.HTTP_500_INTERNAL_SERVER_ERROR).json({ error: 'Boom' });
      res.emit('finish');
      await Promise.resolve();

      expect(store.deleteById).toHaveBeenCalledWith(acquired.id);
      expect(store.markCompleted).not.toHaveBeenCalled();
    });

    it('deletes IN_PROGRESS record if connection closes before finishing', async () => {
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

      expect(store.deleteById).toHaveBeenCalledWith(acquired.id);
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

    it('replaces expired record and allows processing to proceed', async () => {
      const expired = buildRecord({
        id: 'expired-id',
        status: 'COMPLETED',
        expiresAt: new Date(Date.now() - 1_000),
      });
      const fresh = buildRecord({ id: 'fresh-id' });
      store.tryAcquire = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(fresh);
      store.findByKey = vi.fn().mockResolvedValue(expired);

      const middleware = requireIdempotencyKey(ENDPOINT, { store });
      const req = createMockRequest({
        userId: USER_ID,
        headers: { 'idempotency-key': KEY },
      });
      const res = createMockResponse({ amount: 50000, description: 'Order #1001' });
      const next = vi.fn();

      await middleware(req, res as never, next);

      expect(store.deleteById).toHaveBeenCalledWith('expired-id');
      expect(store.tryAcquire).toHaveBeenCalledTimes(2);
      expect(next).toHaveBeenCalledWith();
    });
  });
});
