ALTER TABLE "mail0_connection" ADD COLUMN "imap_host" text;--> statement-breakpoint
ALTER TABLE "mail0_connection" ADD COLUMN "imap_port" integer;--> statement-breakpoint
ALTER TABLE "mail0_connection" ADD COLUMN "imap_secure" boolean;--> statement-breakpoint
ALTER TABLE "mail0_connection" ADD COLUMN "smtp_host" text;--> statement-breakpoint
ALTER TABLE "mail0_connection" ADD COLUMN "smtp_port" integer;--> statement-breakpoint
ALTER TABLE "mail0_connection" ADD COLUMN "smtp_secure" boolean;--> statement-breakpoint
ALTER TABLE "mail0_connection" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "mail0_connection" ADD COLUMN "password_encrypted" text;
