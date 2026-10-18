-- A reservation request may finish after the mobile connection drops. Keep a
-- caller-generated key on the reservation itself so a retry cannot create a
-- second capacity hold. PostgreSQL permits multiple NULLs in this unique
-- constraint, preserving the invariant for internal/non-client callers.
ALTER TABLE offering.reservations
  ADD COLUMN client_idempotency_key text;

CREATE UNIQUE INDEX uq_reservations_account_offering_client_key
  ON offering.reservations (account_id, offering_id, client_idempotency_key);
