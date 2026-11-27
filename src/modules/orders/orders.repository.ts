import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { orders, type OrderRecord, type OrderStatus } from '../../models/order.model.js';
import { ORDER_ERROR_MESSAGES } from './orders.constants.js';

export type OrderDbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateOrderData {
  userId: string;
  amount: number;
  description: string;
}

export interface FindOrdersByUserOptions {
  page: number;
  limit: number;
  status?: OrderStatus;
}

export interface PaginatedOrderRecords {
  items: OrderRecord[];
  total: number;
}

export class OrdersRepository {
  async createOrder(
    data: CreateOrderData,
    executor: OrderDbExecutor = db,
  ): Promise<OrderRecord> {
    const [order] = await executor
      .insert(orders)
      .values({
        userId: data.userId,
        amount: data.amount,
        description: data.description,
      })
      .returning();

    if (!order) {
      throw new Error(ORDER_ERROR_MESSAGES.CREATE_FAILED);
    }

    return order;
  }

  async findById(
    id: string,
    executor: OrderDbExecutor = db,
  ): Promise<OrderRecord | null> {
    const result = await executor.query.orders.findFirst({
      where: eq(orders.id, id),
    });
    return result ?? null;
  }

  async findByIdAndUserId(
    id: string,
    userId: string,
    executor: OrderDbExecutor = db,
  ): Promise<OrderRecord | null> {
    const result = await executor.query.orders.findFirst({
      where: and(eq(orders.id, id), eq(orders.userId, userId)),
    });
    return result ?? null;
  }

  async findByIdForUpdate(
    id: string,
    executor: OrderDbExecutor,
  ): Promise<OrderRecord | null> {
    const [order] = await executor
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .for('update')
      .limit(1);
    return order ?? null;
  }

  async findByIdAndUserIdForUpdate(
    id: string,
    userId: string,
    executor: OrderDbExecutor,
  ): Promise<OrderRecord | null> {
    const [order] = await executor
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.userId, userId)))
      .for('update')
      .limit(1);
    return order ?? null;
  }

  async markPaidIfPending(
    id: string,
    executor: OrderDbExecutor = db,
  ): Promise<OrderRecord | null> {
    const [order] = await executor
      .update(orders)
      .set({
        status: 'PAID',
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, id), eq(orders.status, 'PENDING')))
      .returning();
    return order ?? null;
  }

  async findManyByUserId(
    userId: string,
    options: FindOrdersByUserOptions,
    executor: OrderDbExecutor = db,
  ): Promise<PaginatedOrderRecords> {
    const whereClause = options.status
      ? and(eq(orders.userId, userId), eq(orders.status, options.status))
      : eq(orders.userId, userId);

    const offset = (options.page - 1) * options.limit;

    const [items, countRows] = await Promise.all([
      executor
        .select()
        .from(orders)
        .where(whereClause)
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(options.limit)
        .offset(offset),
      executor
        .select({ total: count() })
        .from(orders)
        .where(whereClause),
    ]);

    return {
      items,
      total: Number(countRows[0]?.total ?? 0),
    };
  }
}

export const ordersRepository = new OrdersRepository();
