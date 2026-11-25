import crypto from 'node:crypto';

import {
  PayOS,
  type CreatePaymentLinkRequest,
  type CreatePaymentLinkResponse,
  type PaymentLink,
  type Webhook,
  type WebhookData,
} from '@payos/node';

import { TIME_MS, TIME_SECONDS } from '../shared/constants/time.js';
import { env } from './env.js';
import { requireRedis } from './redis.js';

const MOCK_PAYOS_KEY_PREFIX = 'mock:payos:payment:';
const MOCK_PAYOS_BIN = '970422';
const MOCK_PAYOS_ACCOUNT_NUMBER = '0000123456789';
const MOCK_PAYOS_ACCOUNT_NAME = 'MOCK PAYOS ACCOUNT';
const CURRENCY_VND = 'VND';
const AMOUNT_ZERO = 0;

export interface MockRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
}

export interface PayosGatewayClient {
  createPaymentLink(input: CreatePaymentLinkRequest): Promise<CreatePaymentLinkResponse>;
  getPaymentLinkInformation(orderCode: number): Promise<PaymentLink>;
  cancelPaymentLink(orderCode: number, cancellationReason?: string): Promise<PaymentLink>;
  verifyPaymentWebhookData(webhookBody: Webhook): Promise<WebhookData>;
}

interface MockStoredPayment {
  id: string;
  orderCode: number;
  amount: number;
  description: string;
  status: PaymentLink['status'];
  createdAt: string;
  expiredAt?: number;
  cancellationReason: string | null;
  canceledAt: string | null;
}

function buildMockKey(orderCode: number): string {
  return `${MOCK_PAYOS_KEY_PREFIX}${orderCode}`;
}

function serializeWebhookValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value) || typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Generates an HMAC-SHA256 signature for PayOS webhook `data` using the checksum key.
 * Keys are sorted alphabetically and joined as `key=value` pairs before signing.
 */
export function signPayosWebhookData(data: WebhookData, checksumKey: string): string {
  const entries = Object.entries(data as Record<string, unknown>);
  entries.sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

  const queryString = entries.map(([key, value]) => `${key}=${serializeWebhookValue(value)}`).join('&');
  return crypto.createHmac('sha256', checksumKey).update(queryString).digest('hex');
}

/**
 * Verifies a PayOS webhook payload signature in constant time.
 */
function verifyPayosWebhookSignature(webhookBody: Webhook, checksumKey: string): WebhookData {
  const expectedSignature = signPayosWebhookData(webhookBody.data, checksumKey);
  const actualBuffer = Buffer.from(webhookBody.signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('Invalid PayOS webhook signature');
  }

  return webhookBody.data;
}

function toPaymentLink(record: MockStoredPayment): PaymentLink {
  const isPaid = record.status === 'PAID';
  return {
    id: record.id,
    orderCode: record.orderCode,
    amount: record.amount,
    amountPaid: isPaid ? record.amount : AMOUNT_ZERO,
    amountRemaining: isPaid ? AMOUNT_ZERO : record.amount,
    status: record.status,
    createdAt: record.createdAt,
    transactions: [],
    cancellationReason: record.cancellationReason,
    canceledAt: record.canceledAt,
  };
}

export class RealPayosClient implements PayosGatewayClient {
  private readonly client: PayOS;

  constructor(options: { clientId: string; apiKey: string; checksumKey: string }) {
    this.client = new PayOS({
      clientId: options.clientId,
      apiKey: options.apiKey,
      checksumKey: options.checksumKey,
    });
  }

  async createPaymentLink(input: CreatePaymentLinkRequest): Promise<CreatePaymentLinkResponse> {
    return this.client.paymentRequests.create(input);
  }

  async getPaymentLinkInformation(orderCode: number): Promise<PaymentLink> {
    return this.client.paymentRequests.get(orderCode);
  }

  async cancelPaymentLink(orderCode: number, cancellationReason?: string): Promise<PaymentLink> {
    return this.client.paymentRequests.cancel(orderCode, cancellationReason);
  }

  async verifyPaymentWebhookData(webhookBody: Webhook): Promise<WebhookData> {
    return this.client.webhooks.verify(webhookBody);
  }
}

export interface MockPayosClientOptions {
  checksumKey: string;
  getRedisClient?: () => Promise<MockRedisClient>;
}

