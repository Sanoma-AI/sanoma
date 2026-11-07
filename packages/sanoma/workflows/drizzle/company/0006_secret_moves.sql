CREATE TABLE "sanoma_secret_move_items" (
	"move_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"management" text NOT NULL,
	"source_path" text NOT NULL,
	"destination_path" text NOT NULL,
	"bytes" integer,
	"action" text NOT NULL,
	"reauthorize" text,
	"source_version" text,
	"destination_version" text,
	"state" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "sanoma_secret_move_items_move_id_name_pk" PRIMARY KEY("move_id","name")
);
--> statement-breakpoint
CREATE TABLE "sanoma_secret_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"destination_name" text NOT NULL,
	"source_store" text NOT NULL,
	"source_namespace" text NOT NULL,
	"destination_store" text NOT NULL,
	"destination_namespace" text NOT NULL,
	"phase" text NOT NULL,
	"fenced" boolean DEFAULT false NOT NULL,
	"retain_hours" integer NOT NULL,
	"started_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cutover_at" timestamp with time zone,
	"retain_until" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "sanoma_secret_moves_source" ON "sanoma_secret_moves" USING btree ("source_store","source_namespace");