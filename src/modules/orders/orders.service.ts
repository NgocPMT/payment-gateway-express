import type { OrderRecord } from '../../models/order.model.js';
import { HTTP_STATUS } from '../../shared/constants/http-status.js';
import { createHttpError } from '../../shared/errors/http-error.js';
import { buildPaginationMeta } from '../../shared/schemas/pagination.schema.js';
import { ORDER_ERROR_MESSAGES } from './orders.constants.js';
import {
  ordersRepository,
  type FindOrdersByUserOptions,
  type OrdersRepository,
} from './orders.repository.js';
import type {
  CreateOrderRequest,
  ListOrdersQuery,
  OrderDTO,
  PaginatedOrdersResponse,
} from './orders.schemas.js';

export class OrdersService {
  constructor(private readonly repository: OrdersRepository = ordersRepository) {}

  mapOrderDto(order: OrderRecord): OrderDTO {
    return {
      id: order.id,
      userId: order.userId,
      amount: order.amount,
      description: order.description,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  async createOrder(userId: string, input: CreateOrderRequest): Promise<OrderDTO> {
    const order = await this.repository.createOrder({
      userId,
      amount: input.amount,
      description: input.description,
    });
    return this.mapOrderDto(order);
  }

  async listOrders(
    userId: string,
    query: ListOrdersQuery,
  ): Promise<PaginatedOrdersResponse> {
    const options: FindOrdersByUserOptions = {
      page: query.page,
      limit: query.limit,
      ...(query.status ? { status: query.status } : {}),
    };

    const { items, total } = await this.repository.findManyByUserId(userId, options);

    return {
      items: items.map((order) => this.mapOrderDto(order)),
      pagination: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  async getOwnedOrderEntity(userId: string, orderId: string): Promise<OrderRecord> {
    const order = await this.repository.findByIdAndUserId(orderId, userId);
    if (!order) {
      throw createHttpError(HTTP_STATUS.HTTP_404_NOT_FOUND, ORDER_ERROR_MESSAGES.NOT_FOUND);
    }
    return order;
  }

  async getOrderById(userId: string, orderId: string): Promise<OrderDTO> {
    const order = await this.getOwnedOrderEntity(userId, orderId);
    return this.mapOrderDto(order);
  }
}

export const ordersService = new OrdersService();
