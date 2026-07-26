CREATE TABLE "mail0_folder_message" (
	"connection_id" text NOT NULL,
	"folder" text NOT NULL,
	"uid" bigint NOT NULL,
	"thread_id" text NOT NULL,
	"flags" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_folder_message_connection_id_folder_uid_pk" PRIMARY KEY("connection_id","folder","uid")
);
--> statement-breakpoint
ALTER TABLE "mail0_folder_sync_state" ADD COLUMN "sync_mode" text;--> statement-breakpoint
ALTER TABLE "mail0_folder_message" ADD CONSTRAINT "mail0_folder_message_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_message_thread_idx" ON "mail0_folder_message" USING btree ("connection_id","folder","thread_id");