/**
 * Redis-backed mock PayOS client.
 * Never falls back to in-memory storage; every operation requires an active Redis connection.
 */
export class MockPayosClient implements PayosGatewayClient {
  private readonly checksumKey: string;
  private readonly getRedisClient: () => Promise<MockRedisClient>;

  constructor(options: MockPayosClientOptions) {
    this.checksumKey = options.checksumKey;
    this.getRedisClient = options.getRedisClient ?? requireRedis;
  }

  async createPaymentLink(input: CreatePaymentLinkRequest): Promise<CreatePaymentLinkResponse> {
    const redis = await this.getRedisClient();
    const paymentLinkId = `mock-pl-${input.orderCode}`;
    const record: MockStoredPayment = {
      id: paymentLinkId,
      orderCode: input.orderCode,
      amount: input.amount,
      description: input.description,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      ...(input.expiredAt !== undefined ? { expiredAt: input.expiredAt } : {}),
      cancellationReason: null,
      canceledAt: null,
    };

    await redis.set(buildMockKey(input.orderCode), JSON.stringify(record), { EX: TIME_SECONDS.ONE_DAY });

    return {
      bin: MOCK_PAYOS_BIN,
      accountNumber: MOCK_PAYOS_ACCOUNT_NUMBER,
      accountName: MOCK_PAYOS_ACCOUNT_NAME,
      amount: input.amount,
      description: input.description,
      orderCode: input.orderCode,
      currency: CURRENCY_VND,
      paymentLinkId,
      status: 'PENDING',
      ...(input.expiredAt !== undefined ? { expiredAt: input.expiredAt } : {}),
      checkoutUrl: `https://mock.payos.vn/web/${paymentLinkId}`,
      qrCode: `000201010212MOCKPAYOS${input.orderCode}`,
    };
  }

  async getPaymentLinkInformation(orderCode: number): Promise<PaymentLink> {
    const redis = await this.getRedisClient();
    const key = buildMockKey(orderCode);
    const raw = await redis.get(key);

    if (!raw) {
      throw new Error(`Mock PayOS payment link not found for orderCode ${orderCode}`);
    }

    const record = JSON.parse(raw) as MockStoredPayment;
    const nowSeconds = Math.floor(Date.now() / TIME_MS.ONE_SECOND);

    if (record.status === 'PENDING' && record.expiredAt !== undefined && record.expiredAt < nowSeconds) {
      record.status = 'EXPIRED';
      await redis.set(key, JSON.stringify(record), { EX: TIME_SECONDS.ONE_DAY });
    }

    return toPaymentLink(record);
  }

  async cancelPaymentLink(orderCode: number, cancellationReason?: string): Promise<PaymentLink> {
    const redis = await this.getRedisClient();
    const key = buildMockKey(orderCode);
    const raw = await redis.get(key);

    if (!raw) {
      throw new Error(`Mock PayOS payment link not found for orderCode ${orderCode}`);
    }

    const record = JSON.parse(raw) as MockStoredPayment;

    if (record.status === 'PENDING') {
      record.status = 'CANCELLED';
      record.cancellationReason = cancellationReason ?? null;
      record.canceledAt = new Date().toISOString();
      await redis.set(key, JSON.stringify(record), { EX: TIME_SECONDS.ONE_DAY });
    }

    return toPaymentLink(record);
  }

  async verifyPaymentWebhookData(webhookBody: Webhook): Promise<WebhookData> {
    return verifyPayosWebhookSignature(webhookBody, this.checksumKey);
  }
}

export function createPayosClient(): PayosGatewayClient {
  if (env.PAYOS_MOCK_MODE) {
    return new MockPayosClient({
      checksumKey: env.PAYOS_CHECKSUM_KEY,
    });
  }

  if (!env.PAYOS_CLIENT_ID || !env.PAYOS_API_KEY) {
    throw new Error('PAYOS_CLIENT_ID and PAYOS_API_KEY are required when PAYOS_MOCK_MODE is false');
  }

  return new RealPayosClient({
    clientId: env.PAYOS_CLIENT_ID,
    apiKey: env.PAYOS_API_KEY,
    checksumKey: env.PAYOS_CHECKSUM_KEY,
  });
}

let cachedPayosClient: PayosGatewayClient | undefined;

export function getPayosClient(): PayosGatewayClient {
  cachedPayosClient ??= createPayosClient();
  return cachedPayosClient;
}
