import { TIME_SECONDS } from '../../shared/constants/time.js';

export const PAYMENT_CONFIG = {
  DEFAULT_EXPIRES_IN_SECONDS: TIME_SECONDS.FIFTEEN_MINUTES,
  MIN_EXPIRES_IN_SECONDS: TIME_SECONDS.ONE_MINUTE,
  MAX_EXPIRES_IN_SECONDS: TIME_SECONDS.ONE_DAY,
  ORDER_LOCK_TTL_MS: 30_000,
  PAYOS_DESCRIPTION_MAX_LENGTH: 25,
  DEFAULT_PAYOS_DESCRIPTION: 'Order payment',
  CANCEL_REASON_MAX_LENGTH: 255,
  ORDER_CODE_RANDOM_RANGE: 1_000,
  ORDER_CODE_MAX_ATTEMPTS: 3,
} as const;

export const PAYMENT_REDIS_KEYS = {
  ORDER_LOCK_PREFIX: 'lock:order:',
} as const;

export const PAYMENT_ERROR_MESSAGES = {
  NOT_FOUND: 'Payment not found',
  CREATE_FAILED: 'Failed to create payment',
  ORDER_NOT_PENDING: 'Only PENDING orders can create a payment',
  ACTIVE_PAYMENT_EXISTS: 'Order already has a pending payment. Sync or cancel it first',
  ORDER_PAYMENT_IN_PROGRESS: 'Payment creation is already in progress for this order',
  NOT_PENDING_TO_CANCEL: 'Only PENDING payments can be cancelled',
  ORDER_ALREADY_PAID: 'Cannot cancel payment for an already paid order',
} as const;
