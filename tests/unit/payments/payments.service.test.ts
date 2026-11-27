import type {
  CreatePaymentLinkResponse,
  PaymentLink,
} from '@payos/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PayosGatewayClient } from '../../../src/config/payos.js';
import type { OrderRecord } from '../../../src/models/order.model.js';
import type { PaymentRecord } from '../../../src/models/payment.model.js';
import type { OrdersService } from '../../../src/modules/orders/orders.service.js';
import {
  PAYMENT_CONFIG,
  PAYMENT_ERROR_MESSAGES,
  PAYMENT_REDIS_KEYS,
} from '../../../src/modules/payments/payments.constants.js';
import type {
  OwnedPaymentMeta,
  PaymentDbExecutor,
  PaymentsRepository,
} from '../../../src/modules/payments/payments.repository.js';
import {
  PaymentsService,
  type PaymentsRedisClient,
} from '../../../src/modules/payments/payments.service.js';
import { HTTP_STATUS } from '../../../src/shared/constants/http-status.js';
import { isHttpError } from '../../../src/shared/errors/http-error.js';
import { createHttpError } from '../../../src/shared/errors/http-error.js';

const USER_ID = '018f6e72-23b0-7e28-9f20-b42e77b4a1a3';
const ORDER_ID = '018f6e72-5555-7e28-9f20-b42e77b4a1b4';
const PAYMENT_ID = '018f6e72-7777-7e28-9f20-b42e77b4a1c6';
const ORDER_CODE = 1732690000123;

function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const now = new Date('2026-11-27T00:00:00.000Z');
  return {
    id: ORDER_ID,
    userId: USER_ID,
    amount: 50000,
    description: 'Order #1001',
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildPayment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  const now = new Date('2026-11-27T00:00:00.000Z');
  return {
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    orderCode: ORDER_CODE,
    paymentLinkId: 'mock-link-1',
    checkoutUrl: 'https://pay.payos.vn/web/mock-link-1',
    qrCode: '000201010212',
    amount: 50000,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 900_000),
    paidAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildCreateLinkResponse(
  overrides: Partial<CreatePaymentLinkResponse> = {},
): CreatePaymentLinkResponse {
  return {
    bin: '970422',
    accountNumber: '0000123456789',
    accountName: 'MOCK PAYOS ACCOUNT',
    amount: 50000,
    description: 'Order #1001',
    orderCode: ORDER_CODE,
    currency: 'VND',
    paymentLinkId: 'mock-link-1',
    status: 'PENDING',
    checkoutUrl: 'https://pay.payos.vn/web/mock-link-1',
    qrCode: '000201010212',
    ...overrides,
  };
}

function buildPaymentLink(overrides: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: 'mock-link-1',
    orderCode: ORDER_CODE,
    amount: 50000,
    amountPaid: 0,
    amountRemaining: 50000,
    status: 'PENDING',
    createdAt: '2026-11-27T00:00:00.000Z',
    transactions: [],
    cancellationReason: null,
    canceledAt: null,
    ...overrides,
  };
}

