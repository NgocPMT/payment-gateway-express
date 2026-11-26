import { Router } from 'express';

import { authenticate } from '../../middleware/auth.middleware.js';
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validate.js';
import { ordersController } from './orders.controller.js';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderIdParamSchema,
} from './orders.schemas.js';

export const ordersRouter = Router();

ordersRouter.use(authenticate);

ordersRouter.post('/', validateBody(createOrderSchema), ordersController.createOrder);
ordersRouter.get('/', validateQuery(listOrdersQuerySchema), ordersController.listOrders);
ordersRouter.get('/:id', validateParams(orderIdParamSchema), ordersController.getOrderById);
