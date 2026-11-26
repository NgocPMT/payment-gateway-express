import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderRecord } from '../../../src/models/order.model.js';
import type { OrdersRepository } from '../../../src/modules/orders/orders.repository.js';
import { OrdersService } from '../../../src/modules/orders/orders.service.js';
import { HTTP_STATUS } from '../../../src/shared/constants/http-status.js';
import { isHttpError } from '../../../src/shared/errors/http-error.js';

const USER_ID = '018f6e72-23b0-7e28-9f20-b42e77b4a1a3';
const ORDER_ID = '018f6e72-5555-7e28-9f20-b42e77b4a1b4';

function buildOrderRecord(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    userId: USER_ID,
    amount: 50000,
    description: 'Order #1001',
    status: 'PENDING',
    createdAt: new Date('2026-11-26T00:00:00.000Z'),
    updatedAt: new Date('2026-11-26T00:00:00.000Z'),
    ...overrides,
  };
}

describe('OrdersService', () => {
  let mockRepo: Partial<OrdersRepository>;
  let ordersService: OrdersService;

  beforeEach(() => {
    mockRepo = {
      createOrder: vi.fn(),
      findById: vi.fn(),
      findByIdAndUserId: vi.fn(),
      findManyByUserId: vi.fn(),
    };
    ordersService = new OrdersService(mockRepo as OrdersRepository);
  });

  describe('createOrder', () => {
    it('creates an order and returns mapped DTO', async () => {
      const created = buildOrderRecord();
      mockRepo.createOrder = vi.fn().mockResolvedValue(created);

      const result = await ordersService.createOrder(USER_ID, {
        amount: 50000,
        description: 'Order #1001',
      });

      expect(mockRepo.createOrder).toHaveBeenCalledWith({
        userId: USER_ID,
        amount: 50000,
        description: 'Order #1001',
      });
      expect(result).toEqual({
        id: ORDER_ID,
        userId: USER_ID,
        amount: 50000,
        description: 'Order #1001',
        status: 'PENDING',
        createdAt: '2026-11-26T00:00:00.000Z',
        updatedAt: '2026-11-26T00:00:00.000Z',
      });
    });
  });

  describe('listOrders', () => {
    it('returns paginated orders without status filter', async () => {
      const order = buildOrderRecord();
      mockRepo.findManyByUserId = vi.fn().mockResolvedValue({
        items: [order],
        total: 25,
      });

      const result = await ordersService.listOrders(USER_ID, {
        page: 2,
        limit: 10,
      });

      expect(mockRepo.findManyByUserId).toHaveBeenCalledWith(USER_ID, {
        page: 2,
        limit: 10,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe(ORDER_ID);
      expect(result.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
      });
    });

    it('forwards status filter and returns totalPages 0 when empty', async () => {
      mockRepo.findManyByUserId = vi.fn().mockResolvedValue({
        items: [],
        total: 0,
      });

      const result = await ordersService.listOrders(USER_ID, {
        page: 1,
        limit: 20,
        status: 'PAID',
      });

      expect(mockRepo.findManyByUserId).toHaveBeenCalledWith(USER_ID, {
        page: 1,
        limit: 20,
        status: 'PAID',
      });
      expect(result).toEqual({
        items: [],
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        },
      });
    });
  });

  describe('getOrderById', () => {
    it('returns order DTO when order belongs to user', async () => {
      const order = buildOrderRecord({ status: 'PAID' });
      mockRepo.findByIdAndUserId = vi.fn().mockResolvedValue(order);

      const result = await ordersService.getOrderById(USER_ID, ORDER_ID);

      expect(mockRepo.findByIdAndUserId).toHaveBeenCalledWith(ORDER_ID, USER_ID);
      expect(result.status).toBe('PAID');
      expect(result.id).toBe(ORDER_ID);
    });

    it('throws 404 HttpError when order is not found or not owned by user', async () => {
      mockRepo.findByIdAndUserId = vi.fn().mockResolvedValue(null);

      await expect(ordersService.getOrderById(USER_ID, ORDER_ID)).rejects.toSatisfy(
        (error: unknown) =>
          isHttpError(error) &&
          error.statusCode === HTTP_STATUS.HTTP_404_NOT_FOUND &&
          error.message === 'Order not found',
      );
    });
  });

  describe('getOwnedOrderEntity', () => {
    it('returns raw order entity when owned by user', async () => {
      const order = buildOrderRecord();
      mockRepo.findByIdAndUserId = vi.fn().mockResolvedValue(order);

      const result = await ordersService.getOwnedOrderEntity(USER_ID, ORDER_ID);

      expect(result).toBe(order);
    });
  });
});
