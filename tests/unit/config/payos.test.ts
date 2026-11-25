import { describe, expect, it, vi } from 'vitest';
import type { Webhook, WebhookData } from '@payos/node';

import {
  MockPayosClient,
  signPayosWebhookData,
  type MockRedisClient,
} from '../../../src/config/payos.js';
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
});
