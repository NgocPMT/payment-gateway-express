import { describe, expect, it } from 'vitest';

import {
  ORDER_CONFIG,
  ORDER_ERROR_MESSAGES,
} from '../../../src/modules/orders/orders.constants.js';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderIdParamSchema,
} from '../../../src/modules/orders/orders.schemas.js';
import { PAGINATION } from '../../../src/shared/constants/pagination.js';

describe('orders.schemas', () => {
  describe('createOrderSchema', () => {
    it('accepts valid payload and trims description', () => {
      const parsed = createOrderSchema.parse({
        amount: ORDER_CONFIG.MIN_AMOUNT,
        description: '  Order #1001  ',
      });

      expect(parsed).toEqual({
        amount: ORDER_CONFIG.MIN_AMOUNT,
        description: 'Order #1001',
      });
    });

    it('accepts maximum allowed amount and description length', () => {
      const maxDescription = 'a'.repeat(ORDER_CONFIG.DESCRIPTION_MAX_LENGTH);
      const parsed = createOrderSchema.parse({
        amount: ORDER_CONFIG.MAX_AMOUNT,
        description: maxDescription,
      });

      expect(parsed.amount).toBe(ORDER_CONFIG.MAX_AMOUNT);
      expect(parsed.description).toHaveLength(ORDER_CONFIG.DESCRIPTION_MAX_LENGTH);
    });

    it('rejects non-integer amount', () => {
      const result = createOrderSchema.safeParse({
        amount: 1000.5,
        description: 'Order #1001',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(ORDER_ERROR_MESSAGES.AMOUNT_INTEGER);
      }
    });

    it('rejects amount below minimum', () => {
      const result = createOrderSchema.safeParse({
        amount: ORDER_CONFIG.MIN_AMOUNT - 1,
        description: 'Order #1001',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(ORDER_ERROR_MESSAGES.AMOUNT_TOO_SMALL);
      }
    });

    it('rejects amount above maximum', () => {
      const result = createOrderSchema.safeParse({
        amount: ORDER_CONFIG.MAX_AMOUNT + 1,
        description: 'Order #1001',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(ORDER_ERROR_MESSAGES.AMOUNT_TOO_LARGE);
      }
    });

    it('rejects empty or whitespace-only description', () => {
      const result = createOrderSchema.safeParse({
        amount: ORDER_CONFIG.MIN_AMOUNT,
        description: '   ',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          ORDER_ERROR_MESSAGES.DESCRIPTION_REQUIRED,
        );
      }
    });

    it('rejects description exceeding max length', () => {
      const result = createOrderSchema.safeParse({
        amount: ORDER_CONFIG.MIN_AMOUNT,
        description: 'a'.repeat(ORDER_CONFIG.DESCRIPTION_MAX_LENGTH + 1),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          ORDER_ERROR_MESSAGES.DESCRIPTION_TOO_LONG,
        );
      }
    });
  });

  describe('orderIdParamSchema', () => {
    it('accepts a valid UUID', () => {
      const id = '018f6e72-5555-7e28-9f20-b42e77b4a1b4';
      const parsed = orderIdParamSchema.parse({ id });

      expect(parsed.id).toBe(id);
    });

    it('rejects an invalid UUID', () => {
      const result = orderIdParamSchema.safeParse({ id: 'not-a-uuid' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(ORDER_ERROR_MESSAGES.INVALID_ID);
      }
    });
  });

  describe('listOrdersQuerySchema', () => {
    it('applies default page and limit when omitted', () => {
      const parsed = listOrdersQuerySchema.parse({});

      expect(parsed).toEqual({
        page: PAGINATION.DEFAULT_PAGE,
        limit: PAGINATION.DEFAULT_LIMIT,
      });
    });

    it('coerces string query parameters and accepts valid status', () => {
      const parsed = listOrdersQuerySchema.parse({
        page: '2',
        limit: '15',
        status: 'PAID',
      });

      expect(parsed).toEqual({
        page: 2,
        limit: 15,
        status: 'PAID',
      });
    });

    it('rejects page less than 1 or non-integer', () => {
      expect(listOrdersQuerySchema.safeParse({ page: '0' }).success).toBe(false);
      expect(listOrdersQuerySchema.safeParse({ page: '1.5' }).success).toBe(false);
    });

    it('rejects limit less than 1 or exceeding MAX_LIMIT', () => {
      expect(listOrdersQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
      expect(
        listOrdersQuerySchema.safeParse({ limit: String(PAGINATION.MAX_LIMIT + 1) }).success,
      ).toBe(false);
    });

    it('rejects invalid order status', () => {
      const result = listOrdersQuerySchema.safeParse({ status: 'UNKNOWN_STATUS' });

      expect(result.success).toBe(false);
    });
  });
});
