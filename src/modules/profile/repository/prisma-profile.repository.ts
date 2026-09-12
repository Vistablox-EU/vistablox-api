import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { PendingClosureRequestReader } from "../../auth/repository/account-closure.repository.js";
import type { KycEligibilityReader } from "../../identity/repository/kyc-eligibility-reader.js";
import type { InvestorActivitySummaryReader } from "../../investor-activity/repository/investor-activity.repository.js";
import type { WalletStatusReader } from "../../wallet/repository/wallet.repository.js";
import { defaultAccountPreferences } from "./account-preferences.repository.js";
import type { ProfileRecord, ProfileRepository } from "./profile.repository.js";

export class PrismaProfileRepository implements ProfileRepository {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly kycEligibilityReader: KycEligibilityReader,
    private readonly walletStatusReader: WalletStatusReader,
    private readonly investorActivitySummaryReader: InvestorActivitySummaryReader,
    private readonly pendingClosureRequestReader: PendingClosureRequestReader,
  ) {}

  public async get(accountId: string): Promise<ProfileRecord | null> {
    const [account, kycSnapshot, walletStatus, activitySummary, pendingClosureRequest] = await Promise.all([
      this.database.account.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          status: true,
          protectedContactEmail: true,
          createdAt: true,
          loginMethods: {
            select: { methodType: true, linkedAt: true },
            orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
          },
          preferences: {
            select: {
              dealAlertsEmail: true,
              statementsEmail: true,
              marketingEmail: true,
              locale: true,
              timezone: true,
            },
          },
        },
      }),
      this.kycEligibilityReader.getEligibilitySnapshot(accountId),
      this.walletStatusReader.getStatus(accountId),
      this.investorActivitySummaryReader.getSummary(accountId),
      this.pendingClosureRequestReader.getPending(accountId),
    ]);
    if (account === null) return null;
    return {
      accountId: account.id,
      accountStatus: asAccountStatus(account.status),
      protectedContactEmail: account.protectedContactEmail,
      createdAt: account.createdAt,
      loginMethods: account.loginMethods.map((method) => ({
        methodType: asLoginMethod(method.methodType),
        linkedAt: method.linkedAt,
      })),
      kyc: kycSnapshot,
      walletStatus,
      activitySummary,
      preferences: account.preferences ?? defaultAccountPreferences,
      pendingClosureRequest,
    };
  }
}

function asAccountStatus(
  value: string,
): ProfileRecord["accountStatus"] {
  if (
    value === "active" ||
    value === "recovery_review" ||
    value === "suspended_restricted"
  ) {
    return value;
  }
  throw new Error(`Unknown account status: ${value}`);
}

function asLoginMethod(
  value: string,
): ProfileRecord["loginMethods"][number]["methodType"] {
  if (value === "google" || value === "apple" || value === "passkey" || value === "device_key") {
    return value;
  }
  throw new Error(`Unknown login method: ${value}`);
}
