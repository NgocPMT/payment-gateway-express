import { z } from 'zod';

import { TIME_MS, TIME_SECONDS } from '../shared/constants/time.js';

const PORT_MAX_LIMIT = 65_535;
const DEFAULT_PORT = 3000;
const JWT_SECRET_MIN_LENGTH = 32;
const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS = TIME_MS.ONE_MINUTE;
const DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const DEFAULT_REGISTER_RATE_LIMIT_WINDOW_SECONDS = TIME_SECONDS.FIFTEEN_MINUTES;
const DEFAULT_REGISTER_RATE_LIMIT_MAX_ATTEMPTS = 3;
const PAYOS_CHECKSUM_KEY_MIN_LENGTH = 16;

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(PORT_MAX_LIMIT).default(DEFAULT_PORT),
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
    JWT_ACCESS_SECRET: z.string().min(JWT_SECRET_MIN_LENGTH, `JWT_ACCESS_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters`),
    JWT_REFRESH_SECRET: z.string().min(JWT_SECRET_MIN_LENGTH, `JWT_REFRESH_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters`),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    OPENAPI_SERVER_URL: z.string().url().optional(),
    CORS_ORIGIN: z.string().optional(),
    REDIS_URL: z.string().url().optional(),
    LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS),
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS),
    REGISTER_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(DEFAULT_REGISTER_RATE_LIMIT_WINDOW_SECONDS),
    REGISTER_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(DEFAULT_REGISTER_RATE_LIMIT_MAX_ATTEMPTS),
    PAYOS_MOCK_MODE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    PAYOS_CLIENT_ID: z.string().optional(),
    PAYOS_API_KEY: z.string().optional(),
    PAYOS_CHECKSUM_KEY: z
      .string()
      .min(PAYOS_CHECKSUM_KEY_MIN_LENGTH, `PAYOS_CHECKSUM_KEY must be at least ${PAYOS_CHECKSUM_KEY_MIN_LENGTH} characters`),
    PAYOS_RETURN_URL: z.string().url().default('http://localhost:3000/payment/success'),
    PAYOS_CANCEL_URL: z.string().url().default('http://localhost:3000/payment/cancel'),
  })
  .superRefine((data, ctx) => {
    if (data.PAYOS_MOCK_MODE && !data.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when PAYOS_MOCK_MODE is enabled',
      });
    }

    if (!data.PAYOS_MOCK_MODE) {
      if (!data.PAYOS_CLIENT_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PAYOS_CLIENT_ID'],
          message: 'PAYOS_CLIENT_ID is required when PAYOS_MOCK_MODE is disabled',
        });
      }
      if (!data.PAYOS_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PAYOS_API_KEY'],
          message: 'PAYOS_API_KEY is required when PAYOS_MOCK_MODE is disabled',
        });
      }
    }
  });

export const env = envSchema.parse(process.env);

export type Env = typeof env;
