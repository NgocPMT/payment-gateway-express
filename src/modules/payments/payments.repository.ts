import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { orders, type OrderStatus } from '../../models/order.model.js';
import {
  payments,
  type PaymentRecord,
  type PaymentStatus,
} from '../../models/payment.model.js';
import { PAYMENT_ERROR_MESSAGES } from './payments.constants.js';

export type PaymentDbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreatePaymentData {
  orderId: string;
  orderCode: number;
  paymentLinkId: string;
  checkoutUrl: string;
  qrCode: string;
  amount: number;
  expiresAt: Date;
}

export interface FindPaymentsByUserOptions {
  page: number;
  limit: number;
  orderId?: string;
  status?: PaymentStatus;
}

export interface PaginatedPaymentRecords {
  items: PaymentRecord[];
  total: number;
}

export interface OwnedPaymentMeta {
  id: string;
  orderId: string;
  orderCode: number;
  status: PaymentStatus;
  orderStatus: OrderStatus;
}

export interface UpdatePaymentStatusIfPendingData {
  status: Exclude<PaymentStatus, 'PENDING'>;
  paidAt?: Date;
  cancelledAt?: Date;
}

export class PaymentsRepository {
  async runInTransaction<T>(fn: (tx: PaymentDbExecutor) => Promise<T>): Promise<T> {
    return db.transaction(fn);
  }

  async createPayment(
    data: CreatePaymentData,
    executor: PaymentDbExecutor = db,
  ): Promise<PaymentRecord> {
    const [payment] = await executor
      .insert(payments)
      .values({
        orderId: data.orderId,
        orderCode: data.orderCode,
        paymentLinkId: data.paymentLinkId,
        checkoutUrl: data.checkoutUrl,
        qrCode: data.qrCode,
        amount: data.amount,
        expiresAt: data.expiresAt,
      })
      .returning();

    if (!payment) {
      throw new Error(PAYMENT_ERROR_MESSAGES.CREATE_FAILED);
    }

    return payment;
  }

  async findById(
    id: string,
    executor: PaymentDbExecutor = db,
  ): Promise<PaymentRecord | null> {
    const [payment] = await executor
      .select()
      .from(payments)
      .where(eq(payments.id, id))
      .limit(1);
    return payment ?? null;
  }

  async findByIdForUpdate(
    id: string,
    executor: PaymentDbExecutor,
  ): Promise<PaymentRecord | null> {
    const [payment] = await executor
      .select()
      .from(payments)
      .where(eq(payments.id, id))
      .for('update')
      .limit(1);
    return payment ?? null;
  }

  async findByOrderCode(
    orderCode: number,
    executor: PaymentDbExecutor = db,
  ): Promise<PaymentRecord | null> {
    const [payment] = await executor
      .select()
      .from(payments)
      .where(eq(payments.orderCode, orderCode))
      .limit(1);
    return payment ?? null;
  }

  async findByOrderCodeForUpdate(
    orderCode: number,
    executor: PaymentDbExecutor,
  ): Promise<PaymentRecord | null> {
    const [payment] = await executor
      .select()
      .from(payments)
      .where(eq(payments.orderCode, orderCode))
      .for('update')
      .limit(1);
    return payment ?? null;
  }

  async findPendingByOrderId(
    orderId: string,
    executor: PaymentDbExecutor = db,
  ): Promise<PaymentRecord | null> {
    const [payment] = await executor
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'PENDING')))
      .limit(1);
    return payment ?? null;
  }

  async findOwnedPaymentMeta(
    id: string,
    userId: string,
    executor: PaymentDbExecutor = db,
  ): Promise<OwnedPaymentMeta | null> {
    const [row] = await executor
      .select({
        id: payments.id,
        orderId: payments.orderId,
        orderCode: payments.orderCode,
        status: payments.status,
        orderStatus: orders.status,
      })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .where(and(eq(payments.id, id), eq(orders.userId, userId)))
      .limit(1);

    return row ?? null;
  }

  async findOwnedById(
    id: string,
    userId: string,
    executor: PaymentDbExecutor = db,
  ): Promise<PaymentRecord | null> {
    const [row] = await executor
      .select({ payment: payments })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .where(and(eq(payments.id, id), eq(orders.userId, userId)))
      .limit(1);

    return row?.payment ?? null;
  }

  async findManyByUserId(
    userId: string,
    options: FindPaymentsByUserOptions,
    executor: PaymentDbExecutor = db,
  ): Promise<PaginatedPaymentRecords> {
    const conditions = [eq(orders.userId, userId)];
    if (options.orderId !== undefined) {
      conditions.push(eq(payments.orderId, options.orderId));
    }
    if (options.status !== undefined) {
      conditions.push(eq(payments.status, options.status));
    }

    const whereClause = and(...conditions);
    const offset = (options.page - 1) * options.limit;

    const [rows, totalRows] = await Promise.all([
      executor
        .select({ payment: payments })
        .from(payments)
        .innerJoin(orders, eq(payments.orderId, orders.id))
        .where(whereClause)
        .orderBy(desc(payments.createdAt))
        .limit(options.limit)
        .offset(offset),
      executor
        .select({ value: count() })
        .from(payments)
        .innerJoin(orders, eq(payments.orderId, orders.id))
        .where(whereClause),
    ]);

    return {
      items: rows.map((row) => row.payment),
      total: Number(totalRows[0]?.value ?? 0),
    };
  }

  async updateStatusIfPending(
    id: string,
    update: UpdatePaymentStatusIfPendingData,
    executor: PaymentDbExecutor = db,
  ): Promise<PaymentRecord | null> {
    const setValues: {
      status: PaymentStatus;
      updatedAt: Date;
      paidAt?: Date;
      cancelledAt?: Date;
    } = {
      status: update.status,
      updatedAt: new Date(),
    };

    if (update.paidAt !== undefined) {
      setValues.paidAt = update.paidAt;
    }
    if (update.cancelledAt !== undefined) {
      setValues.cancelledAt = update.cancelledAt;
    }

    const [updated] = await executor
      .update(payments)
      .set(setValues)
      .where(and(eq(payments.id, id), eq(payments.status, 'PENDING')))
      .returning();

    return updated ?? null;
  }
}

export const paymentsRepository = new PaymentsRepository();
