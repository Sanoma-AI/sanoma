CREATE TABLE "sanoma_token_handoffs" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"store" text NOT NULL,
	"token_id" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone
);
