export const ORDER_CONFIG = {
  MIN_AMOUNT: 1_000,
  MAX_AMOUNT: 2_147_483_647,
  DESCRIPTION_MIN_LENGTH: 1,
  DESCRIPTION_MAX_LENGTH: 255,
} as const;

export const ORDER_ERROR_MESSAGES = {
  NOT_FOUND: 'Order not found',
  CREATE_FAILED: 'Failed to create order',
  INVALID_ID: 'Invalid order ID format',
  AMOUNT_TOO_SMALL: `Order amount must be at least ${ORDER_CONFIG.MIN_AMOUNT}`,
  AMOUNT_TOO_LARGE: `Order amount cannot exceed ${ORDER_CONFIG.MAX_AMOUNT}`,
  AMOUNT_INTEGER: 'Order amount must be an integer',
  DESCRIPTION_REQUIRED: 'Order description is required',
  DESCRIPTION_TOO_LONG: `Order description cannot exceed ${ORDER_CONFIG.DESCRIPTION_MAX_LENGTH} characters`,
} as const;
