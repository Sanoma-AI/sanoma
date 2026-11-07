CREATE TABLE "sanoma_app_behind" (
	"folder" text PRIMARY KEY NOT NULL,
	"behind" integer,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sanoma_app_behind_one_answer" CHECK (("sanoma_app_behind"."behind" IS NULL) <> ("sanoma_app_behind"."error" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sanoma_chat_chunks" (
	"chat_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"chunk" jsonb,
	CONSTRAINT "sanoma_chat_chunks_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sanoma_run_checks" (
	"run_id" text PRIMARY KEY NOT NULL,
	"checks" jsonb,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sanoma_run_checks_one_answer" CHECK (("sanoma_run_checks"."checks" IS NULL) <> ("sanoma_run_checks"."error" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sanoma_chats" ADD COLUMN "turn" text;--> statement-breakpoint
ALTER TABLE "sanoma_chat_chunks" ADD CONSTRAINT "sanoma_chat_chunks_chat_id_sanoma_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."sanoma_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sanoma_chat_chunks_chat" ON "sanoma_chat_chunks" USING btree ("chat_id");