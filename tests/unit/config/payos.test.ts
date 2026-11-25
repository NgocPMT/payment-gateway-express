import { describe, expect, it, vi } from 'vitest';
import type { Webhook, WebhookData } from '@payos/node';

import {
  createPayosClient,
  MockPayosClient,
  RealPayosClient,
  signPayosWebhookData,
  type MockRedisClient,
} from '../../../src/config/payos.js';
import { env } from '../../../src/config/env.js';
import { TIME_SECONDS } from '../../../src/shared/constants/time.js';

const TEST_CHECKSUM_KEY = 'test-checksum-key-at-least-16-chars';
const SAMPLE_ORDER_CODE = 1732512000;
const SAMPLE_AMOUNT = 50_000;
const PAST_EXPIRED_AT = 1_000_000;
const FUTURE_OFFSET_SECONDS = 3_600;
const MS_PER_SECOND = 1_000;

function createInMemoryRedisStub(): {
  redis: MockRedisClient;
  setSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>();

  const getSpy = vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null);
  const setSpy = vi.fn(async (key: string, value: string, _options?: { EX?: number }): Promise<string> => {
    store.set(key, value);
    return 'OK';
  });

  return {
    redis: {
      get: getSpy,
      set: setSpy,
    },
    setSpy,
    getSpy,
  };
}

function buildWebhookData(): WebhookData {
  return {
    orderCode: SAMPLE_ORDER_CODE,
    amount: SAMPLE_AMOUNT,
    description: 'Thanh toan don hang',
    accountNumber: '0000123456789',
    reference: 'FT2532512000',
    transactionDateTime: '2026-11-25 13:00:00',
    currency: 'VND',
    paymentLinkId: `mock-pl-${SAMPLE_ORDER_CODE}`,
    code: '00',
    desc: 'success',
  };
}

