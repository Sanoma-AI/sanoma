CREATE TABLE "sanoma_api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"subject" text NOT NULL,
	"groups" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sanoma_api_tokens_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "sanoma_chat_messages" (
	"chat_id" text NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"message" jsonb NOT NULL,
	CONSTRAINT "sanoma_chat_messages_chat_id_id_pk" PRIMARY KEY("chat_id","id")
);
--> statement-breakpoint
CREATE TABLE "sanoma_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"person" text NOT NULL,
	"engine" text NOT NULL,
	"draft_id" text,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanoma_connection_health" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"health" text NOT NULL,
	"credential_version" text,
	"externally_renewed" boolean NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanoma_connection_setups" (
	"connection_id" text NOT NULL,
	"revision" text NOT NULL,
	"credential_version" text NOT NULL,
	CONSTRAINT "sanoma_connection_setups_connection_id_revision_pk" PRIMARY KEY("connection_id","revision")
);
--> statement-breakpoint
CREATE TABLE "sanoma_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"method" text NOT NULL,
	"owner" text,
	"rule" text,
	"account" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"revision" text NOT NULL,
	"definition" text NOT NULL,
	"credential" text,
	"location" jsonb,
	"status" text DEFAULT 'connected' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanoma_credentials" (
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"version" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sanoma_credentials_namespace_name_pk" PRIMARY KEY("namespace","name")
);
--> statement-breakpoint
CREATE TABLE "sanoma_data" (
	"collection" text NOT NULL,
	"key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "sanoma_data_collection_key_pk" PRIMARY KEY("collection","key")
);
--> statement-breakpoint
CREATE TABLE "sanoma_invite_requests" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanoma_ledger" (
	"n" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "sanoma_ledger_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "sanoma_wakeup" (
	"id" integer PRIMARY KEY NOT NULL,
	"at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "sanoma_wakeup_one_row" CHECK ("sanoma_wakeup"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "sanoma_chat_messages" ADD CONSTRAINT "sanoma_chat_messages_chat_id_sanoma_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."sanoma_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sanoma_chats_person" ON "sanoma_chats" USING btree ("person","created_at");--> statement-breakpoint
CREATE INDEX "sanoma_ledger_run_seq" ON "sanoma_ledger" USING btree ("run_id","seq","n");