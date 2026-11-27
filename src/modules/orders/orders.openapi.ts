import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { IDEMPOTENCY_KEY_MAX_LENGTH } from '../../middleware/idempotency.middleware.js';
import { HTTP_STATUS } from '../../shared/constants/http-status.js';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderDtoSchema,
  orderIdParamSchema,
  paginatedOrdersResponseSchema,
} from './orders.schemas.js';

const idempotencyHeaderSchema = z.object({
  'Idempotency-Key': z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).openapi({
    description: 'Unique key to guarantee idempotent order creation across retries',
    example: '018f6e72-5555-7e28-9f20-b42e77b4a1b4',
  }),
});

export function registerOrdersOpenApi(registry: OpenAPIRegistry): void {
  const registeredCreateOrderRequest = registry.register(
    'CreateOrderRequest',
    createOrderSchema,
  );
  const registeredOrderDto = registry.register('OrderDTO', orderDtoSchema);
  const registeredPaginatedOrdersResponse = registry.register(
    'PaginatedOrdersResponse',
    paginatedOrdersResponseSchema,
  );

  registry.registerPath({
    method: 'post',
    path: '/api/v1/orders',
    tags: ['Orders'],
    summary: 'Create a new order',
    security: [{ bearerAuth: [] }],
    request: {
      headers: idempotencyHeaderSchema,
      body: {
        content: {
          'application/json': {
            schema: registeredCreateOrderRequest,
          },
        },
      },
    },
    responses: {
      [HTTP_STATUS.HTTP_201_CREATED]: {
        description: 'Order created successfully',
        content: {
          'application/json': {
            schema: registeredOrderDto,
          },
        },
      },
      [HTTP_STATUS.HTTP_400_BAD_REQUEST]: {
        description: 'Invalid order payload or missing Idempotency-Key header',
      },
      [HTTP_STATUS.HTTP_401_UNAUTHORIZED]: {
        description: 'Authentication required',
      },
      [HTTP_STATUS.HTTP_409_CONFLICT]: {
        description: 'A request with this Idempotency-Key is already in progress',
      },
      [HTTP_STATUS.HTTP_422_UNPROCESSABLE_ENTITY]: {
        description: 'Idempotency-Key reused with a different request payload',
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/orders',
    tags: ['Orders'],
    summary: 'List orders for the authenticated user',
    security: [{ bearerAuth: [] }],
    request: {
      query: listOrdersQuerySchema,
    },
    responses: {
      [HTTP_STATUS.HTTP_200_OK]: {
        description: 'Orders retrieved successfully',
        content: {
          'application/json': {
            schema: registeredPaginatedOrdersResponse,
          },
        },
      },
      [HTTP_STATUS.HTTP_400_BAD_REQUEST]: {
        description: 'Invalid query parameters',
      },
      [HTTP_STATUS.HTTP_401_UNAUTHORIZED]: {
        description: 'Authentication required',
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/orders/{id}',
    tags: ['Orders'],
    summary: 'Get order by ID',
    security: [{ bearerAuth: [] }],
    request: {
      params: orderIdParamSchema,
    },
    responses: {
      [HTTP_STATUS.HTTP_200_OK]: {
        description: 'Order details retrieved successfully',
        content: {
          'application/json': {
            schema: registeredOrderDto,
          },
        },
      },
      [HTTP_STATUS.HTTP_400_BAD_REQUEST]: {
        description: 'Invalid order ID format',
      },
      [HTTP_STATUS.HTTP_401_UNAUTHORIZED]: {
        description: 'Authentication required',
      },
      [HTTP_STATUS.HTTP_404_NOT_FOUND]: {
        description: 'Order not found',
      },
    },
  });
}
