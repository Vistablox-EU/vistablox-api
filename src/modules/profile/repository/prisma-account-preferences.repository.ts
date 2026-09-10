import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import {
  defaultAccountPreferences,
  type AccountPreferencesRepository,
  type AccountPreferencesSnapshot,
} from "./account-preferences.repository.js";

export class PrismaAccountPreferencesRepository implements AccountPreferencesRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async update(
    accountId: string,
    patch: Partial<AccountPreferencesSnapshot>,
  ): Promise<AccountPreferencesSnapshot> {
    return this.database.accountPreferences.upsert({
      where: { accountId },
      create: { accountId, ...defaultAccountPreferences, ...patch },
      update: patch,
      select: {
        dealAlertsEmail: true,
        statementsEmail: true,
        marketingEmail: true,
        locale: true,
        timezone: true,
      },
    });
  }
}
