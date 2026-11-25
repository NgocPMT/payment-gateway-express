import { bigint, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

const REFERENCE_MAX_LENGTH = 255;
const CODE_MAX_LENGTH = 20;

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orderCode: bigint('order_code', { mode: 'number' }).notNull(),
    reference: varchar('reference', { length: REFERENCE_MAX_LENGTH }).notNull(),
    code: varchar('code', { length: CODE_MAX_LENGTH }).notNull(),
    amount: integer('amount').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('webhook_events_order_code_reference_idx').on(table.orderCode, table.reference)],
);

export type WebhookEventRecord = typeof webhookEvents.$inferSelect;
export type NewWebhookEventRecord = typeof webhookEvents.$inferInsert;
