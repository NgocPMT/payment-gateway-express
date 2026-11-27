import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

import { users } from './user.model.js';

const ENDPOINT_MAX_LENGTH = 120;
const KEY_MAX_LENGTH = 128;
const REQUEST_HASH_LENGTH = 64;
const STATUS_MAX_LENGTH = 20;

export const idempotencyStatuses = ['IN_PROGRESS', 'COMPLETED'] as const;
export type IdempotencyStatus = (typeof idempotencyStatuses)[number];

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: varchar('endpoint', { length: ENDPOINT_MAX_LENGTH }).notNull(),
    key: varchar('key', { length: KEY_MAX_LENGTH }).notNull(),
    requestHash: varchar('request_hash', { length: REQUEST_HASH_LENGTH }).notNull(),
    status: varchar('status', { length: STATUS_MAX_LENGTH }).$type<IdempotencyStatus>().notNull().default('IN_PROGRESS'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      'idempotency_keys_status_valid_chk',
      sql`${table.status} IN (${sql.join(
        idempotencyStatuses.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )})`,
    ),
    uniqueIndex('idempotency_keys_user_endpoint_key_idx').on(table.userId, table.endpoint, table.key),
    index('idempotency_keys_expires_at_idx').on(table.expiresAt),
  ],
);

export type IdempotencyKeyRecord = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRecord = typeof idempotencyKeys.$inferInsert;
