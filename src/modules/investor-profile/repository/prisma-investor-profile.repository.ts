import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  InvestorProfileRecord,
  InvestorProfileRepository,
} from "./investor-profile.repository.js";

export class PrismaInvestorProfileRepository implements InvestorProfileRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async get(accountId: string): Promise<InvestorProfileRecord | null> {
    const account = await this.database.account.findUnique({
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
        kycEligibility: {
          select: {
            diditReference: true,
            providerStatus: true,
            eligibilityState: true,
            residenceCountryCode: true,
            taxResidenceCountryCode: true,
            proofOfAddressStatus: true,
            proofOfAddressCurrentUntil: true,
            lastVerifiedAt: true,
            renewalDueAt: true,
          },
        },
        walletRegistration: {
          select: { requestedAt: true, registeredAt: true },
        },
        _count: {
          select: {
            reservations: true,
            positions: { where: { positionStatus: { not: "redeemed" } } },
          },
        },
      },
    });
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
      kyc: account.kycEligibility,
      reservationCount: account._count.reservations,
      activePositionCount: account._count.positions,
      walletRegistration: account.walletRegistration,
    };
  }
}

function asAccountStatus(
  value: string,
): InvestorProfileRecord["accountStatus"] {
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
): InvestorProfileRecord["loginMethods"][number]["methodType"] {
  if (value === "google" || value === "email_password") return value;
  throw new Error(`Unknown login method: ${value}`);
}
