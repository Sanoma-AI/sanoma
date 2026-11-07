CREATE TABLE "sanoma_connection_renewals" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"holder" text,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"outcome" text,
	"due_at" timestamp with time zone
);
