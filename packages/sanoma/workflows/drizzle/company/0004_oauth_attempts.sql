CREATE TABLE "sanoma_connection_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"request_id" text NOT NULL,
	"principal" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier" text,
	"code" text,
	"outcome" text,
	"expires_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sanoma_connection_health" ADD COLUMN "expires_at" timestamp with time zone;