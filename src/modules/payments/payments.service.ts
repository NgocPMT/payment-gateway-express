import crypto from 'node:crypto';
import type { PaymentLink } from '@payos/node';

import { env } from '../../config/env.js';
import { getPayosClient, type PayosGatewayClient } from '../../config/payos.js';
import { getRedis } from '../../config/redis.js';
import type { PaymentRecord } from '../../models/payment.model.js';
import { HTTP_STATUS } from '../../shared/constants/http-status.js';
import { TIME_MS } from '../../shared/constants/time.js';
import { createHttpError } from '../../shared/errors/http-error.js';
import { buildPaginationMeta } from '../../shared/schemas/pagination.schema.js';
import { ordersService, type OrdersService } from '../orders/orders.service.js';
import {
  PAYMENT_CONFIG,
  PAYMENT_ERROR_MESSAGES,
  PAYMENT_REDIS_KEYS,
} from './payments.constants.js';
import {
  paymentsRepository,
  type FindPaymentsByUserOptions,
  type PaymentDbExecutor,
  type PaymentsRepository,
} from './payments.repository.js';
import type {
  CancelPaymentRequest,
  CreatePaymentRequest,
  ListPaymentsQuery,
  PaginatedPaymentsResponse,
  PaymentDTO,
} from './payments.schemas.js';

const PG_UNIQUE_VIOLATION_CODE = '23505';
const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export interface PaymentsRedisClient {
  set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface PreparedPaymentCreation {
  userId: string;
  orderId: string;
  orderCode: number;
  paymentLinkId: string;
  checkoutUrl: string;
  qrCode: string;
  amount: number;
  expiresAt: Date;
  lockKey: string | null;
  lockToken: string | null;
}

export interface PaymentsServiceDeps {
  repository?: PaymentsRepository;
  ordersService?: OrdersService;
  getPayosClient?: () => PayosGatewayClient;
  getRedisClient?: () => Promise<PaymentsRedisClient | undefined>;
}

function clampPayosDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) {
    return PAYMENT_CONFIG.DEFAULT_PAYOS_DESCRIPTION;
  }
  return trimmed.slice(0, PAYMENT_CONFIG.PAYOS_DESCRIPTION_MAX_LENGTH);
}

function generateOrderCode(): number {
  const randomSuffix = crypto.randomInt(0, PAYMENT_CONFIG.ORDER_CODE_RANDOM_RANGE);
  return Date.now() * PAYMENT_CONFIG.ORDER_CODE_RANDOM_RANGE + randomSuffix;
}

function isPgUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const pgCode = (error as { code?: unknown }).code;
  return pgCode === PG_UNIQUE_VIOLATION_CODE;
}

export class PaymentsService {
  private readonly repository: PaymentsRepository;
  private readonly orders: OrdersService;
  private readonly getPayos: () => PayosGatewayClient;
  private readonly getRedisClient: () => Promise<PaymentsRedisClient | undefined>;

  constructor(deps: PaymentsServiceDeps = {}) {
    this.repository = deps.repository ?? paymentsRepository;
    this.orders = deps.ordersService ?? ordersService;
    this.getPayos = deps.getPayosClient ?? getPayosClient;
    this.getRedisClient =
      deps.getRedisClient ??
      (async (): Promise<PaymentsRedisClient | undefined> => {
        const client = await getRedis();
        return client as PaymentsRedisClient | undefined;
      });
  }

  mapPaymentDto(payment: PaymentRecord): PaymentDTO {
    return {
      id: payment.id,
      orderId: payment.orderId,
      orderCode: payment.orderCode,
      paymentLinkId: payment.paymentLinkId,
      checkoutUrl: payment.checkoutUrl,
      qrCode: payment.qrCode,
      amount: payment.amount,
      status: payment.status,
      expiresAt: payment.expiresAt.toISOString(),
      paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
      cancelledAt: payment.cancelledAt ? payment.cancelledAt.toISOString() : null,
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    };
  }

