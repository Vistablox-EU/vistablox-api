-- Device binding (DPoP-style proof of possession) for customer sessions.
-- A session is "bound" once dpopJkt is set; enforcement is conditional on
-- that (Phase 1: bind when a valid proof is presented at creation, enforce
-- only for bound sessions). Unqualified/no schema prefix to match every
-- other column on this table -- auth_session itself is a pre-existing,
-- separately-tracked issue (it lives in the default "public" schema, not
-- "auth"), not something this migration changes.
ALTER TABLE "auth_session" ADD COLUMN "dpopJkt" TEXT;

-- Replay protection for DPoP proofs: one row per (jkt, jti) pair actually
-- seen. New infrastructure, so -- unlike auth_session -- it goes in the
-- "auth" schema properly from the start.
CREATE TABLE "auth"."dpop_replays" (
  "jkt" TEXT NOT NULL,
  "jti" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "dpop_replays_pkey" PRIMARY KEY ("jkt", "jti")
);

CREATE INDEX "idx_dpop_replays_expires_at" ON "auth"."dpop_replays" ("expires_at");