describe('PaymentsService', () => {
  const fakeTx = {} as PaymentDbExecutor;
  let mockRepo: Partial<PaymentsRepository>;
  let mockOrders: Partial<OrdersService>;
  let mockPayos: PayosGatewayClient;
  let mockRedis: PaymentsRedisClient;
  let redisAvailable: boolean;
  let service: PaymentsService;

  beforeEach(() => {
    redisAvailable = true;
    mockRepo = {
      runInTransaction: vi.fn(async (fn) => fn(fakeTx)),
      createPayment: vi.fn(),
      findById: vi.fn(),
      findByIdForUpdate: vi.fn(),
      findPendingByOrderId: vi.fn().mockResolvedValue(null),
      findOwnedPaymentMeta: vi.fn(),
      findOwnedById: vi.fn(),
      findManyByUserId: vi.fn(),
      updateStatusIfPending: vi.fn(),
    };
    mockOrders = {
      getOwnedOrderEntity: vi.fn().mockResolvedValue(buildOrder()),
      lockOwnedOrder: vi.fn().mockResolvedValue(buildOrder()),
      markOrderPaidIfPending: vi.fn().mockResolvedValue(buildOrder({ status: 'PAID' })),
    };
    mockPayos = {
      createPaymentLink: vi.fn().mockResolvedValue(buildCreateLinkResponse()),
      getPaymentLinkInformation: vi.fn().mockResolvedValue(buildPaymentLink()),
      cancelPaymentLink: vi.fn().mockResolvedValue(buildPaymentLink({ status: 'CANCELLED' })),
      verifyPaymentWebhookData: vi.fn(),
    };
    mockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
    };

    service = new PaymentsService({
      repository: mockRepo as PaymentsRepository,
      ordersService: mockOrders as OrdersService,
      getPayosClient: () => mockPayos,
      getRedisClient: async () => (redisAvailable ? mockRedis : undefined),
    });
  });

  describe('preparePaymentCreation / commitPaymentCreation / compensatePaymentCreation', () => {
    it('prepares payment with Redis lock, commits inside transaction, and releases lock in finally', async () => {
      const created = buildPayment();
      mockRepo.createPayment = vi.fn().mockResolvedValue(created);

      const prepared = await service.preparePaymentCreation(USER_ID, {
        orderId: ORDER_ID,
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        `${PAYMENT_REDIS_KEYS.ORDER_LOCK_PREFIX}${ORDER_ID}`,
        expect.any(String),
        { NX: true, PX: PAYMENT_CONFIG.ORDER_LOCK_TTL_MS },
      );
      expect(mockPayos.createPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 50000,
          description: 'Order #1001',
        }),
      );
      expect(mockRedis.eval).not.toHaveBeenCalled();

      const dto = await service.commitPaymentCreation(prepared, fakeTx);

      expect(mockOrders.lockOwnedOrder).toHaveBeenCalledWith(USER_ID, ORDER_ID, fakeTx);
      expect(mockRepo.createPayment).toHaveBeenCalledTimes(1);
      expect(dto.id).toBe(PAYMENT_ID);
      expect(dto.status).toBe('PENDING');
      expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), {
        keys: [`${PAYMENT_REDIS_KEYS.ORDER_LOCK_PREFIX}${ORDER_ID}`],
        arguments: [prepared.lockToken],
      });
    });

    it('throws 404 without acquiring Redis lock or calling PayOS when order is missing or unowned', async () => {
      mockOrders.getOwnedOrderEntity = vi
        .fn()
        .mockRejectedValue(createHttpError(HTTP_STATUS.HTTP_404_NOT_FOUND, 'Order not found'));

      await expect(
        service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) && err.statusCode === HTTP_STATUS.HTTP_404_NOT_FOUND,
      );

      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockPayos.createPaymentLink).not.toHaveBeenCalled();
    });

    it.each(['PAID', 'CANCELLED'] as const)(
      'throws 409 without acquiring Redis lock or calling PayOS when order is %s',
      async (status) => {
        mockOrders.getOwnedOrderEntity = vi
          .fn()
          .mockResolvedValue(buildOrder({ status }));

        await expect(
          service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID }),
        ).rejects.toSatisfy(
          (err: unknown) =>
            isHttpError(err) &&
            err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
            err.message === PAYMENT_ERROR_MESSAGES.ORDER_NOT_PENDING,
        );

        expect(mockRedis.set).not.toHaveBeenCalled();
        expect(mockPayos.createPaymentLink).not.toHaveBeenCalled();
      },
    );

    it('throws 409 when active PENDING payment already exists', async () => {
      mockRepo.findPendingByOrderId = vi
        .fn()
        .mockResolvedValue(buildPayment({ expiresAt: new Date(Date.now() + 60_000) }));

      await expect(
        service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ACTIVE_PAYMENT_EXISTS,
      );

      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockPayos.createPaymentLink).not.toHaveBeenCalled();
    });

    it('throws 409 when expired PENDING payment is still in DB (instructs sync)', async () => {
      mockRepo.findPendingByOrderId = vi
        .fn()
        .mockResolvedValue(buildPayment({ expiresAt: new Date(Date.now() - 60_000) }));

      await expect(
        service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ACTIVE_PAYMENT_EXISTS,
      );

      expect(mockPayos.createPaymentLink).not.toHaveBeenCalled();
    });

    it('throws 409 on Redis lock contention without calling PayOS or deleting foreign lock', async () => {
      mockRedis.set = vi.fn().mockResolvedValue(null);

      await expect(
        service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ORDER_PAYMENT_IN_PROGRESS,
      );

      expect(mockPayos.createPaymentLink).not.toHaveBeenCalled();
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('falls back cleanly when Redis is unavailable', async () => {
      redisAvailable = false;
      mockRepo.createPayment = vi.fn().mockResolvedValue(buildPayment());

      const prepared = await service.preparePaymentCreation(USER_ID, {
        orderId: ORDER_ID,
      });
      const dto = await service.commitPaymentCreation(prepared);

      expect(prepared.lockKey).toBeNull();
      expect(prepared.lockToken).toBeNull();
      expect(dto.id).toBe(PAYMENT_ID);
    });

    it('falls back cleanly when Redis connection or SET throws', async () => {
      mockRedis.set = vi.fn().mockRejectedValue(new Error('Redis connection lost'));
      mockRepo.createPayment = vi.fn().mockResolvedValue(buildPayment());

      const prepared = await service.preparePaymentCreation(USER_ID, {
        orderId: ORDER_ID,
      });
      const dto = await service.commitPaymentCreation(prepared);

      expect(prepared.lockToken).toBeNull();
      expect(dto.id).toBe(PAYMENT_ID);
    });

    it('releases Redis lock and rethrows when PayOS createPaymentLink fails', async () => {
      const payosError = new Error('PayOS upstream timeout');
      mockPayos.createPaymentLink = vi.fn().mockRejectedValue(payosError);

      await expect(
        service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID }),
      ).rejects.toThrow(payosError);

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    });

    it('clamps description to 25 chars and falls back to default when whitespace-only', async () => {
      mockOrders.getOwnedOrderEntity = vi
        .fn()
        .mockResolvedValueOnce(
          buildOrder({ description: '   Very long description exceeding twenty five chars   ' }),
        )
        .mockResolvedValueOnce(buildOrder({ description: '    ' }));

      await service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID });
      expect(mockPayos.createPaymentLink).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          description: 'Very long description exc',
        }),
      );

      await service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID });
      expect(mockPayos.createPaymentLink).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          description: PAYMENT_CONFIG.DEFAULT_PAYOS_DESCRIPTION,
        }),
      );
    });

    it('maps PostgreSQL 23505 unique violation in commitPaymentCreation to 409 and releases lock', async () => {
      const prepared = await service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID });
      const pgUniqueError = Object.assign(new Error('duplicate key'), { code: '23505' });
      mockRepo.createPayment = vi.fn().mockRejectedValue(pgUniqueError);

      await expect(service.commitPaymentCreation(prepared, fakeTx)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ACTIVE_PAYMENT_EXISTS,
      );

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    });

    it('throws 409 in commitPaymentCreation if order transitioned out of PENDING before lock', async () => {
      const prepared = await service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID });
      mockOrders.lockOwnedOrder = vi
        .fn()
        .mockResolvedValue(buildOrder({ status: 'CANCELLED' }));

      await expect(service.commitPaymentCreation(prepared, fakeTx)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ORDER_NOT_PENDING,
      );

      expect(mockRepo.createPayment).not.toHaveBeenCalled();
      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    });

    it('compensates by cancelling PayOS link and releasing Redis lock even if cancel fails', async () => {
      const prepared = await service.preparePaymentCreation(USER_ID, { orderId: ORDER_ID });
      mockPayos.cancelPaymentLink = vi
        .fn()
        .mockRejectedValue(new Error('PayOS cancel failed'));

      await expect(service.compensatePaymentCreation(prepared)).resolves.toBeUndefined();

      expect(mockPayos.cancelPaymentLink).toHaveBeenCalledWith(
        prepared.orderCode,
        'Payment creation rolled back',
      );
      expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), {
        keys: [prepared.lockKey],
        arguments: [prepared.lockToken],
      });
    });
  });

  describe('getPaymentById / listPayments', () => {
    it('returns mapped PaymentDTO and throws 404 when not found', async () => {
      const paidAt = new Date('2026-11-27T01:00:00.000Z');
      mockRepo.findOwnedById = vi
        .fn()
        .mockResolvedValueOnce(buildPayment({ status: 'PAID', paidAt }))
        .mockResolvedValueOnce(null);

      const dto = await service.getPaymentById(USER_ID, PAYMENT_ID);
      expect(dto.status).toBe('PAID');
      expect(dto.paidAt).toBe(paidAt.toISOString());
      expect(dto.cancelledAt).toBeNull();

      await expect(service.getPaymentById(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) && err.statusCode === HTTP_STATUS.HTTP_404_NOT_FOUND,
      );
    });

    it('lists paginated payments with optional filters and totalPages 0 when empty', async () => {
      mockRepo.findManyByUserId = vi
        .fn()
        .mockResolvedValue({ items: [], total: 0 });

      const result = await service.listPayments(USER_ID, {
        page: 1,
        limit: 20,
        orderId: ORDER_ID,
        status: 'PENDING',
      });

      expect(mockRepo.findManyByUserId).toHaveBeenCalledWith(USER_ID, {
        page: 1,
        limit: 20,
        orderId: ORDER_ID,
        status: 'PENDING',
      });
      expect(result).toEqual({
        items: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });
  });

  describe('syncPayment', () => {
    const pendingMeta: OwnedPaymentMeta = {
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      orderCode: ORDER_CODE,
      status: 'PENDING',
      orderStatus: 'PENDING',
    };

    it('throws 404 without calling PayOS when payment is missing or unowned', async () => {
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(null);

      await expect(service.syncPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) && err.statusCode === HTTP_STATUS.HTTP_404_NOT_FOUND,
      );

      expect(mockPayos.getPaymentLinkInformation).not.toHaveBeenCalled();
    });

    it.each(['PAID', 'CANCELLED', 'EXPIRED'] as const)(
      'returns DB record immediately without calling PayOS when payment is already %s',
      async (status) => {
        mockRepo.findOwnedPaymentMeta = vi
          .fn()
          .mockResolvedValue({ ...pendingMeta, status });
        mockRepo.findOwnedById = vi
          .fn()
          .mockResolvedValue(buildPayment({ status }));

        const result = await service.syncPayment(USER_ID, PAYMENT_ID);

        expect(result.status).toBe(status);
        expect(mockPayos.getPaymentLinkInformation).not.toHaveBeenCalled();
      },
    );

    it('marks payment and order PAID inside canonical orders -> payments lock order', async () => {
      const paidPayment = buildPayment({ status: 'PAID', paidAt: new Date() });
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockPayos.getPaymentLinkInformation = vi
        .fn()
        .mockResolvedValue(buildPaymentLink({ status: 'PAID' }));
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(buildPayment());
      mockRepo.updateStatusIfPending = vi.fn().mockResolvedValue(paidPayment);

      const result = await service.syncPayment(USER_ID, PAYMENT_ID);

      expect(mockOrders.lockOwnedOrder).toHaveBeenCalledWith(USER_ID, ORDER_ID, fakeTx);
      expect(mockRepo.findByIdForUpdate).toHaveBeenCalledWith(PAYMENT_ID, fakeTx);
      expect(mockRepo.updateStatusIfPending).toHaveBeenCalledWith(
        PAYMENT_ID,
        expect.objectContaining({ status: 'PAID', paidAt: expect.any(Date) }),
        fakeTx,
      );
      expect(mockOrders.markOrderPaidIfPending).toHaveBeenCalledWith(ORDER_ID, fakeTx);
      expect(result.status).toBe('PAID');
    });

    it('returns existing PAID DTO idempotently when webhook transitioned row before lock', async () => {
      const alreadyPaid = buildPayment({ status: 'PAID', paidAt: new Date() });
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockPayos.getPaymentLinkInformation = vi
        .fn()
        .mockResolvedValue(buildPaymentLink({ status: 'PAID' }));
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(alreadyPaid);

      const result = await service.syncPayment(USER_ID, PAYMENT_ID);

      expect(result.status).toBe('PAID');
      expect(mockRepo.updateStatusIfPending).not.toHaveBeenCalled();
      expect(mockOrders.markOrderPaidIfPending).not.toHaveBeenCalled();
    });

    it('marks payment CANCELLED without marking order PAID when PayOS is CANCELLED', async () => {
      const cancelled = buildPayment({ status: 'CANCELLED', cancelledAt: new Date() });
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockPayos.getPaymentLinkInformation = vi
        .fn()
        .mockResolvedValue(buildPaymentLink({ status: 'CANCELLED' }));
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(buildPayment());
      mockRepo.updateStatusIfPending = vi.fn().mockResolvedValue(cancelled);

      const result = await service.syncPayment(USER_ID, PAYMENT_ID);

      expect(result.status).toBe('CANCELLED');
      expect(mockOrders.markOrderPaidIfPending).not.toHaveBeenCalled();
    });

    it('marks payment EXPIRED without marking order PAID when PayOS is EXPIRED', async () => {
      const expired = buildPayment({ status: 'EXPIRED' });
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockPayos.getPaymentLinkInformation = vi
        .fn()
        .mockResolvedValue(buildPaymentLink({ status: 'EXPIRED' }));
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(buildPayment());
      mockRepo.updateStatusIfPending = vi.fn().mockResolvedValue(expired);

      const result = await service.syncPayment(USER_ID, PAYMENT_ID);

      expect(result.status).toBe('EXPIRED');
      expect(mockOrders.markOrderPaidIfPending).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'UNDERPAID', 'PROCESSING'] as const)(
      'leaves DB untouched when PayOS returns %s',
      async (nonTerminalStatus) => {
        mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
        mockPayos.getPaymentLinkInformation = vi
          .fn()
          .mockResolvedValue(buildPaymentLink({ status: nonTerminalStatus }));
        mockRepo.findOwnedById = vi.fn().mockResolvedValue(buildPayment());

        const result = await service.syncPayment(USER_ID, PAYMENT_ID);

        expect(result.status).toBe('PENDING');
        expect(mockRepo.runInTransaction).not.toHaveBeenCalled();
      },
    );

    it('propagates PayOS error without mutating DB', async () => {
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockPayos.getPaymentLinkInformation = vi
        .fn()
        .mockRejectedValue(new Error('PayOS down'));

      await expect(service.syncPayment(USER_ID, PAYMENT_ID)).rejects.toThrow('PayOS down');
      expect(mockRepo.runInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('cancelPayment', () => {
    const pendingMeta: OwnedPaymentMeta = {
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      orderCode: ORDER_CODE,
      status: 'PENDING',
      orderStatus: 'PENDING',
    };

    it('throws 404 without calling PayOS when payment is missing or unowned', async () => {
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(null);

      await expect(service.cancelPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) && err.statusCode === HTTP_STATUS.HTTP_404_NOT_FOUND,
      );

      expect(mockPayos.cancelPaymentLink).not.toHaveBeenCalled();
    });

    it.each(['PAID', 'CANCELLED', 'EXPIRED'] as const)(
      'throws 409 without calling PayOS when payment is already %s',
      async (status) => {
        mockRepo.findOwnedPaymentMeta = vi
          .fn()
          .mockResolvedValue({ ...pendingMeta, status });

        await expect(service.cancelPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
          (err: unknown) =>
            isHttpError(err) && err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT,
        );

        expect(mockPayos.cancelPaymentLink).not.toHaveBeenCalled();
      },
    );

    it('throws 409 ORDER_ALREADY_PAID without calling PayOS when order is already PAID', async () => {
      mockRepo.findOwnedPaymentMeta = vi
        .fn()
        .mockResolvedValue({ ...pendingMeta, orderStatus: 'PAID' });

      await expect(service.cancelPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ORDER_ALREADY_PAID,
      );

      expect(mockPayos.cancelPaymentLink).not.toHaveBeenCalled();
    });

    it('cancels PayOS link, marks payment CANCELLED, and leaves order PENDING', async () => {
      const cancelled = buildPayment({ status: 'CANCELLED', cancelledAt: new Date() });
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(buildPayment());
      mockRepo.updateStatusIfPending = vi.fn().mockResolvedValue(cancelled);

      const result = await service.cancelPayment(USER_ID, PAYMENT_ID, {
        reason: 'User changed mind',
      });

      expect(mockPayos.cancelPaymentLink).toHaveBeenCalledWith(
        ORDER_CODE,
        'User changed mind',
      );
      expect(mockOrders.lockOwnedOrder).toHaveBeenCalledWith(USER_ID, ORDER_ID, fakeTx);
      expect(mockRepo.findByIdForUpdate).toHaveBeenCalledWith(PAYMENT_ID, fakeTx);
      expect(mockOrders.markOrderPaidIfPending).not.toHaveBeenCalled();
      expect(result.status).toBe('CANCELLED');
    });

    it('reconciles DB to PAID and throws 409 when PayOS returns PAID during cancel', async () => {
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockPayos.cancelPaymentLink = vi
        .fn()
        .mockResolvedValue(buildPaymentLink({ status: 'PAID' }));
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(buildPayment());
      mockRepo.updateStatusIfPending = vi
        .fn()
        .mockResolvedValue(buildPayment({ status: 'PAID', paidAt: new Date() }));

      await expect(service.cancelPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ORDER_ALREADY_PAID,
      );

      expect(mockRepo.updateStatusIfPending).toHaveBeenCalledWith(
        PAYMENT_ID,
        expect.objectContaining({ status: 'PAID', paidAt: expect.any(Date) }),
        fakeTx,
      );
      expect(mockOrders.markOrderPaidIfPending).toHaveBeenCalledWith(ORDER_ID, fakeTx);
    });

    it('aborts cancel with 409 when webhook marked order PAID before lock', async () => {
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockOrders.lockOwnedOrder = vi
        .fn()
        .mockResolvedValue(buildOrder({ status: 'PAID' }));
      mockRepo.findByIdForUpdate = vi
        .fn()
        .mockResolvedValue(buildPayment({ status: 'PAID' }));

      await expect(service.cancelPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.ORDER_ALREADY_PAID,
      );

      expect(mockRepo.updateStatusIfPending).not.toHaveBeenCalled();
    });

    it('reconciles DB to EXPIRED and throws 409 when PayOS returns EXPIRED during cancel', async () => {
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockPayos.cancelPaymentLink = vi
        .fn()
        .mockResolvedValue(buildPaymentLink({ status: 'EXPIRED' }));
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(buildPayment());
      mockRepo.updateStatusIfPending = vi
        .fn()
        .mockResolvedValue(buildPayment({ status: 'EXPIRED' }));

      await expect(service.cancelPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.NOT_PENDING_TO_CANCEL,
      );

      expect(mockRepo.updateStatusIfPending).toHaveBeenCalledWith(
        PAYMENT_ID,
        { status: 'EXPIRED' },
        fakeTx,
      );
    });

    it('throws 409 when concurrent cancel already moved payment to CANCELLED', async () => {
      mockRepo.findOwnedPaymentMeta = vi.fn().mockResolvedValue(pendingMeta);
      mockRepo.findByIdForUpdate = vi.fn().mockResolvedValue(buildPayment());
      mockRepo.updateStatusIfPending = vi.fn().mockResolvedValue(null);

      await expect(service.cancelPayment(USER_ID, PAYMENT_ID)).rejects.toSatisfy(
        (err: unknown) =>
          isHttpError(err) &&
          err.statusCode === HTTP_STATUS.HTTP_409_CONFLICT &&
          err.message === PAYMENT_ERROR_MESSAGES.NOT_PENDING_TO_CANCEL,
      );
    });
  });
});
