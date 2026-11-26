import type { Request, RequestHandler } from 'express';

import { HTTP_STATUS } from '../../shared/constants/http-status.js';
import { createHttpError } from '../../shared/errors/http-error.js';
import type {
  CreateOrderRequest,
  ListOrdersQuery,
  OrderIdParam,
} from './orders.schemas.js';
import { ordersService, type OrdersService } from './orders.service.js';

function requireAuthenticatedUserId(req: Request): string {
  if (!req.user) {
    throw createHttpError(HTTP_STATUS.HTTP_401_UNAUTHORIZED, 'Authentication required');
  }
  return req.user.id;
}

export class OrdersController {
  constructor(private readonly service: OrdersService = ordersService) {}

  createOrder: RequestHandler = async (req, res, next) => {
    try {
      const userId = requireAuthenticatedUserId(req);
      const input = res.locals.validated?.body as CreateOrderRequest;
      const result = await this.service.createOrder(userId, input);
      res.status(HTTP_STATUS.HTTP_201_CREATED).json(result);
    } catch (error) {
      next(error);
    }
  };

  listOrders: RequestHandler = async (req, res, next) => {
    try {
      const userId = requireAuthenticatedUserId(req);
      const query = res.locals.validated?.query as ListOrdersQuery;
      const result = await this.service.listOrders(userId, query);
      res.status(HTTP_STATUS.HTTP_200_OK).json(result);
    } catch (error) {
      next(error);
    }
  };

  getOrderById: RequestHandler = async (req, res, next) => {
    try {
      const userId = requireAuthenticatedUserId(req);
      const params = res.locals.validated?.params as OrderIdParam;
      const result = await this.service.getOrderById(userId, params.id);
      res.status(HTTP_STATUS.HTTP_200_OK).json(result);
    } catch (error) {
      next(error);
    }
  };
}

export const ordersController = new OrdersController();
