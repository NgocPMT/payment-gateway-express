import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { app } from '../../src/app.js';
import { db, disconnectDatabase } from '../../src/config/db.js';
import { accounts, idempotencyKeys, orders, users } from '../../src/models/index.js';
import { ordersRepository } from '../../src/modules/orders/orders.repository.js';
import type { OrderDTO, PaginatedOrdersResponse } from '../../src/modules/orders/orders.schemas.js';
import { HTTP_STATUS } from '../../src/shared/constants/http-status.js';

interface AuthRegisterResponse {
  user: { id: string };
  tokens: { accessToken: string };
}

describe('Orders API Integration', () => {
  let server: Server;
  let baseUrl: string;
  let userAId: string;
  let userBId: string;
  let userAToken: string;
  let userBToken: string;

  async function registerUser(suffix: string): Promise<AuthRegisterResponse> {
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `orders_${suffix}@example.com`,
        username: `orders_${suffix}`,
        password: 'Password123!',
      }),
    });
    const rawBody = await response.text();
    expect(response.status, rawBody).toBe(HTTP_STATUS.HTTP_201_CREATED);
    return JSON.parse(rawBody) as AuthRegisterResponse;
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const nonce = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const userA = await registerUser(`a_${nonce}`);
    const userB = await registerUser(`b_${nonce}`);
    userAId = userA.user.id;
    userBId = userB.user.id;
    userAToken = userA.tokens.accessToken;
    userBToken = userB.tokens.accessToken;
  });

  afterAll(async () => {
    const testUserIds = [userAId, userBId].filter(Boolean);
    if (testUserIds.length > 0) {
      await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, testUserIds));
      await db.delete(orders).where(inArray(orders.userId, testUserIds));
      await db.delete(accounts).where(inArray(accounts.userId, testUserIds));
      await db.delete(users).where(inArray(users.id, testUserIds));
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await disconnectDatabase();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const response = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 50000, description: 'Test order' }),
    });

    expect(response.status).toBe(HTTP_STATUS.HTTP_401_UNAUTHORIZED);
  });

  it('rejects invalid order amounts with 400', async () => {
    const tooSmall = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ amount: 500, description: 'Too small' }),
    });
    expect(tooSmall.status).toBe(HTTP_STATUS.HTTP_400_BAD_REQUEST);

    const tooLarge = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ amount: 2147483648, description: 'Overflow' }),
    });
    expect(tooLarge.status).toBe(HTTP_STATUS.HTTP_400_BAD_REQUEST);
  });

  it('rejects POST /api/v1/orders without Idempotency-Key header with 400', async () => {
    const response = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({ amount: 25000, description: 'Missing key' }),
    });

    expect(response.status).toBe(HTTP_STATUS.HTTP_400_BAD_REQUEST);
  });

  it('creates, lists, and enforces ownership on GET /api/v1/orders/:id', async () => {
    const createA1 = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ amount: 25000, description: '  Order A1  ' }),
    });
    expect(createA1.status).toBe(HTTP_STATUS.HTTP_201_CREATED);
    const orderA1 = (await createA1.json()) as OrderDTO;
    expect(orderA1.userId).toBe(userAId);
    expect(orderA1.amount).toBe(25000);
    expect(orderA1.description).toBe('Order A1');
    expect(orderA1.status).toBe('PENDING');

    const createB1 = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userBToken}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ amount: 30000, description: 'Order B1' }),
    });
    expect(createB1.status).toBe(HTTP_STATUS.HTTP_201_CREATED);

    const listA = await fetch(`${baseUrl}/api/v1/orders?page=1&limit=10&status=PENDING`, {
      headers: { authorization: `Bearer ${userAToken}` },
    });
    expect(listA.status).toBe(HTTP_STATUS.HTTP_200_OK);
    const listBody = (await listA.json()) as PaginatedOrdersResponse;
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]?.id).toBe(orderA1.id);
    expect(listBody.pagination.total).toBe(1);

    const getOwned = await fetch(`${baseUrl}/api/v1/orders/${orderA1.id}`, {
      headers: { authorization: `Bearer ${userAToken}` },
    });
    expect(getOwned.status).toBe(HTTP_STATUS.HTTP_200_OK);

    const getForeign = await fetch(`${baseUrl}/api/v1/orders/${orderA1.id}`, {
      headers: { authorization: `Bearer ${userBToken}` },
    });
    expect(getForeign.status).toBe(HTTP_STATUS.HTTP_404_NOT_FOUND);

    const getMissing = await fetch(
      `${baseUrl}/api/v1/orders/018f6e72-0000-7000-8000-000000000000`,
      { headers: { authorization: `Bearer ${userAToken}` } },
    );
    expect(getMissing.status).toBe(HTTP_STATUS.HTTP_404_NOT_FOUND);
  });

  it('replays stored order on sequential retry and rejects payload mismatch with 422', async () => {
    const idempotencyKey = randomUUID();
    const payload = { amount: 42000, description: 'Retryable order' };

    const first = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(HTTP_STATUS.HTTP_201_CREATED);
    const firstOrder = (await first.json()) as OrderDTO;

    const retry = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(HTTP_STATUS.HTTP_201_CREATED);
    const retryOrder = (await retry.json()) as OrderDTO;
    expect(retryOrder).toEqual(firstOrder);

    const mismatched = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ amount: 99000, description: 'Different payload' }),
    });
    expect(mismatched.status).toBe(HTTP_STATUS.HTTP_422_UNPROCESSABLE_ENTITY);
  });

  it('prevents duplicate orders under concurrent requests with the same Idempotency-Key', async () => {
    const beforeListRes = await fetch(`${baseUrl}/api/v1/orders?page=1&limit=100`, {
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const beforeList = (await beforeListRes.json()) as PaginatedOrdersResponse;
    const countBefore = beforeList.pagination.total;

    const idempotencyKey = randomUUID();
    const payload = { amount: 77000, description: 'Concurrent order' };
    const concurrentRequests = 5;

    const responses = await Promise.all(
      Array.from({ length: concurrentRequests }, () =>
        fetch(`${baseUrl}/api/v1/orders`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${userAToken}`,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        }),
      ),
    );

    const statuses = responses.map((res) => res.status);
    const createdCount = statuses.filter((s) => s === HTTP_STATUS.HTTP_201_CREATED).length;
    const conflictCount = statuses.filter((s) => s === HTTP_STATUS.HTTP_409_CONFLICT).length;

    expect(createdCount).toBeGreaterThanOrEqual(1);
    expect(createdCount + conflictCount).toBe(concurrentRequests);

    const afterListRes = await fetch(`${baseUrl}/api/v1/orders?page=1&limit=100`, {
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const afterList = (await afterListRes.json()) as PaginatedOrdersResponse;
    expect(afterList.pagination.total).toBe(countBefore + 1);
  });

  it('does not create duplicate order when client disconnects after order insert commits', async () => {
    const beforeListRes = await fetch(`${baseUrl}/api/v1/orders?page=1&limit=100`, {
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const beforeList = (await beforeListRes.json()) as PaginatedOrdersResponse;
    const countBefore = beforeList.pagination.total;

    const idempotencyKey = randomUUID();
    const payload = { amount: 65000, description: 'Disconnect mid-flight' };
    const parsedUrl = new URL(`${baseUrl}/api/v1/orders`);

    let clientReq: http.ClientRequest | undefined;
    const originalCreateOrder = ordersRepository.createOrder.bind(ordersRepository);
    const createOrderSpy = vi
      .spyOn(ordersRepository, 'createOrder')
      .mockImplementationOnce(async (data, executor) => {
        const created = await originalCreateOrder(data, executor);
        // Simulate client dropping TCP connection right after order insert, before HTTP response flushes
        clientReq?.destroy();
        return created;
      });

    await new Promise<void>((resolve) => {
      clientReq = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${userAToken}`,
            'idempotency-key': idempotencyKey,
          },
        },
        () => resolve(),
      );
      clientReq.on('error', () => resolve());
      clientReq.on('close', () => resolve());
      clientReq.write(JSON.stringify(payload));
      clientReq.end();
    });

    createOrderSpy.mockRestore();

    // Give server a brief moment to finish committing the transaction
    await new Promise((resolve) => setTimeout(resolve, 100));

    const retry = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(HTTP_STATUS.HTTP_201_CREATED);

    const afterListRes = await fetch(`${baseUrl}/api/v1/orders?page=1&limit=100`, {
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const afterList = (await afterListRes.json()) as PaginatedOrdersResponse;
    expect(afterList.pagination.total).toBe(countBefore + 1);
  });

  it('exposes orders endpoints in /openapi.json', async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    expect(response.status).toBe(HTTP_STATUS.HTTP_200_OK);

    const doc = (await response.json()) as { paths: Record<string, unknown> };
    expect(doc.paths['/api/v1/orders']).toBeDefined();
    expect(doc.paths['/api/v1/orders/{id}']).toBeDefined();
  });
});
