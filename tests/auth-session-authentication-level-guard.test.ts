import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AUTHENTICATION_LEVELS } from "../src/modules/auth/infrastructure/better-auth.factory.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(PROJECT_ROOT, "prisma", "migrations");
const CONSTRAINT_NAME = "auth_session_authentication_level_check";

/**
 * #54 introduced authenticationLevel = "device_biometric" in code with no
 * migration ever widening auth_session's CHECK constraint to allow it --
 * every real E2/L2 session creation failed (confirmed live: the Xiaomi
 * enrolment test reached attestation/JWS/challenge/DPoP success and
 * crashed exactly here). This test would have caught that with no
 * database: it finds the latest migration that defines the constraint
 * (migration directories are timestamp-prefixed, so the lexicographically
 * last one wins), parses its CHECK ... IN (...) clause, and asserts it's
 * exactly the set of values AUTHENTICATION_LEVELS (better-auth.factory.ts's
 * own single source of truth for every value the code can write) allows.
 */
function findLatestMigrationDefiningConstraint(): string {
  const migrationDirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const defining = migrationDirs.filter((dir) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
    return sql.includes(CONSTRAINT_NAME);
  });
  if (defining.length === 0) {
    throw new Error(`No migration defines the "${CONSTRAINT_NAME}" constraint`);
  }
  return defining[defining.length - 1]!;
}

function parseCheckInList(migrationDir: string): string[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, migrationDir, "migration.sql"), "utf8");
  const match = /"authenticationLevel"\s+IN\s*\(([^)]+)\)/.exec(sql);
  if (match === null) {
    throw new Error(`Could not find a CHECK ("authenticationLevel" IN (...)) clause in ${migrationDir}`);
  }
  return match[1]!
    .split(",")
    .map((value) => value.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

describe("auth_session.authenticationLevel: code vs. the latest migration's CHECK constraint", () => {
  it("the constraint allows exactly the values AUTHENTICATION_LEVELS says the code can write -- no more, no less", () => {
    const latestMigration = findLatestMigrationDefiningConstraint();
    const constraintValues = parseCheckInList(latestMigration);

    expect(new Set(constraintValues)).toEqual(new Set(AUTHENTICATION_LEVELS));
  });
});
