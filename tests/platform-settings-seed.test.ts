import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

// Guards a bug class that unit tests with fake repositories cannot see: code
// that reads a platform.settings row and throws when it is absent, against a
// database built purely from migrations. The intake module did exactly that
// after the origination -> intake rename (the code read intake.* keys, the
// migrations only seeded origination.*), and CI stayed green because no
// real-database test read those settings.
//
// What this does and does not prove. It is a text scan: cheap, runs with the
// unit tests (no database), and fails the moment a literal-keyed read has no
// matching seed. It cannot prove the rows exist -- a conditional
// INSERT ... SELECT counts as a seed here, and an UPDATE-based rename or a
// `DELETE ... LIKE` in a future migration would be misread. The real proof is
// the integration test that reads the migrated defaults from a database built
// by the actual migrations (staff-intake-case-repository.integration.test.ts).
//
// Scope, deliberately narrow: only reads whose key is a string literal and
// whose call has `where: { key: "..." }` first. Rows created at runtime (the
// wallet-registry block cursor is upserted by the worker and read with a null
// fallback) are not seed-dependent; their key is a named constant, and their
// file is allowlisted below. The final test makes any other way of reading a
// setting fail loudly instead of being skipped silently.

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const migrationsRoot = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));

const SETTING_READ =
  /platformSetting\s*\.\s*(?:findUnique|findUniqueOrThrow|findFirst)\s*\(\s*\{\s*where:\s*\{\s*key:\s*"([^"]+)"/g;
const ANY_SETTING_LOOKUP = /platformSetting\s*\.\s*find\w*\s*\(/g;
const INSERT_STATEMENT = /INSERT\s+INTO\s+"platform"\."settings"[^;]*;/gi;
const DELETE_STATEMENT = /DELETE\s+FROM\s+"platform"\."settings"[^;]*;/gi;

// Files whose platformSetting lookups are runtime-written rows with a null
// fallback rather than seed-dependent reads (paths relative to src/, posix).
const RUNTIME_WRITTEN_SETTING_FILES = new Set(["modules/settlement/repository/prisma-settlement.repository.ts"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) => !entry.split(/[\\/]/).includes("generated"))
    .map((entry) => join(directory, entry));
}

function settingKeysReadBySource(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(sourceRoot)) {
    for (const match of readFileSync(file, "utf8").matchAll(SETTING_READ)) {
      if (match[1] !== undefined) keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

interface Migration {
  name: string;
  sql: string;
}

function migrationsInOrder(): Migration[] {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8") }));
}

function lastMigrationIndexMentioning(migrations: Migration[], statement: RegExp, key: string): number {
  let last = -1;
  migrations.forEach((migration, index) => {
    for (const match of migration.sql.matchAll(statement)) {
      if (match[0].includes(`'${key}'`)) last = index;
    }
  });
  return last;
}

// A key survives the migration history when some migration inserts it and no
// migration at or after that point deletes it.
function keysNotSeededByMigrations(keys: string[], migrations: Migration[]): string[] {
  return keys.filter((key) => {
    const inserted = lastMigrationIndexMentioning(migrations, INSERT_STATEMENT, key);
    const deleted = lastMigrationIndexMentioning(migrations, DELETE_STATEMENT, key);
    return inserted === -1 || deleted >= inserted;
  });
}

describe("platform.settings seeding", () => {
  it("is inserted by a migration (and not later deleted) for every setting the source reads by literal key", () => {
    const keys = settingKeysReadBySource();

    // Not vacuous: the scan must actually be finding the known readers.
    expect(keys).toEqual(
      expect.arrayContaining([
        "identity.kyc_renewal_reminder_lead_days",
        "intake.applicant_response_window_business_days",
        "intake.information_request_reminder_business_days",
        "intake.minimum_property_value_eur",
        "offering.reconfirmation_reminder_interval_hours",
      ]),
    );

    expect(keysNotSeededByMigrations(keys, migrationsInOrder())).toEqual([]);
  });

  it("recognises every platform setting lookup in src, so an unparsed form fails loudly instead of being skipped", () => {
    const unrecognised: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const path = relative(sourceRoot, file).split(sep).join("/");
      if (RUNTIME_WRITTEN_SETTING_FILES.has(path)) continue;
      const text = readFileSync(file, "utf8");
      const lookups = [...text.matchAll(ANY_SETTING_LOOKUP)].length;
      const recognised = [...text.matchAll(SETTING_READ)].length;
      if (lookups !== recognised) {
        unrecognised.push(`${path}: ${lookups} platformSetting lookup(s), ${recognised} recognised by the guard`);
      }
    }

    expect(unrecognised).toEqual([]);
  });

  it("would have flagged the origination -> intake rename gap", () => {
    const beforeTheFix = migrationsInOrder().filter(
      (migration) => !migration.name.endsWith("rename_origination_platform_settings_to_intake"),
    );

    expect(keysNotSeededByMigrations(["intake.minimum_property_value_eur"], beforeTheFix)).toEqual([
      "intake.minimum_property_value_eur",
    ]);
  });

  it("treats a seeded key that a later migration deletes as missing", () => {
    const migrations: Migration[] = [
      {
        name: "001_seed",
        sql: `INSERT INTO "platform"."settings" ("setting_key","value","description") VALUES ('a.b', '1'::jsonb, 'x');`,
      },
      { name: "002_drop", sql: `DELETE FROM "platform"."settings" WHERE "setting_key" IN ('a.b');` },
    ];

    expect(keysNotSeededByMigrations(["a.b"], migrations)).toEqual(["a.b"]);
    expect(keysNotSeededByMigrations(["a.b"], migrations.slice(0, 1))).toEqual([]);
  });
});
