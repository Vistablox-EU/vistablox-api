import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "../src/infrastructure/database/prisma.js";
import { PrismaInvestorActivityRepository } from "../src/modules/investor-activity/repository/prisma-investor-activity.repository.js";

// Prisma returns Decimal columns as objects with toFixed; the repository only
// ever calls that.
const decimal = (value: string) => ({
  toFixed: (digits: number) => Number(value).toFixed(digits),
});

function reservationRow(capitalState: string | null) {
  return {
    id: "reservation_01",
    offeringId: "offering_01",
    amountEur: decimal("1000"),
    reservationStage: "cancelled",
    disclosurePackVersionAtReservation: null,
    reconfirmedAt: null,
    reservationFinalizedAt: null,
    createdAt: new Date("2026-09-16T12:00:00.000Z"),
    offering: {
      status: "pre_offering",
      piv: {
        property: { propertyType: "residential", countryCode: "HR", city: "Zagreb" },
      },
    },
    moneyEvents:
      capitalState === null
        ? []
        : [
            {
              capitalState,
              amountEur: decimal("1000"),
              amountEurc: null,
              recordedAt: new Date("2026-09-16T13:00:00.000Z"),
            },
          ],
  };
}

function repositoryReturning(capitalState: string | null) {
  const database = {
    reservation: {
      findMany: vi.fn().mockResolvedValue([reservationRow(capitalState)]),
    },
  } as unknown as DatabaseClient;
  return new PrismaInvestorActivityRepository(database);
}

function listFor(capitalState: string | null) {
  return repositoryReturning(capitalState).listReservations({
    accountId: "acct_01",
    limit: 20,
  });
}

// Every capitalState literal the development fixture writes. The fixture is a
// script that imports from /app/dist and runs main() on load, so it cannot be
// imported here; its source is read instead. Comparisons such as
// `stage === "cancelled"` are dropped first because the string on the right is
// a reservation stage, not a capital state.
function fixtureCapitalStates(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../tmp/create-dev-intake-fixture.ts", import.meta.url)),
    "utf8",
  );
  const states = new Set<string>();
  for (const match of source.matchAll(/capitalState:\s*([^,}]+)/g)) {
    const expression = (match[1] ?? "").replace(/[=!]==?\s*"[^"]*"/g, "");
    for (const literal of expression.matchAll(/"([^"]+)"/g)) {
      if (literal[1] !== undefined) states.add(literal[1]);
    }
  }
  return [...states];
}

describe("PrismaInvestorActivityRepository.listReservations capital states", () => {
  it("lists a reservation that has no money event", async () => {
    const [record] = await listFor(null);

    expect(record?.latestMoneyEvent).toBeNull();
  });

  it("reads a capital state the record defines", async () => {
    const [record] = await listFor("purchase_failed");

    expect(record?.latestMoneyEvent?.capitalState).toBe("purchase_failed");
  });

  // Strict parsing of money states is intentional (a state the code does not
  // know must be a loud failure, not a guess shown to an investor), so an
  // unrecognised state still fails the read. This pins that against a fix that
  // would swallow the value.
  it("fails closed on a capital state it does not recognise", async () => {
    await expect(listFor("definitely_not_a_capital_state")).rejects.toThrow(
      "Unknown capital state: definitely_not_a_capital_state",
    );
  });

  // GET /v1/investor-profile/reservations returned 500 on staging with
  // "Unknown capital state: eurc_cancelled": the development fixture wrote a
  // state the record does not define, and one such row fails the whole list.
  it("reads every capital state the development fixture writes", async () => {
    const states = fixtureCapitalStates();

    // Guards against the scan going blind (a restructured fixture) and
    // passing without checking anything.
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      await expect(listFor(state), `fixture writes capital state ${state}`).resolves.toHaveLength(1);
    }
  });
});
