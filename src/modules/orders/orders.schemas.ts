import { z } from 'zod';
import { orderStatuses } from '../../models/order.model.js';
import {
  paginationMetaSchema,
  paginationQuerySchema,
} from '../../shared/schemas/pagination.schema.js';
import { ORDER_CONFIG, ORDER_ERROR_MESSAGES } from './orders.constants.js';

export const createOrderSchema = z.object({
  amount: z
    .number()
    .int(ORDER_ERROR_MESSAGES.AMOUNT_INTEGER)
    .min(ORDER_CONFIG.MIN_AMOUNT, ORDER_ERROR_MESSAGES.AMOUNT_TOO_SMALL)
    .max(ORDER_CONFIG.MAX_AMOUNT, ORDER_ERROR_MESSAGES.AMOUNT_TOO_LARGE),
  description: z
    .string()
    .trim()
    .min(ORDER_CONFIG.DESCRIPTION_MIN_LENGTH, ORDER_ERROR_MESSAGES.DESCRIPTION_REQUIRED)
    .max(ORDER_CONFIG.DESCRIPTION_MAX_LENGTH, ORDER_ERROR_MESSAGES.DESCRIPTION_TOO_LONG),
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;

export const orderIdParamSchema = z.object({
  id: z.string().uuid(ORDER_ERROR_MESSAGES.INVALID_ID),
});

export type OrderIdParam = z.infer<typeof orderIdParamSchema>;

export const listOrdersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(orderStatuses).optional(),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const orderDtoSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  amount: z.number().int(),
  description: z.string(),
  status: z.enum(orderStatuses),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OrderDTO = z.infer<typeof orderDtoSchema>;

export const paginatedOrdersResponseSchema = z.object({
  items: z.array(orderDtoSchema),
  pagination: paginationMetaSchema,
});

export type PaginatedOrdersResponse = z.infer<typeof paginatedOrdersResponseSchema>;
