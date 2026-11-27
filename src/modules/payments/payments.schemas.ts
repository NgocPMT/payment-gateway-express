import { z } from 'zod';
import { paymentStatuses } from '../../models/payment.model.js';
import {
  paginationMetaSchema,
  paginationQuerySchema,
} from '../../shared/schemas/pagination.schema.js';
import { PAYMENT_CONFIG } from './payments.constants.js';

export const createPaymentSchema = z.object({
  orderId: z.string().uuid('Invalid order ID'),
  expiresInSeconds: z
    .number()
    .int('Expiration must be an integer')
    .min(
      PAYMENT_CONFIG.MIN_EXPIRES_IN_SECONDS,
      `Expiration must be at least ${PAYMENT_CONFIG.MIN_EXPIRES_IN_SECONDS} seconds`,
    )
    .max(
      PAYMENT_CONFIG.MAX_EXPIRES_IN_SECONDS,
      `Expiration cannot exceed ${PAYMENT_CONFIG.MAX_EXPIRES_IN_SECONDS} seconds`,
    )
    .optional(),
});

export type CreatePaymentRequest = z.infer<typeof createPaymentSchema>;

export const paymentIdParamSchema = z.object({
  id: z.string().uuid('Invalid payment ID'),
});

export type PaymentIdParam = z.infer<typeof paymentIdParamSchema>;

export const listPaymentsQuerySchema = paginationQuerySchema.extend({
  orderId: z.string().uuid('Invalid order ID').optional(),
  status: z.enum(paymentStatuses).optional(),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export const cancelPaymentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Cancel reason cannot be empty')
    .max(
      PAYMENT_CONFIG.CANCEL_REASON_MAX_LENGTH,
      `Cancel reason must be at most ${PAYMENT_CONFIG.CANCEL_REASON_MAX_LENGTH} characters`,
    )
    .optional(),
});

export type CancelPaymentRequest = z.infer<typeof cancelPaymentSchema>;

export const paymentDtoSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  orderCode: z.number().int().positive(),
  paymentLinkId: z.string(),
  checkoutUrl: z.string(),
  qrCode: z.string(),
  amount: z.number().int().positive(),
  status: z.enum(paymentStatuses),
  expiresAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PaymentDTO = z.infer<typeof paymentDtoSchema>;

export const paginatedPaymentsResponseSchema = z.object({
  items: z.array(paymentDtoSchema),
  meta: paginationMetaSchema,
});

export type PaginatedPaymentsResponse = z.infer<typeof paginatedPaymentsResponseSchema>;
