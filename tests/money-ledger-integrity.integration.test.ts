import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;

// money.money_events is append-only (LEDGER_DESIGN.md: "never UPDATE or DELETE
// a money_events row"), and the money/offering/settlement tables around it
// carry the amount and vocabulary CHECKs the record and the code agree on.
//
// Every statement below runs inside a transaction that is rolled back. That
// is deliberate: the trigger under test makes any committed money_events row
// permanently undeletable (and, through the foreign keys, its reservation,
// offering, account and so on), so a test that committed its fixtures would
// leave them behind forever. Rolling back leaves nothing behind and proves
// the same thing, because the trigger and the constraints fire identically
// inside a transaction. A SAVEPOINT around each attempted statement lets one
// transaction observe several rejections and still read the row afterwards.

interface Rejection {
  code: string | undefined;
  constraint: string | undefined;
  message: string;
}

interface Fixture {
  accountId: string;
  pivId: string;
  offeringId: string;
  reservationId: string;
  moneyEventId: string;
  positionId: string;
}

const CHECK_VIOLATION = "23514";
const INTEGRITY_CONSTRAINT_VIOLATION = "23000";

describe.skipIf(databaseUrl === undefined)("money ledger database invariants PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  async function inRolledBackTransaction(run: (client: PoolClient, fixture: Fixture) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await run(client, await insertFixture(client));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function insertFixture(client: PoolClient): Promise<Fixture> {
    const suffix = randomUUID();
    const authUserId = `auth_${suffix}`;
    const propertyId = `property_${suffix}`;
    const caseId = `case_${suffix}`;
    const fixture: Fixture = {
      accountId: `account_${suffix}`,
      pivId: `piv_${suffix}`,
      offeringId: `offering_${suffix}`,
      reservationId: `reservation_${suffix}`,
      moneyEventId: `money_event_${suffix}`,
      positionId: `position_${suffix}`,
    };
    await client.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, true, \'customer\')',
      [authUserId, "Money Ledger Invariants", `money-ledger-${suffix}@example.test`],
    );
    await client.query("INSERT INTO account.accounts (account_id, better_auth_user_id) VALUES ($1, $2)", [
      fixture.accountId,
      authUserId,
    ]);
    await client.query(
      "INSERT INTO intake.properties (property_id, country_code, owner_declared_value_eur) VALUES ($1, 'DE', 600000.00)",
      [propertyId],
    );
    await client.query(
      "INSERT INTO intake.intake_cases (case_id, property_id, applicant_account_id) VALUES ($1, $2, $3)",
      [caseId, propertyId, fixture.accountId],
    );
    await client.query("INSERT INTO intake.pivs (piv_id, property_id, case_id) VALUES ($1, $2, $3)", [
      fixture.pivId,
      propertyId,
      caseId,
    ]);
    await client.query(
      "INSERT INTO offering.offerings (offering_id, piv_id, minimum_raise_eur, target_raise_eur) VALUES ($1, $2, 250000.00, 500000.00)",
      [fixture.offeringId, fixture.pivId],
    );
    await client.query(
      "INSERT INTO offering.reservations (reservation_id, offering_id, account_id, amount_eur) VALUES ($1, $2, $3, 100.00)",
      [fixture.reservationId, fixture.offeringId, fixture.accountId],
    );
    await client.query(
      `INSERT INTO money.money_events
         (money_event_id, reservation_id, provider, provider_reference, capital_state, amount_eur, recorded_at)
       VALUES ($1, $2, 'coinbase_cdp', 'provider_ref_1', 'eurc_purchase_pending', 100.00, '2026-09-02T13:00:00Z')`,
      [fixture.moneyEventId, fixture.reservationId],
    );
    await client.query(
      `INSERT INTO settlement.position_ledger (position_id, reservation_id, piv_id, account_id, unit_count, cost_basis_eur)
       VALUES ($1, $2, $3, $4, 100.000000, 100.00)`,
      [fixture.positionId, fixture.reservationId, fixture.pivId, fixture.accountId],
    );
    return fixture;
  }

  /** Runs one statement under a savepoint; null when it succeeded, the database error when it did not. */
  async function attempt(client: PoolClient, sql: string, params: unknown[] = []): Promise<Rejection | null> {
    await client.query("SAVEPOINT attempt");
    try {
      await client.query(sql, params);
      await client.query("RELEASE SAVEPOINT attempt");
      return null;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT attempt");
      const { code, constraint, message } = error as { code?: string; constraint?: string; message: string };
      return { code, constraint, message };
    }
  }

  function insertMoneyEvent(
    client: PoolClient,
    fixture: Fixture,
    values: { capitalState?: string; amountEur?: string; amountEurc?: string | null },
  ): Promise<Rejection | null> {
    return attempt(
      client,
      `INSERT INTO money.money_events
         (money_event_id, reservation_id, provider, capital_state, amount_eur, amount_eurc)
       VALUES ($1, $2, 'coinbase_cdp', $3, $4, $5)`,
      [
        `money_event_${randomUUID()}`,
        fixture.reservationId,
        values.capitalState ?? "eurc_purchase_pending",
        values.amountEur ?? "100.00",
        values.amountEurc ?? null,
      ],
    );
  }

  function insertReservation(client: PoolClient, fixture: Fixture, amountEur: string): Promise<Rejection | null> {
    return attempt(
      client,
      "INSERT INTO offering.reservations (reservation_id, offering_id, account_id, amount_eur) VALUES ($1, $2, $3, $4)",
      [`reservation_${randomUUID()}`, fixture.offeringId, fixture.accountId, amountEur],
    );
  }

  function insertOffering(
    client: PoolClient,
    fixture: Fixture,
    values: { status?: string; minimumRaiseEur?: string; targetRaiseEur?: string },
  ): Promise<Rejection | null> {
    return attempt(
      client,
      `INSERT INTO offering.offerings (offering_id, piv_id, minimum_raise_eur, target_raise_eur, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `offering_${randomUUID()}`,
        fixture.pivId,
        values.minimumRaiseEur ?? "250000.00",
        values.targetRaiseEur ?? "500000.00",
        values.status ?? "pre_offering",
      ],
    );
  }

  function insertPosition(
    client: PoolClient,
    fixture: Fixture,
    values: { positionStatus?: string; unitCount?: string; costBasisEur?: string },
  ): Promise<Rejection | null> {
    return attempt(
      client,
      `INSERT INTO settlement.position_ledger
         (position_id, reservation_id, piv_id, account_id, unit_count, cost_basis_eur, position_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `position_${randomUUID()}`,
        fixture.reservationId,
        fixture.pivId,
        fixture.accountId,
        values.unitCount ?? "50.000000",
        values.costBasisEur ?? "50.00",
        values.positionStatus ?? "pending_internal_settlement",
      ],
    );
  }

  async function readMoneyEvent(client: PoolClient, moneyEventId: string): Promise<Record<string, unknown> | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT provider, provider_reference, capital_state, amount_eur::text AS amount_eur,
              amount_eurc::text AS amount_eurc, recorded_at, reconciled_at
       FROM money.money_events WHERE money_event_id = $1`,
      [moneyEventId],
    );
    return result.rows[0];
  }

  describe("money.money_events is append-only", () => {
    it("still accepts new events, with and without an EURC amount, for the states the application writes", async () => {
      await inRolledBackTransaction(async (client, fixture) => {
        for (const capitalState of [
          "initiated",
          "eurc_purchase_pending",
          "purchase_failed",
          "reconfirmation_pending",
          "eurc_finalized",
        ]) {
          expect(await insertMoneyEvent(client, fixture, { capitalState }), capitalState).toBeNull();
        }
        expect(await insertMoneyEvent(client, fixture, { amountEurc: "98.250000" })).toBeNull();
        const count = await client.query<{ count: string }>(
          "SELECT count(*) FROM money.money_events WHERE reservation_id = $1",
          [fixture.reservationId],
        );
        expect(count.rows[0]?.count).toBe("7");
      });
    });

    it.each([
      ["capital_state", "capital_state = 'eurc_finalized'"],
      ["amount_eur", "amount_eur = 999.00"],
      ["amount_eurc", "amount_eurc = 1.000000"],
      ["provider", "provider = 'rewritten'"],
      ["provider_reference", "provider_reference = 'rewritten'"],
      ["recorded_at", "recorded_at = now()"],
      // The design record also says reconciliation marks rows in place
      // (RECONCILIATION.md), which contradicts "never UPDATE". Nothing in the
      // application writes reconciled_at, so the table rejects it too until
      // that conflict is decided; see the migration comment.
      ["reconciled_at", "reconciled_at = now()"],
      ["nothing (a no-op assignment)", "capital_state = capital_state"],
    ])("rejects an UPDATE of %s and leaves the row as written", async (_label, assignment) => {
      await inRolledBackTransaction(async (client, fixture) => {
        const before = await readMoneyEvent(client, fixture.moneyEventId);
        expect(before).toMatchObject({ capital_state: "eurc_purchase_pending", amount_eur: "100.00" });

        const rejection = await attempt(
          client,
          `UPDATE money.money_events SET ${assignment} WHERE money_event_id = $1`,
          [fixture.moneyEventId],
        );

        expect(rejection).toMatchObject({
          code: INTEGRITY_CONSTRAINT_VIOLATION,
          message: expect.stringContaining("append-only"),
        });
        expect(await readMoneyEvent(client, fixture.moneyEventId)).toEqual(before);
      });
    });

    it("rejects an UPDATE that matches several rows without changing any of them", async () => {
      await inRolledBackTransaction(async (client, fixture) => {
        expect(await insertMoneyEvent(client, fixture, { capitalState: "purchase_failed" })).toBeNull();

        const rejection = await attempt(
          client,
          "UPDATE money.money_events SET amount_eur = 1.00 WHERE reservation_id = $1",
          [fixture.reservationId],
        );

        expect(rejection).toMatchObject({ code: INTEGRITY_CONSTRAINT_VIOLATION });
        const amounts = await client.query<{ amount_eur: string }>(
          "SELECT amount_eur::text AS amount_eur FROM money.money_events WHERE reservation_id = $1",
          [fixture.reservationId],
        );
        expect(amounts.rows).toEqual([{ amount_eur: "100.00" }, { amount_eur: "100.00" }]);
      });
    });

    it("rejects a DELETE of a single event and of every event for a reservation", async () => {
      await inRolledBackTransaction(async (client, fixture) => {
        expect(await insertMoneyEvent(client, fixture, { capitalState: "purchase_failed" })).toBeNull();

        const single = await attempt(client, "DELETE FROM money.money_events WHERE money_event_id = $1", [
          fixture.moneyEventId,
        ]);
        const all = await attempt(client, "DELETE FROM money.money_events WHERE reservation_id = $1", [
          fixture.reservationId,
        ]);

        expect(single).toMatchObject({
          code: INTEGRITY_CONSTRAINT_VIOLATION,
          message: expect.stringContaining("append-only"),
        });
        expect(all).toMatchObject({
          code: INTEGRITY_CONSTRAINT_VIOLATION,
          message: expect.stringContaining("append-only"),
        });
        const count = await client.query<{ count: string }>(
          "SELECT count(*) FROM money.money_events WHERE reservation_id = $1",
          [fixture.reservationId],
        );
        expect(count.rows[0]?.count).toBe("2");
      });
    });

    it("does not let the reservation id be rewritten underneath the ledger through the ON UPDATE CASCADE key", async () => {
      await inRolledBackTransaction(async (client, fixture) => {
        const rejection = await attempt(
          client,
          "UPDATE offering.reservations SET reservation_id = $2 WHERE reservation_id = $1",
          [fixture.reservationId, `renamed_${randomUUID()}`],
        );

        expect(rejection).toMatchObject({
          code: INTEGRITY_CONSTRAINT_VIOLATION,
          message: expect.stringContaining("append-only"),
        });
      });
    });

    it("leaves the mutable money-adjacent tables mutable (reservations, offerings and positions are updated in place)", async () => {
      await inRolledBackTransaction(async (client, fixture) => {
        expect(
          await attempt(client, "UPDATE offering.reservations SET reservation_stage = 'lapsed' WHERE reservation_id = $1", [
            fixture.reservationId,
          ]),
        ).toBeNull();
        expect(
          await attempt(client, "UPDATE offering.offerings SET status = 'final_offering' WHERE offering_id = $1", [
            fixture.offeringId,
          ]),
        ).toBeNull();
        expect(
          await attempt(
            client,
            "UPDATE settlement.position_ledger SET position_status = 'active', activated_at = now() WHERE position_id = $1",
            [fixture.positionId],
          ),
        ).toBeNull();
        expect(
          await attempt(client, "DELETE FROM settlement.position_ledger WHERE position_id = $1", [fixture.positionId]),
        ).toBeNull();
      });
    });
  });

  describe("amount and vocabulary CHECK constraints", () => {
    describe("money.money_events", () => {
      it.each(["0", "0.00", "0.004", "-0.01", "-100"])(
        "rejects amount_eur %s",
        async (amountEur) => {
          await inRolledBackTransaction(async (client, fixture) => {
            expect(await insertMoneyEvent(client, fixture, { amountEur })).toMatchObject({
              code: CHECK_VIOLATION,
              constraint: "money_events_amount_eur_positive_check",
            });
          });
        },
      );

      it.each(["0.01", "100", "15000.50"])("accepts amount_eur %s", async (amountEur) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertMoneyEvent(client, fixture, { amountEur })).toBeNull();
        });
      });

      it.each(["0", "0.000000", "-0.000001", "-98.25"])("rejects amount_eurc %s", async (amountEurc) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertMoneyEvent(client, fixture, { amountEurc })).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "money_events_amount_eurc_positive_check",
          });
        });
      });

      it.each([null, "0.000001", "98.250000"])("accepts amount_eurc %s", async (amountEurc) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertMoneyEvent(client, fixture, { amountEurc })).toBeNull();
        });
      });
    });

    describe("offering.reservations", () => {
      it.each(["0", "0.00", "-0.01", "-1000"])("rejects amount_eur %s on insert", async (amountEur) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertReservation(client, fixture, amountEur)).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "reservations_amount_eur_positive_check",
          });
        });
      });

      it("accepts the smallest positive amount_eur", async () => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertReservation(client, fixture, "0.01")).toBeNull();
        });
      });

      it("rejects an UPDATE that would zero or negate an existing reservation amount", async () => {
        await inRolledBackTransaction(async (client, fixture) => {
          for (const amountEur of ["0", "-5.00"]) {
            expect(
              await attempt(client, "UPDATE offering.reservations SET amount_eur = $2 WHERE reservation_id = $1", [
                fixture.reservationId,
                amountEur,
              ]),
            ).toMatchObject({ code: CHECK_VIOLATION, constraint: "reservations_amount_eur_positive_check" });
          }
        });
      });
    });

    describe("offering.offerings", () => {
      it.each(["draft", "open", "Pre_Offering", "FINAL_OFFERING", ""])("rejects status %j on insert", async (status) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertOffering(client, fixture, { status })).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "offerings_status_check",
          });
        });
      });

      it.each(["pre_offering", "final_offering", "closed"])("accepts status %s", async (status) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertOffering(client, fixture, { status })).toBeNull();
        });
      });

      it("rejects an UPDATE to an unknown status", async () => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(
            await attempt(client, "UPDATE offering.offerings SET status = 'eurc_reserved' WHERE offering_id = $1", [
              fixture.offeringId,
            ]),
          ).toMatchObject({ code: CHECK_VIOLATION, constraint: "offerings_status_check" });
        });
      });

      it.each(["0", "-1.00"])("rejects minimum_raise_eur %s", async (minimumRaiseEur) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertOffering(client, fixture, { minimumRaiseEur })).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "offerings_minimum_raise_eur_positive_check",
          });
          expect(
            await attempt(client, "UPDATE offering.offerings SET minimum_raise_eur = $2 WHERE offering_id = $1", [
              fixture.offeringId,
              minimumRaiseEur,
            ]),
          ).toMatchObject({ code: CHECK_VIOLATION, constraint: "offerings_minimum_raise_eur_positive_check" });
        });
      });

      it.each(["0", "-1.00"])("rejects target_raise_eur %s", async (targetRaiseEur) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertOffering(client, fixture, { targetRaiseEur })).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "offerings_target_raise_eur_positive_check",
          });
          expect(
            await attempt(client, "UPDATE offering.offerings SET target_raise_eur = $2 WHERE offering_id = $1", [
              fixture.offeringId,
              targetRaiseEur,
            ]),
          ).toMatchObject({ code: CHECK_VIOLATION, constraint: "offerings_target_raise_eur_positive_check" });
        });
      });

      it("accepts a target equal to, or different from, the minimum (the record does not order them)", async () => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertOffering(client, fixture, { minimumRaiseEur: "1.00", targetRaiseEur: "1.00" })).toBeNull();
          expect(await insertOffering(client, fixture, { minimumRaiseEur: "500.00", targetRaiseEur: "100.00" })).toBeNull();
        });
      });
    });

    describe("settlement.position_ledger", () => {
      it.each(["settled", "ACTIVE", "pending", ""])("rejects position_status %j on insert", async (positionStatus) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertPosition(client, fixture, { positionStatus })).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "position_ledger_position_status_check",
          });
        });
      });

      it.each(["pending_internal_settlement", "active", "redeemed"])("accepts position_status %s", async (positionStatus) => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertPosition(client, fixture, { positionStatus })).toBeNull();
        });
      });

      it("rejects an UPDATE to an unknown position_status", async () => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(
            await attempt(client, "UPDATE settlement.position_ledger SET position_status = 'closed' WHERE position_id = $1", [
              fixture.positionId,
            ]),
          ).toMatchObject({ code: CHECK_VIOLATION, constraint: "position_ledger_position_status_check" });
        });
      });

      it("rejects a negative unit_count but accepts zero (a fully reduced retained position is not ruled out by the record)", async () => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertPosition(client, fixture, { unitCount: "-0.000001" })).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "position_ledger_unit_count_non_negative_check",
          });
          expect(
            await attempt(client, "UPDATE settlement.position_ledger SET unit_count = -1 WHERE position_id = $1", [
              fixture.positionId,
            ]),
          ).toMatchObject({ code: CHECK_VIOLATION, constraint: "position_ledger_unit_count_non_negative_check" });
          expect(await insertPosition(client, fixture, { unitCount: "0" })).toBeNull();
        });
      });

      it("rejects a negative cost_basis_eur but accepts zero (the owner-retained basis is undecided)", async () => {
        await inRolledBackTransaction(async (client, fixture) => {
          expect(await insertPosition(client, fixture, { costBasisEur: "-0.01" })).toMatchObject({
            code: CHECK_VIOLATION,
            constraint: "position_ledger_cost_basis_eur_non_negative_check",
          });
          expect(
            await attempt(client, "UPDATE settlement.position_ledger SET cost_basis_eur = -1 WHERE position_id = $1", [
              fixture.positionId,
            ]),
          ).toMatchObject({ code: CHECK_VIOLATION, constraint: "position_ledger_cost_basis_eur_non_negative_check" });
          expect(await insertPosition(client, fixture, { costBasisEur: "0" })).toBeNull();
        });
      });
    });
  });
});
