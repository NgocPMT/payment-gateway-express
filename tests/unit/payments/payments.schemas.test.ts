import { describe, expect, it } from 'vitest';

import { PAYMENT_CONFIG } from '../../../src/modules/payments/payments.constants.js';
import {
  cancelPaymentSchema,
  createPaymentSchema,
  listPaymentsQuerySchema,
  paymentIdParamSchema,
} from '../../../src/modules/payments/payments.schemas.js';

const VALID_UUID = '018f6e72-5555-7e28-9f20-b42e77b4a1b4';

describe('payments.schemas', () => {
  describe('createPaymentSchema', () => {
    it('accepts valid orderId without expiresInSeconds', () => {
      const parsed = createPaymentSchema.parse({ orderId: VALID_UUID });
      expect(parsed).toEqual({ orderId: VALID_UUID });
    });

    it('accepts boundary expiresInSeconds values (min and max)', () => {
      expect(
        createPaymentSchema.parse({
          orderId: VALID_UUID,
          expiresInSeconds: PAYMENT_CONFIG.MIN_EXPIRES_IN_SECONDS,
        }),
      ).toEqual({
        orderId: VALID_UUID,
        expiresInSeconds: PAYMENT_CONFIG.MIN_EXPIRES_IN_SECONDS,
      });

      expect(
        createPaymentSchema.parse({
          orderId: VALID_UUID,
          expiresInSeconds: PAYMENT_CONFIG.MAX_EXPIRES_IN_SECONDS,
        }),
      ).toEqual({
        orderId: VALID_UUID,
        expiresInSeconds: PAYMENT_CONFIG.MAX_EXPIRES_IN_SECONDS,
      });
    });

    it('rejects invalid orderId UUID', () => {
      const result = createPaymentSchema.safeParse({ orderId: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });

    it('rejects expiresInSeconds below minimum, above maximum, or non-integer', () => {
      expect(
        createPaymentSchema.safeParse({
          orderId: VALID_UUID,
          expiresInSeconds: PAYMENT_CONFIG.MIN_EXPIRES_IN_SECONDS - 1,
        }).success,
      ).toBe(false);

      expect(
        createPaymentSchema.safeParse({
          orderId: VALID_UUID,
          expiresInSeconds: PAYMENT_CONFIG.MAX_EXPIRES_IN_SECONDS + 1,
        }).success,
      ).toBe(false);

      expect(
        createPaymentSchema.safeParse({
          orderId: VALID_UUID,
          expiresInSeconds: 120.5,
        }).success,
      ).toBe(false);
    });
  });

  describe('paymentIdParamSchema', () => {
    it('accepts valid UUID and rejects invalid UUID', () => {
      expect(paymentIdParamSchema.parse({ id: VALID_UUID })).toEqual({ id: VALID_UUID });
      expect(paymentIdParamSchema.safeParse({ id: 'bad-id' }).success).toBe(false);
    });
  });

  describe('listPaymentsQuerySchema', () => {
    it('applies default pagination values when query is empty', () => {
      const parsed = listPaymentsQuerySchema.parse({});
      expect(parsed).toEqual({ page: 1, limit: 20 });
    });

    it('accepts valid orderId and status filters', () => {
      const parsed = listPaymentsQuerySchema.parse({
        page: '2',
        limit: '10',
        orderId: VALID_UUID,
        status: 'PAID',
      });
      expect(parsed).toEqual({
        page: 2,
        limit: 10,
        orderId: VALID_UUID,
        status: 'PAID',
      });
    });

    it('rejects invalid orderId UUID or unknown status', () => {
      expect(listPaymentsQuerySchema.safeParse({ orderId: 'invalid' }).success).toBe(false);
      expect(listPaymentsQuerySchema.safeParse({ status: 'UNKNOWN' }).success).toBe(false);
    });
  });

  describe('cancelPaymentSchema', () => {
    it('accepts empty object and trims valid reason', () => {
      expect(cancelPaymentSchema.parse({})).toEqual({});
      expect(cancelPaymentSchema.parse({ reason: '  Changed mind  ' })).toEqual({
        reason: 'Changed mind',
      });
    });

    it('rejects whitespace-only reason or reason exceeding max length', () => {
      expect(cancelPaymentSchema.safeParse({ reason: '   ' }).success).toBe(false);
      expect(
        cancelPaymentSchema.safeParse({
          reason: 'a'.repeat(PAYMENT_CONFIG.CANCEL_REASON_MAX_LENGTH + 1),
        }).success,
      ).toBe(false);
    });
  });
});
