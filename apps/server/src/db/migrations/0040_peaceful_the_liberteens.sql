CREATE TABLE "mail0_chat_message" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail0_connection_label_config" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"labels" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail0_folder_sync_state" (
	"connection_id" text NOT NULL,
	"folder" text NOT NULL,
	"uid_validity" bigint,
	"uid_next" bigint,
	"highest_modseq" text,
	"page_token" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_folder_sync_state_connection_id_folder_pk" PRIMARY KEY("connection_id","folder")
);
--> statement-breakpoint
CREATE TABLE "mail0_label" (
	"connection_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_label_connection_id_id_pk" PRIMARY KEY("connection_id","id")
);
--> statement-breakpoint
CREATE TABLE "mail0_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"send_at" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail0_prompt_override" (
	"connection_id" text NOT NULL,
	"prompt_type" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_prompt_override_connection_id_prompt_type_pk" PRIMARY KEY("connection_id","prompt_type")
);
--> statement-breakpoint
CREATE TABLE "mail0_provider_subscription" (
	"connection_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"subscribed_at" timestamp,
	"history_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_provider_subscription_connection_id_provider_id_pk" PRIMARY KEY("connection_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "mail0_snooze" (
	"connection_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"wake_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_snooze_connection_id_thread_id_pk" PRIMARY KEY("connection_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "mail0_thread" (
	"connection_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"provider_id" text,
	"latest_sender" jsonb,
	"latest_received_on" timestamp,
	"latest_subject" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_thread_connection_id_thread_id_pk" PRIMARY KEY("connection_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "mail0_thread_label" (
	"connection_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"label_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_thread_label_connection_id_thread_id_label_id_pk" PRIMARY KEY("connection_id","thread_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "mail0_chat_message" ADD CONSTRAINT "mail0_chat_message_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_connection_label_config" ADD CONSTRAINT "mail0_connection_label_config_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_folder_sync_state" ADD CONSTRAINT "mail0_folder_sync_state_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_label" ADD CONSTRAINT "mail0_label_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_outbox" ADD CONSTRAINT "mail0_outbox_user_id_mail0_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mail0_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_outbox" ADD CONSTRAINT "mail0_outbox_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_prompt_override" ADD CONSTRAINT "mail0_prompt_override_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_provider_subscription" ADD CONSTRAINT "mail0_provider_subscription_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_snooze" ADD CONSTRAINT "mail0_snooze_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_thread" ADD CONSTRAINT "mail0_thread_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_thread_label" ADD CONSTRAINT "mail0_thread_label_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_message_conn_created_idx" ON "mail0_chat_message" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "label_conn_name_idx" ON "mail0_label" USING btree ("connection_id","name");--> statement-breakpoint
CREATE INDEX "outbox_status_send_at_idx" ON "mail0_outbox" USING btree ("status","send_at");--> statement-breakpoint
CREATE INDEX "outbox_connection_id_idx" ON "mail0_outbox" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "snooze_wake_at_idx" ON "mail0_snooze" USING btree ("wake_at");--> statement-breakpoint
CREATE INDEX "thread_conn_received_idx" ON "mail0_thread" USING btree ("connection_id","latest_received_on");--> statement-breakpoint
CREATE INDEX "thread_label_conn_label_idx" ON "mail0_thread_label" USING btree ("connection_id","label_id");