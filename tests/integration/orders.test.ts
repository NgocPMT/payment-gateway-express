import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../../src/app.js';
import { db, disconnectDatabase } from '../../src/config/db.js';
import { accounts, orders, users } from '../../src/models/index.js';
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
    expect(response.status).toBe(HTTP_STATUS.HTTP_201_CREATED);
    return (await response.json()) as AuthRegisterResponse;
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
      },
      body: JSON.stringify({ amount: 500, description: 'Too small' }),
    });
    expect(tooSmall.status).toBe(HTTP_STATUS.HTTP_400_BAD_REQUEST);

    const tooLarge = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({ amount: 2147483648, description: 'Overflow' }),
    });
    expect(tooLarge.status).toBe(HTTP_STATUS.HTTP_400_BAD_REQUEST);
  });

  it('creates, lists, and enforces ownership on GET /api/v1/orders/:id', async () => {
    const createA1 = await fetch(`${baseUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAToken}`,
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

  it('exposes orders endpoints in /openapi.json', async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    expect(response.status).toBe(HTTP_STATUS.HTTP_200_OK);

    const doc = (await response.json()) as { paths: Record<string, unknown> };
    expect(doc.paths['/api/v1/orders']).toBeDefined();
    expect(doc.paths['/api/v1/orders/{id}']).toBeDefined();
  });
});
