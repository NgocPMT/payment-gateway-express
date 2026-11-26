import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrdersController } from '../../../src/modules/orders/orders.controller.js';
import type { OrderDTO, PaginatedOrdersResponse } from '../../../src/modules/orders/orders.schemas.js';
import type { OrdersService } from '../../../src/modules/orders/orders.service.js';
import { HTTP_STATUS } from '../../../src/shared/constants/http-status.js';
import { isHttpError } from '../../../src/shared/errors/http-error.js';

const USER_ID = '018f6e72-23b0-7e28-9f20-b42e77b4a1a3';
const ORDER_ID = '018f6e72-5555-7e28-9f20-b42e77b4a1b4';

function buildOrderDto(): OrderDTO {
  return {
    id: ORDER_ID,
    userId: USER_ID,
    amount: 50000,
    description: 'Order #1001',
    status: 'PENDING',
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
  };
}

function createMockResponse(validated: Record<string, unknown> = {}) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = {
    status,
    locals: { validated },
  } as never;
  return { res, status, json };
}

describe('OrdersController', () => {
  let mockService: Partial<OrdersService>;
  let controller: OrdersController;

  beforeEach(() => {
    mockService = {
      createOrder: vi.fn(),
      listOrders: vi.fn(),
      getOrderById: vi.fn(),
    };
    controller = new OrdersController(mockService as OrdersService);
  });

  describe('createOrder', () => {
    it('returns 201 with created order DTO', async () => {
      const dto = buildOrderDto();
      mockService.createOrder = vi.fn().mockResolvedValue(dto);
      const { res, status, json } = createMockResponse({
        body: { amount: 50000, description: 'Order #1001' },
      });
      const req = { user: { id: USER_ID, email: 'a@test.com', role: 'user' } } as never;
      const next = vi.fn();

      await controller.createOrder(req, res, next);

      expect(mockService.createOrder).toHaveBeenCalledWith(USER_ID, {
        amount: 50000,
        description: 'Order #1001',
      });
      expect(status).toHaveBeenCalledWith(HTTP_STATUS.HTTP_201_CREATED);
      expect(json).toHaveBeenCalledWith(dto);
    });

    it('forwards 401 HttpError when req.user is missing', async () => {
      const { res } = createMockResponse({ body: { amount: 50000, description: 'Order' } });
      const next = vi.fn();

      await controller.createOrder({} as never, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: HTTP_STATUS.HTTP_401_UNAUTHORIZED }),
      );
    });
  });

  describe('listOrders', () => {
    it('returns 200 with paginated orders', async () => {
      const paginated: PaginatedOrdersResponse = {
        items: [buildOrderDto()],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      };
      mockService.listOrders = vi.fn().mockResolvedValue(paginated);
      const { res, status, json } = createMockResponse({
        query: { page: 1, limit: 20 },
      });
      const req = { user: { id: USER_ID, email: 'a@test.com', role: 'user' } } as never;
      const next = vi.fn();

      await controller.listOrders(req, res, next);

      expect(mockService.listOrders).toHaveBeenCalledWith(USER_ID, { page: 1, limit: 20 });
      expect(status).toHaveBeenCalledWith(HTTP_STATUS.HTTP_200_OK);
      expect(json).toHaveBeenCalledWith(paginated);
    });

    it('forwards service errors to next', async () => {
      const err = new Error('DB error');
      mockService.listOrders = vi.fn().mockRejectedValue(err);
      const { res } = createMockResponse({ query: { page: 1, limit: 20 } });
      const req = { user: { id: USER_ID, email: 'a@test.com', role: 'user' } } as never;
      const next = vi.fn();

      await controller.listOrders(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('getOrderById', () => {
    it('returns 200 with order DTO', async () => {
      const dto = buildOrderDto();
      mockService.getOrderById = vi.fn().mockResolvedValue(dto);
      const { res, status, json } = createMockResponse({ params: { id: ORDER_ID } });
      const req = { user: { id: USER_ID, email: 'a@test.com', role: 'user' } } as never;
      const next = vi.fn();

      await controller.getOrderById(req, res, next);

      expect(mockService.getOrderById).toHaveBeenCalledWith(USER_ID, ORDER_ID);
      expect(status).toHaveBeenCalledWith(HTTP_STATUS.HTTP_200_OK);
      expect(json).toHaveBeenCalledWith(dto);
    });

    it('forwards 401 when req.user is missing', async () => {
      const { res } = createMockResponse({ params: { id: ORDER_ID } });
      const next = vi.fn();

      await controller.getOrderById({} as never, res, next);

      const error = next.mock.calls[0]?.[0];
      expect(isHttpError(error)).toBe(true);
      if (isHttpError(error)) {
        expect(error.statusCode).toBe(HTTP_STATUS.HTTP_401_UNAUTHORIZED);
      }
    });
  });
});
