ALTER TABLE "accounts" ADD CONSTRAINT "accounts_provider_valid_chk" CHECK ("accounts"."provider" IN ('local', 'google'));--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_status_valid_chk" CHECK ("idempotency_keys"."status" IN ('IN_PROGRESS', 'COMPLETED'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_valid_chk" CHECK ("orders"."status" IN ('PENDING', 'PAID', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_valid_chk" CHECK ("payments"."status" IN ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid_chk" CHECK ("users"."role" IN ('user', 'admin'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_valid_chk" CHECK ("users"."status" IN ('active', 'inactive', 'suspended'));