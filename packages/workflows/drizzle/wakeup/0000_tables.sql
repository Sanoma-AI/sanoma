CREATE TABLE "sanoma_wakeup_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sanoma_wakeup_accounts_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sanoma_wakeup_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"url" text NOT NULL,
	"token_hash" text NOT NULL,
	"at" timestamp with time zone,
	"called_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sanoma_wakeup_instances_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "sanoma_wakeup_instances" ADD CONSTRAINT "sanoma_wakeup_instances_account_id_sanoma_wakeup_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sanoma_wakeup_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sanoma_wakeup_instances_at" ON "sanoma_wakeup_instances" USING btree ("at") WHERE "sanoma_wakeup_instances"."at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sanoma_wakeup_instances_account" ON "sanoma_wakeup_instances" USING btree ("account_id");