import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

import { users } from './user.model.js';

const DESCRIPTION_MAX_LENGTH = 255;
const STATUS_MAX_LENGTH = 20;

export const orderStatuses = ['PENDING', 'PAID', 'CANCELLED'] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const orders = pgTable(
  'orders',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amount: integer('amount').notNull(),
    description: varchar('description', { length: DESCRIPTION_MAX_LENGTH }).notNull(),
    status: varchar('status', { length: STATUS_MAX_LENGTH }).$type<OrderStatus>().notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('orders_amount_positive_chk', sql`${table.amount} > 0`),
    check(
      'orders_status_valid_chk',
      sql`${table.status} IN (${sql.join(
        orderStatuses.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )})`,
    ),
    index('orders_user_id_created_at_idx').on(table.userId, table.createdAt),
    index('orders_status_idx').on(table.status),
  ],
);

export type OrderRecord = typeof orders.$inferSelect;
export type NewOrderRecord = typeof orders.$inferInsert;