  async preparePaymentCreation(
    userId: string,
    input: CreatePaymentRequest,
  ): Promise<PreparedPaymentCreation> {
    const order = await this.orders.getOwnedOrderEntity(userId, input.orderId);
    if (order.status !== 'PENDING') {
      throw createHttpError(
        HTTP_STATUS.HTTP_409_CONFLICT,
        PAYMENT_ERROR_MESSAGES.ORDER_NOT_PENDING,
      );
    }

    const existingPending = await this.repository.findPendingByOrderId(order.id);
    if (existingPending) {
      throw createHttpError(
        HTTP_STATUS.HTTP_409_CONFLICT,
        PAYMENT_ERROR_MESSAGES.ACTIVE_PAYMENT_EXISTS,
      );
    }

    const { lockKey, lockToken } = await this.tryAcquireOrderLock(order.id);

    const expiresInSeconds =
      input.expiresInSeconds ?? PAYMENT_CONFIG.DEFAULT_EXPIRES_IN_SECONDS;
    const expiredAtSeconds = Math.floor(Date.now() / TIME_MS.ONE_SECOND) + expiresInSeconds;
    const expiresAt = new Date(expiredAtSeconds * TIME_MS.ONE_SECOND);
    const orderCode = generateOrderCode();

    try {
      const payosLink = await this.getPayos().createPaymentLink({
        orderCode,
        amount: order.amount,
        description: clampPayosDescription(order.description),
        returnUrl: env.PAYOS_RETURN_URL,
        cancelUrl: env.PAYOS_CANCEL_URL,
        expiredAt: expiredAtSeconds,
      });

      return {
        userId,
        orderId: order.id,
        orderCode: payosLink.orderCode,
        paymentLinkId: payosLink.paymentLinkId,
        checkoutUrl: payosLink.checkoutUrl,
        qrCode: payosLink.qrCode,
        amount: order.amount,
        expiresAt,
        lockKey,
        lockToken,
      };
    } catch (error) {
      await this.releaseOrderLock(lockKey, lockToken);
      throw error;
    }
  }

  async commitPaymentCreation(
    prepared: PreparedPaymentCreation,
    tx?: PaymentDbExecutor,
  ): Promise<PaymentDTO> {
    const persist = async (executor: PaymentDbExecutor): Promise<PaymentDTO> => {
      const lockedOrder = await this.orders.lockOwnedOrder(
        prepared.userId,
        prepared.orderId,
        executor,
      );
      if (lockedOrder.status !== 'PENDING') {
        throw createHttpError(
          HTTP_STATUS.HTTP_409_CONFLICT,
          PAYMENT_ERROR_MESSAGES.ORDER_NOT_PENDING,
        );
      }

      try {
        const payment = await this.repository.createPayment(
          {
            orderId: prepared.orderId,
            orderCode: prepared.orderCode,
            paymentLinkId: prepared.paymentLinkId,
            checkoutUrl: prepared.checkoutUrl,
            qrCode: prepared.qrCode,
            amount: prepared.amount,
            expiresAt: prepared.expiresAt,
          },
          executor,
        );
        return this.mapPaymentDto(payment);
      } catch (error) {
        if (isPgUniqueViolation(error)) {
          throw createHttpError(
            HTTP_STATUS.HTTP_409_CONFLICT,
            PAYMENT_ERROR_MESSAGES.ACTIVE_PAYMENT_EXISTS,
          );
        }
        throw error;
      }
    };

    try {
      if (tx) {
        return await persist(tx);
      }
      return await this.repository.runInTransaction(persist);
    } finally {
      await this.releaseOrderLock(prepared.lockKey, prepared.lockToken);
    }
  }

  async compensatePaymentCreation(prepared: PreparedPaymentCreation): Promise<void> {
    try {
      await this.getPayos().cancelPaymentLink(
        prepared.orderCode,
        'Payment creation rolled back',
      );
    } catch {
      // Best-effort compensation must not mask the original persistence error.
    } finally {
      await this.releaseOrderLock(prepared.lockKey, prepared.lockToken);
    }
  }

