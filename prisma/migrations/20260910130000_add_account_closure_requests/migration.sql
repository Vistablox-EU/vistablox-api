CREATE TABLE "auth"."account_closure_requests" (
  "closure_request_id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ,
  "resolved_by" TEXT,
  "resolution_note" TEXT,
  CONSTRAINT "account_closure_requests_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "account_closure_requests_resolved_by_fkey"
    FOREIGN KEY ("resolved_by") REFERENCES "account"."accounts"("account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_closure_requests_account" ON "auth"."account_closure_requests" ("account_id");
