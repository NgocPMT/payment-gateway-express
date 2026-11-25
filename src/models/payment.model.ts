import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

import { orders } from './order.model.js';

const PAYMENT_LINK_ID_MAX_LENGTH = 255;
const STATUS_MAX_LENGTH = 20;

export const paymentStatuses = ['PENDING', 'PAID', 'CANCELLED', 'EXPIRED'] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const payments = pgTable(
  'payments',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    orderCode: bigint('order_code', { mode: 'number' }).notNull().unique(),
    paymentLinkId: varchar('payment_link_id', { length: PAYMENT_LINK_ID_MAX_LENGTH }).notNull(),
    checkoutUrl: text('checkout_url').notNull(),
    qrCode: text('qr_code').notNull(),
    amount: integer('amount').notNull(),
    status: varchar('status', { length: STATUS_MAX_LENGTH }).$type<PaymentStatus>().notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('payments_amount_positive_chk', sql`${table.amount} > 0`),
    check('payments_order_code_positive_chk', sql`${table.orderCode} > 0`),
    uniqueIndex('payments_one_pending_per_order_idx')
      .on(table.orderId)
      .where(sql`${table.status} = 'PENDING'`),
    index('payments_order_id_idx').on(table.orderId),
    index('payments_status_idx').on(table.status),
  ],
);

export type PaymentRecord = typeof payments.$inferSelect;
export type NewPaymentRecord = typeof payments.$inferInsert;
