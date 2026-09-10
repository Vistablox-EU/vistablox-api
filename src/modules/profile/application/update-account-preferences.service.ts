import type {
  AccountPreferencesRepository,
  AccountPreferencesSnapshot,
} from "../repository/account-preferences.repository.js";

export class UpdateAccountPreferencesService {
  public constructor(private readonly repository: AccountPreferencesRepository) {}

  public async execute(accountId: string, patch: Partial<AccountPreferencesSnapshot>) {
    const preferences = await this.repository.update(accountId, patch);
    return { data: toPreferencesPayload(preferences) };
  }
}

export function toPreferencesPayload(preferences: AccountPreferencesSnapshot) {
  return {
    deal_alerts_email: preferences.dealAlertsEmail,
    statements_email: preferences.statementsEmail,
    marketing_email: preferences.marketingEmail,
    locale: preferences.locale,
    timezone: preferences.timezone,
  };
}
