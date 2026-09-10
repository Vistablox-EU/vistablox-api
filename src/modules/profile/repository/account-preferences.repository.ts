export interface AccountPreferencesSnapshot {
  dealAlertsEmail: boolean;
  statementsEmail: boolean;
  marketingEmail: boolean;
  locale: string;
  timezone: string;
}

// The platform is EUR-only end to end (see shared/domain/currency.ts and
// offering.schemas.ts) -- there is nothing a "preferred currency" setting
// would actually change, so it's deliberately not one of these fields.
export const defaultAccountPreferences: AccountPreferencesSnapshot = {
  dealAlertsEmail: true,
  statementsEmail: true,
  marketingEmail: false,
  locale: "en-US",
  timezone: "UTC",
};

export interface AccountPreferencesRepository {
  // Upserts: an account with no row yet gets one seeded from the defaults
  // above, with `patch` applied on top. Returns the resulting full snapshot.
  update(
    accountId: string,
    patch: Partial<AccountPreferencesSnapshot>,
  ): Promise<AccountPreferencesSnapshot>;
}