describe('MockPayosClient', () => {
  it('stores created payment link in Redis with 1-day TTL', async () => {
    const { redis, setSpy } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    const expiredAt = Math.floor(Date.now() / MS_PER_SECOND) + FUTURE_OFFSET_SECONDS;
    const result = await client.createPaymentLink({
      orderCode: SAMPLE_ORDER_CODE,
      amount: SAMPLE_AMOUNT,
      description: 'Test order',
      returnUrl: 'http://localhost:3000/return',
      cancelUrl: 'http://localhost:3000/cancel',
      expiredAt,
    });

    expect(result.orderCode).toBe(SAMPLE_ORDER_CODE);
    expect(result.status).toBe('PENDING');
    expect(result.checkoutUrl).toContain(`mock-pl-${SAMPLE_ORDER_CODE}`);
    expect(setSpy).toHaveBeenCalledWith(
      `mock:payos:payment:${SAMPLE_ORDER_CODE}`,
      expect.any(String),
      { EX: TIME_SECONDS.ONE_DAY },
    );
  });

  it('transitions expired PENDING payment link to EXPIRED on getPaymentLinkInformation', async () => {
    const { redis } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    await client.createPaymentLink({
      orderCode: SAMPLE_ORDER_CODE,
      amount: SAMPLE_AMOUNT,
      description: 'Expired order',
      returnUrl: 'http://localhost:3000/return',
      cancelUrl: 'http://localhost:3000/cancel',
      expiredAt: PAST_EXPIRED_AT,
    });

    const info = await client.getPaymentLinkInformation(SAMPLE_ORDER_CODE);
    expect(info.status).toBe('EXPIRED');
  });

  it('cancels a PENDING payment link and persists CANCELLED state', async () => {
    const { redis } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    await client.createPaymentLink({
      orderCode: SAMPLE_ORDER_CODE,
      amount: SAMPLE_AMOUNT,
      description: 'Cancel order',
      returnUrl: 'http://localhost:3000/return',
      cancelUrl: 'http://localhost:3000/cancel',
    });

    const cancelled = await client.cancelPaymentLink(SAMPLE_ORDER_CODE, 'User requested');
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBe('User requested');
    expect(cancelled.canceledAt).not.toBeNull();
  });

  it('throws when Redis is unavailable instead of falling back to memory', async () => {
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => {
        throw new Error('Redis is unavailable');
      },
    });

    await expect(
      client.createPaymentLink({
        orderCode: SAMPLE_ORDER_CODE,
        amount: SAMPLE_AMOUNT,
        description: 'No redis',
        returnUrl: 'http://localhost:3000/return',
        cancelUrl: 'http://localhost:3000/cancel',
      }),
    ).rejects.toThrow('Redis is unavailable');
  });

  it('verifies valid HMAC-SHA256 webhook signature and rejects tampered payload or signature', async () => {
    const { redis } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    const data = buildWebhookData();
    const signature = signPayosWebhookData(data, TEST_CHECKSUM_KEY);
    const webhook: Webhook = {
      code: '00',
      desc: 'success',
      success: true,
      data,
      signature,
    };

    const verified = await client.verifyPaymentWebhookData(webhook);
    expect(verified).toEqual(data);

    const tamperedPayload: Webhook = {
      ...webhook,
      data: {
        ...data,
        amount: SAMPLE_AMOUNT + 1,
      },
    };
    await expect(client.verifyPaymentWebhookData(tamperedPayload)).rejects.toThrow('Invalid PayOS webhook signature');

    const invalidSignature: Webhook = {
      ...webhook,
      signature: '0'.repeat(signature.length),
    };
    await expect(client.verifyPaymentWebhookData(invalidSignature)).rejects.toThrow('Invalid PayOS webhook signature');
  });

  it('throws when orderCode is not found in Redis for getPaymentLinkInformation or cancelPaymentLink', async () => {
    const { redis } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    await expect(client.getPaymentLinkInformation(SAMPLE_ORDER_CODE)).rejects.toThrow(
      `Mock PayOS payment link not found for orderCode ${SAMPLE_ORDER_CODE}`,
    );
    await expect(client.cancelPaymentLink(SAMPLE_ORDER_CODE)).rejects.toThrow(
      `Mock PayOS payment link not found for orderCode ${SAMPLE_ORDER_CODE}`,
    );
  });

  it('keeps non-expired PENDING payment link as PENDING on getPaymentLinkInformation', async () => {
    const { redis } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    const expiredAt = Math.floor(Date.now() / MS_PER_SECOND) + FUTURE_OFFSET_SECONDS;
    await client.createPaymentLink({
      orderCode: SAMPLE_ORDER_CODE,
      amount: SAMPLE_AMOUNT,
      description: 'Active order',
      returnUrl: 'http://localhost:3000/return',
      cancelUrl: 'http://localhost:3000/cancel',
      expiredAt,
    });

    const info = await client.getPaymentLinkInformation(SAMPLE_ORDER_CODE);
    expect(info.status).toBe('PENDING');
  });

  it('does not overwrite status or metadata when cancelling a non-PENDING payment link', async () => {
    const { redis } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    await client.createPaymentLink({
      orderCode: SAMPLE_ORDER_CODE,
      amount: SAMPLE_AMOUNT,
      description: 'Already cancelled',
      returnUrl: 'http://localhost:3000/return',
      cancelUrl: 'http://localhost:3000/cancel',
    });

    const firstCancel = await client.cancelPaymentLink(SAMPLE_ORDER_CODE, 'First reason');
    const secondCancel = await client.cancelPaymentLink(SAMPLE_ORDER_CODE, 'Second reason');
    expect(secondCancel.status).toBe('CANCELLED');
    expect(secondCancel.cancellationReason).toBe('First reason');
    expect(secondCancel.canceledAt).toBe(firstCancel.canceledAt);

    const expiredOrderCode = SAMPLE_ORDER_CODE + 1;
    await client.createPaymentLink({
      orderCode: expiredOrderCode,
      amount: SAMPLE_AMOUNT,
      description: 'Already expired',
      returnUrl: 'http://localhost:3000/return',
      cancelUrl: 'http://localhost:3000/cancel',
      expiredAt: PAST_EXPIRED_AT,
    });
    await client.getPaymentLinkInformation(expiredOrderCode);

    const cancelExpired = await client.cancelPaymentLink(expiredOrderCode, 'Too late');
    expect(cancelExpired.status).toBe('EXPIRED');
    expect(cancelExpired.cancellationReason).toBeNull();
    expect(cancelExpired.canceledAt).toBeNull();
  });

  it('rejects webhook signatures with mismatched length without throwing RangeError', async () => {
    const { redis } = createInMemoryRedisStub();
    const client = new MockPayosClient({
      checksumKey: TEST_CHECKSUM_KEY,
      getRedisClient: async () => redis,
    });

    const data = buildWebhookData();
    const baseWebhook: Webhook = {
      code: '00',
      desc: 'success',
      success: true,
      data,
      signature: '',
    };

    await expect(client.verifyPaymentWebhookData(baseWebhook)).rejects.toThrow('Invalid PayOS webhook signature');
    await expect(
      client.verifyPaymentWebhookData({
        ...baseWebhook,
        signature: 'short-sig',
      }),
    ).rejects.toThrow('Invalid PayOS webhook signature');
  });
});

describe('createPayosClient', () => {
  it('returns MockPayosClient in mock mode, RealPayosClient in real mode, and throws when credentials are missing', () => {
    const originalEnv = {
      PAYOS_MOCK_MODE: env.PAYOS_MOCK_MODE,
      PAYOS_CLIENT_ID: env.PAYOS_CLIENT_ID,
      PAYOS_API_KEY: env.PAYOS_API_KEY,
    };

    try {
      env.PAYOS_MOCK_MODE = true;
      expect(createPayosClient()).toBeInstanceOf(MockPayosClient);

      env.PAYOS_MOCK_MODE = false;
      env.PAYOS_CLIENT_ID = undefined;
      env.PAYOS_API_KEY = undefined;
      expect(() => createPayosClient()).toThrow(
        'PAYOS_CLIENT_ID and PAYOS_API_KEY are required when PAYOS_MOCK_MODE is false',
      );

      env.PAYOS_CLIENT_ID = 'test-client-id';
      env.PAYOS_API_KEY = 'test-api-key';
      expect(createPayosClient()).toBeInstanceOf(RealPayosClient);
    } finally {
      env.PAYOS_MOCK_MODE = originalEnv.PAYOS_MOCK_MODE;
      env.PAYOS_CLIENT_ID = originalEnv.PAYOS_CLIENT_ID;
      env.PAYOS_API_KEY = originalEnv.PAYOS_API_KEY;
    }
  });
});
