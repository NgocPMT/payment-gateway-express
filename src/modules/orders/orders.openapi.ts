import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { HTTP_STATUS } from '../../shared/constants/http-status.js';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderDtoSchema,
  orderIdParamSchema,
  paginatedOrdersResponseSchema,
} from './orders.schemas.js';

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
        description: 'Invalid order payload',
      },
      [HTTP_STATUS.HTTP_401_UNAUTHORIZED]: {
        description: 'Authentication required',
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
