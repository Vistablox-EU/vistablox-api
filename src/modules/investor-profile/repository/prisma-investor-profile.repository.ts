import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import {
  WalletAddressConflictError,
  type InvestorPositionRecord,
  type InvestorProfileRecord,
  type InvestorProfileRepository,
  type InvestorReservationRecord,
  type RegisteredWallet,
} from "./investor-profile.repository.js";

export class PrismaInvestorProfileRepository implements InvestorProfileRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async registerWallet(input: {
    accountId: string;
    walletAddress: string;
    registrationCommitment: string;
    requestedAt: Date;
  }): Promise<RegisteredWallet> {
    return this.database.$transaction(async (transaction) => {
      const existingForAccount = await transaction.walletRegistration.findUnique({
        where: { accountId: input.accountId },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
        },
      });
      if (existingForAccount !== null && existingForAccount.walletAddress === input.walletAddress) {
        // Idempotent replay of the same request: return the existing
        // registration rather than creating a second one.
        return existingForAccount;
      }

      // Checked before the account's own existing-registration state: if
      // this exact address already belongs to a *different* account, that's
      // the more specific conflict, regardless of whether the requesting
      // account also happens to already have a different address of its
      // own. Checking address_mismatch first would misreport a genuine
      // address-uniqueness violation as "you're trying to change your own
      // address" whenever both conditions happen to be true at once.
      const claimedByOther = await transaction.walletRegistration.findUnique({
        where: { walletAddress: input.walletAddress },
        select: { accountId: true },
      });
      if (claimedByOther !== null && claimedByOther.accountId !== input.accountId) {
        throw new WalletAddressConflictError("address_claimed");
      }

      if (existingForAccount !== null) {
        throw new WalletAddressConflictError("address_mismatch");
      }

      const created = await transaction.walletRegistration.create({
        data: {
          accountId: input.accountId,
          walletAddress: input.walletAddress,
          registrationCommitment: input.registrationCommitment,
          requestedAt: input.requestedAt,
        },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "settlement.wallet_registration_requested",
          resourceType: "account",
          resourceId: input.accountId,
          changes: { wallet_address: input.walletAddress },
          createdAt: input.requestedAt,
        },
      });
      return created;
    });
  }

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
            positions: {
              where: {
                positionStatus: { in: ["pending_internal_settlement", "active"] },
              },
            },
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

  public async listReservations(input: {
    accountId: string;
    limit: number;
    after?: { createdAt: Date; id: string };
  }): Promise<InvestorReservationRecord[]> {
    const rows = await this.database.reservation.findMany({
      where: {
        accountId: input.accountId,
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                {
                  createdAt: input.after.createdAt,
                  id: { lt: input.after.id },
                },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        offeringId: true,
        amountEur: true,
        reservationStage: true,
        disclosurePackVersionAtReservation: true,
        reconfirmedAt: true,
        reservationFinalizedAt: true,
        createdAt: true,
        offering: {
          select: {
            status: true,
            piv: {
              select: {
                property: {
                  select: { propertyType: true, countryCode: true, city: true },
                },
              },
            },
          },
        },
        moneyEvents: {
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            capitalState: true,
            amountEur: true,
            amountEurc: true,
            recordedAt: true,
          },
        },
      },
    });

    return rows.map((row) => {
      const property = toPropertySummary(row.offering.piv.property);
      const latestMoneyEvent = row.moneyEvents[0];
      return {
        reservationId: row.id,
        offeringId: row.offeringId,
        offeringStatus: asOfferingStatus(row.offering.status),
        amountEur: row.amountEur.toFixed(2),
        reservationStage: asReservationStage(row.reservationStage),
        disclosurePackVersionAtReservation:
          row.disclosurePackVersionAtReservation,
        reconfirmedAt: row.reconfirmedAt,
        reservationFinalizedAt: row.reservationFinalizedAt,
        createdAt: row.createdAt,
        latestMoneyEvent:
          latestMoneyEvent === undefined
            ? null
            : {
                capitalState: asCapitalState(latestMoneyEvent.capitalState),
                amountEur: latestMoneyEvent.amountEur.toFixed(2),
                amountEurc: latestMoneyEvent.amountEurc?.toFixed(6) ?? null,
                recordedAt: latestMoneyEvent.recordedAt,
              },
        property,
      };
    });
  }

  public async listCurrentPositions(input: {
    accountId: string;
    limit: number;
    after?: { activatedAt: Date | null; id: string };
  }): Promise<InvestorPositionRecord[]> {
    const rows = await this.database.positionLedger.findMany({
      where: {
        accountId: input.accountId,
        positionStatus: { in: ["pending_internal_settlement", "active"] },
        ...(input.after === undefined
          ? {}
          : input.after.activatedAt === null
            ? { activatedAt: null, id: { lt: input.after.id } }
            : {
                OR: [
                  { activatedAt: { lt: input.after.activatedAt } },
                  {
                    activatedAt: input.after.activatedAt,
                    id: { lt: input.after.id },
                  },
                  { activatedAt: null },
                ],
              }),
      },
      orderBy: [
        { activatedAt: { sort: "desc", nulls: "last" } },
        { id: "desc" },
      ],
      take: input.limit,
      select: {
        id: true,
        reservationId: true,
        pivId: true,
        unitCount: true,
        costBasisEur: true,
        positionStatus: true,
        activatedAt: true,
        reservation: { select: { offeringId: true } },
        piv: {
          select: {
            property: {
              select: { propertyType: true, countryCode: true, city: true },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      positionId: row.id,
      reservationId: row.reservationId,
      offeringId: row.reservation?.offeringId ?? null,
      pivId: row.pivId,
      unitCount: row.unitCount.toFixed(6),
      costBasisEur: row.costBasisEur.toFixed(2),
      positionStatus: asCurrentPositionStatus(row.positionStatus),
      activatedAt: row.activatedAt,
      property: toPropertySummary(row.piv.property),
    }));
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

function asReservationStage(
  value: string,
): InvestorReservationRecord["reservationStage"] {
  if (
    value === "initiated" ||
    value === "awaiting_reconfirmation" ||
    value === "reconfirmed" ||
    value === "finalized" ||
    value === "cancelled" ||
    value === "lapsed"
  ) {
    return value;
  }
  throw new Error(`Unknown reservation stage: ${value}`);
}

function asOfferingStatus(
  value: string,
): InvestorReservationRecord["offeringStatus"] {
  if (value === "pre_offering" || value === "final_offering" || value === "closed") {
    return value;
  }
  throw new Error(`Unknown offering status: ${value}`);
}

function asCapitalState(
  value: string,
): NonNullable<InvestorReservationRecord["latestMoneyEvent"]>["capitalState"] {
  if (
    value === "initiated" ||
    value === "eurc_purchase_pending" ||
    value === "purchase_failed" ||
    value === "eurc_reserved" ||
    value === "reconfirmation_pending" ||
    value === "eurc_finalized" ||
    value === "provider_disputed"
  ) {
    return value;
  }
  throw new Error(`Unknown capital state: ${value}`);
}

function asCurrentPositionStatus(
  value: string,
): InvestorPositionRecord["positionStatus"] {
  if (value === "pending_internal_settlement" || value === "active") return value;
  throw new Error(`Unknown current position status: ${value}`);
}

function toPropertySummary(input: {
  propertyType: string;
  countryCode: string;
  city: string | null;
}): InvestorPositionRecord["property"] {
  if (input.propertyType !== "residential") {
    throw new Error(`Unknown property type: ${input.propertyType}`);
  }
  return {
    propertyType: input.propertyType,
    countryCode: input.countryCode,
    city: input.city,
  };
}
