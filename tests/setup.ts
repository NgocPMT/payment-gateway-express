// Global test setup for environment variables needed by config/env
process.env.PORT ??= '3000';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/express_template_test';
process.env.JWT_ACCESS_SECRET ??= 'test-jwt-access-secret-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET ??= 'test-jwt-refresh-secret-at-least-32-chars-long';
process.env.JWT_ACCESS_EXPIRES_IN ??= '15m';
process.env.JWT_REFRESH_EXPIRES_IN ??= '7d';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.PAYOS_MOCK_MODE ??= 'true';
process.env.PAYOS_CHECKSUM_KEY ??= 'test-payos-checksum-key-16-chars';

import '../src/openapi/zod.js';