  async getPaymentById(userId: string, paymentId: string): Promise<PaymentDTO> {
    const payment = await this.repository.findOwnedById(paymentId, userId);
    if (!payment) {
      throw createHttpError(HTTP_STATUS.HTTP_404_NOT_FOUND, PAYMENT_ERROR_MESSAGES.NOT_FOUND);
    }
    return this.mapPaymentDto(payment);
  }

  async listPayments(
    userId: string,
    query: ListPaymentsQuery,
  ): Promise<PaginatedPaymentsResponse> {
    const options: FindPaymentsByUserOptions = {
      page: query.page,
      limit: query.limit,
    };
    if (query.orderId !== undefined) {
      options.orderId = query.orderId;
    }
    if (query.status !== undefined) {
      options.status = query.status;
    }

    const { items, total } = await this.repository.findManyByUserId(userId, options);
    return {
      items: items.map((payment) => this.mapPaymentDto(payment)),
      meta: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  async syncPayment(userId: string, paymentId: string): Promise<PaymentDTO> {
    const meta = await this.repository.findOwnedPaymentMeta(paymentId, userId);
    if (!meta) {
      throw createHttpError(HTTP_STATUS.HTTP_404_NOT_FOUND, PAYMENT_ERROR_MESSAGES.NOT_FOUND);
    }

    if (meta.status !== 'PENDING') {
      return this.getPaymentById(userId, paymentId);
    }

    const payosLink = await this.getPayos().getPaymentLinkInformation(meta.orderCode);
    if (
      payosLink.status !== 'PAID' &&
      payosLink.status !== 'CANCELLED' &&
      payosLink.status !== 'EXPIRED'
    ) {
      return this.getPaymentById(userId, paymentId);
    }

    const targetStatus = payosLink.status;
    return this.repository.runInTransaction(async (tx) => {
      // Canonical lock order: orders -> payments to prevent deadlocks with webhooks/cancel.
      await this.orders.lockOwnedOrder(userId, meta.orderId, tx);
      const lockedPayment = await this.repository.findByIdForUpdate(meta.id, tx);
      if (!lockedPayment) {
        throw createHttpError(
          HTTP_STATUS.HTTP_404_NOT_FOUND,
          PAYMENT_ERROR_MESSAGES.NOT_FOUND,
        );
      }

      if (lockedPayment.status !== 'PENDING') {
        return this.mapPaymentDto(lockedPayment);
      }

      const updated = await this.reconcilePendingPaymentInTx(
        lockedPayment,
        targetStatus,
        tx,
      );
      return this.mapPaymentDto(updated);
    });
  }

  async cancelPayment(
    userId: string,
    paymentId: string,
    input: CancelPaymentRequest = {},
  ): Promise<PaymentDTO> {
    const meta = await this.repository.findOwnedPaymentMeta(paymentId, userId);
    if (!meta) {
      throw createHttpError(HTTP_STATUS.HTTP_404_NOT_FOUND, PAYMENT_ERROR_MESSAGES.NOT_FOUND);
    }

    if (meta.orderStatus === 'PAID') {
      throw createHttpError(
        HTTP_STATUS.HTTP_409_CONFLICT,
        PAYMENT_ERROR_MESSAGES.ORDER_ALREADY_PAID,
      );
    }

    if (meta.status !== 'PENDING') {
      throw createHttpError(
        HTTP_STATUS.HTTP_409_CONFLICT,
        PAYMENT_ERROR_MESSAGES.NOT_PENDING_TO_CANCEL,
      );
    }

    const payosLink = await this.getPayos().cancelPaymentLink(meta.orderCode, input.reason);

    return this.repository.runInTransaction(async (tx) => {
      const lockedOrder = await this.orders.lockOwnedOrder(userId, meta.orderId, tx);
      const lockedPayment = await this.repository.findByIdForUpdate(meta.id, tx);
      if (!lockedPayment) {
        throw createHttpError(
          HTTP_STATUS.HTTP_404_NOT_FOUND,
          PAYMENT_ERROR_MESSAGES.NOT_FOUND,
        );
      }

      if (payosLink.status === 'PAID') {
        if (lockedPayment.status === 'PENDING') {
          await this.reconcilePendingPaymentInTx(lockedPayment, 'PAID', tx);
        }
        throw createHttpError(
          HTTP_STATUS.HTTP_409_CONFLICT,
          PAYMENT_ERROR_MESSAGES.ORDER_ALREADY_PAID,
        );
      }

      if (lockedOrder.status === 'PAID' || lockedPayment.status === 'PAID') {
        throw createHttpError(
          HTTP_STATUS.HTTP_409_CONFLICT,
          PAYMENT_ERROR_MESSAGES.ORDER_ALREADY_PAID,
        );
      }

      if (payosLink.status === 'EXPIRED') {
        if (lockedPayment.status === 'PENDING') {
          await this.reconcilePendingPaymentInTx(lockedPayment, 'EXPIRED', tx);
        }
        throw createHttpError(
          HTTP_STATUS.HTTP_409_CONFLICT,
          PAYMENT_ERROR_MESSAGES.NOT_PENDING_TO_CANCEL,
        );
      }

      if (lockedPayment.status !== 'PENDING') {
        throw createHttpError(
          HTTP_STATUS.HTTP_409_CONFLICT,
          PAYMENT_ERROR_MESSAGES.NOT_PENDING_TO_CANCEL,
        );
      }

      const cancelled = await this.repository.updateStatusIfPending(
        lockedPayment.id,
        {
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
        tx,
      );
      if (!cancelled) {
        throw createHttpError(
          HTTP_STATUS.HTTP_409_CONFLICT,
          PAYMENT_ERROR_MESSAGES.NOT_PENDING_TO_CANCEL,
        );
      }

      return this.mapPaymentDto(cancelled);
    });
  }

  private async reconcilePendingPaymentInTx(
    payment: PaymentRecord,
    targetStatus: Extract<PaymentLink['status'], 'PAID' | 'CANCELLED' | 'EXPIRED'>,
    tx: PaymentDbExecutor,
  ): Promise<PaymentRecord> {
    const now = new Date();
    const updated = await this.repository.updateStatusIfPending(
      payment.id,
      targetStatus === 'PAID'
        ? { status: 'PAID', paidAt: now }
        : targetStatus === 'CANCELLED'
          ? { status: 'CANCELLED', cancelledAt: now }
          : { status: 'EXPIRED' },
      tx,
    );

    if (targetStatus === 'PAID') {
      await this.orders.markOrderPaidIfPending(payment.orderId, tx);
    }

    return updated ?? payment;
  }

  private async tryAcquireOrderLock(
    orderId: string,
  ): Promise<{ lockKey: string | null; lockToken: string | null }> {
    let redis: PaymentsRedisClient | undefined;
    try {
      redis = await this.getRedisClient();
    } catch {
      return { lockKey: null, lockToken: null };
    }

    if (!redis) {
      return { lockKey: null, lockToken: null };
    }

    const lockKey = `${PAYMENT_REDIS_KEYS.ORDER_LOCK_PREFIX}${orderId}`;
    const lockToken = crypto.randomUUID();

    let acquired: unknown;
    try {
      acquired = await redis.set(lockKey, lockToken, {
        NX: true,
        PX: PAYMENT_CONFIG.ORDER_LOCK_TTL_MS,
      });
    } catch {
      return { lockKey: null, lockToken: null };
    }

    if (!acquired) {
      throw createHttpError(
        HTTP_STATUS.HTTP_409_CONFLICT,
        PAYMENT_ERROR_MESSAGES.ORDER_PAYMENT_IN_PROGRESS,
      );
    }

    return { lockKey, lockToken };
  }

  private async releaseOrderLock(
    lockKey: string | null,
    lockToken: string | null,
  ): Promise<void> {
    if (!lockKey || !lockToken) {
      return;
    }

    try {
      const redis = await this.getRedisClient();
      if (!redis) {
        return;
      }
      await redis.eval(RELEASE_LOCK_LUA, {
        keys: [lockKey],
        arguments: [lockToken],
      });
    } catch {
      // Lock has a TTL fallback; ignore cleanup errors.
    }
  }
}

export const paymentsService = new PaymentsService();
