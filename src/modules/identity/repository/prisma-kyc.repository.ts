import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  DiditStatus,
  KycEligibilityState,
  KycOperationalSubstatus,
  KycPolicyOutcome,
} from "../domain/kyc-policy.js";
import type {
  KycEligibilityRecord,
  KycRepository,
} from "./kyc.repository.js";

export class PrismaKycRepository implements KycRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async getForAccount(accountId: string): Promise<KycEligibilityRecord | null> {
    const record = await this.database.kycEligibility.findUnique({ where: { accountId } });
    return record === null ? null : toRecord(record);
  }

  public async findByDiditReference(
    diditReference: string,
  ): Promise<KycEligibilityRecord | null> {
    const record = await this.database.kycEligibility.findUnique({
      where: { diditReference },
    });
    return record === null ? null : toRecord(record);
  }

  public async hasProcessedProviderEvent(eventKey: string): Promise<boolean> {
    return (
      (await this.database.auditLog.findUnique({
        where: { eventKey },
        select: { id: true },
      })) !== null
    );
  }

  public async reserveSessionStart(input: {
    accountId: string;
    sessionStartId: string;
    residenceCountryCode: string;
    taxResidenceCountryCode: string;
    traceId: string;
    startedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ account_id: string }>>`
        SELECT account_id
        FROM account.accounts
        WHERE account_id = ${input.accountId}
        FOR UPDATE
      `;
      if (locked.length === 0) return false;
      const current = await transaction.kycEligibility.findUnique({
        where: { accountId: input.accountId },
      });
      if (current !== null && !canStartSession(current.operationalSubstatus)) {
        return false;
      }
      await transaction.kycEligibility.upsert({
        where: { accountId: input.accountId },
        create: {
          accountId: input.accountId,
          eligibilityState: "not_started",
          operationalSubstatus: "kyc_session_creating",
          residenceCountryCode: input.residenceCountryCode,
          taxResidenceCountryCode: input.taxResidenceCountryCode,
          sessionStartId: input.sessionStartId,
          updatedAt: input.startedAt,
        },
        update: {
          operationalSubstatus: "kyc_session_creating",
          residenceCountryCode: input.residenceCountryCode,
          taxResidenceCountryCode: input.taxResidenceCountryCode,
          sessionStartId: input.sessionStartId,
          updatedAt: input.startedAt,
        },
      });
      return true;
    });
  }

  public async completeSessionStart(input: {
    accountId: string;
    sessionStartId: string;
    diditReference: string;
    providerStatus: DiditStatus;
    traceId: string;
    completedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.kycEligibility.updateMany({
        where: {
          accountId: input.accountId,
          sessionStartId: input.sessionStartId,
          operationalSubstatus: "kyc_session_creating",
        },
        data: {
          diditReference: input.diditReference,
          providerStatus: input.providerStatus,
          operationalSubstatus: "kyc_session_open",
          eligibilityState: "not_started",
          providerUpdatedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
      if (updated.count !== 1) return false;
      await transaction.kycEligibilityHistory.create({
        data: {
          id: `kych_${ulid()}`,
          accountId: input.accountId,
          previousState: "not_started",
          newState: "not_started",
          reasonCode: "KYC_SESSION_STARTED",
          changedAt: input.completedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          eventKey: `didit:session_started:${input.diditReference}`,
          actorAccountId: input.accountId,
          action: "identity.kyc_session_started",
          resourceType: "kyc_session",
          resourceId: input.diditReference,
          changes: {
            trace_id: input.traceId,
            provider: "didit",
            provider_status: input.providerStatus,
            eligibility_state: "not_started",
          },
          createdAt: input.completedAt,
        },
      });
      return true;
    });
  }

  public async failSessionStart(input: {
    accountId: string;
    sessionStartId: string;
    traceId: string;
    failedAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const failed = await transaction.kycEligibility.updateMany({
        where: {
          accountId: input.accountId,
          sessionStartId: input.sessionStartId,
          operationalSubstatus: "kyc_session_creating",
        },
        data: {
          operationalSubstatus: "kyc_session_creation_failed",
          updatedAt: input.failedAt,
        },
      });
      if (failed.count !== 1) return;
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          eventKey: `didit:session_start_failed:${input.sessionStartId}`,
          actorAccountId: input.accountId,
          action: "identity.kyc_session_start_failed",
          resourceType: "account",
          resourceId: input.accountId,
          changes: { trace_id: input.traceId, provider: "didit" },
          createdAt: input.failedAt,
        },
      });
    });
  }

  public async applyProviderOutcome(input: {
    eventKey: string;
    eventId: string;
    diditReference: string;
    providerStatus: DiditStatus | null;
    webhookType: string;
    traceId: string;
    providerUpdatedAt: Date;
    outcome: KycPolicyOutcome;
  }): Promise<"applied" | "duplicate" | "stale" | "unmatched"> {
    return this.database.$transaction(async (transaction) => {
      const claimed = await transaction.auditLog.createMany({
        data: [
          {
            id: `audit_${ulid()}`,
            eventKey: input.eventKey,
            action: "identity.didit_webhook_received",
            resourceType: "kyc_session",
            resourceId: input.diditReference,
            changes: { trace_id: input.traceId },
            createdAt: input.providerUpdatedAt,
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count === 0) return "duplicate";

      const locked = await transaction.$queryRaw<Array<{ account_id: string }>>`
        SELECT account_id
        FROM identity.kyc_eligibility
        WHERE didit_reference = ${input.diditReference}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        await updateReceipt(transaction, input.eventKey, {
          matched: false,
          reason: "session_not_found",
          provider_status: input.providerStatus,
          webhook_type: input.webhookType,
        });
        return "unmatched";
      }
      const lockedAccountId = locked[0]!.account_id;
      const current = await transaction.kycEligibility.findUniqueOrThrow({
        where: { accountId: lockedAccountId },
      });
      if (
        current.providerUpdatedAt !== null &&
        current.providerUpdatedAt > input.providerUpdatedAt
      ) {
        await updateReceipt(transaction, input.eventKey, {
          matched: true,
          stale: true,
          provider_status: input.providerStatus,
          webhook_type: input.webhookType,
        });
        return "stale";
      }

      await transaction.kycEligibility.update({
        where: { accountId: current.accountId },
        data: {
          providerStatus: input.providerStatus,
          providerUpdatedAt: input.providerUpdatedAt,
          eligibilityState: input.outcome.eligibilityState,
          operationalSubstatus: input.outcome.operationalSubstatus,
          ...(input.outcome.lastVerifiedAt === null
            ? {}
            : { lastVerifiedAt: input.outcome.lastVerifiedAt }),
          ...(input.outcome.renewalDueAt === null
            ? {}
            : { renewalDueAt: input.outcome.renewalDueAt }),
          updatedAt: input.providerUpdatedAt,
        },
      });
      await transaction.kycEligibilityHistory.create({
        data: {
          id: `kych_${ulid()}`,
          accountId: current.accountId,
          previousState: current.eligibilityState,
          newState: input.outcome.eligibilityState,
          reasonCode: input.outcome.reasonCode,
          changedAt: input.providerUpdatedAt,
        },
      });
      await updateReceipt(transaction, input.eventKey, {
        matched: true,
        provider_event_id: input.eventId,
        provider_status: input.providerStatus,
        webhook_type: input.webhookType,
        previous_state: current.eligibilityState,
        new_state: input.outcome.eligibilityState,
        operational_substatus: input.outcome.operationalSubstatus,
        reason_code: input.outcome.reasonCode,
      });
      return "applied";
    });
  }

  public async recordUnmatchedProviderEvent(input: {
    eventKey: string;
    eventId: string;
    diditReference: string;
    providerStatus: string;
    webhookType: string;
    traceId: string;
    receivedAt: Date;
    reason: "session_not_found" | "correlation_mismatch" | "configuration_mismatch";
  }): Promise<void> {
    await this.database.auditLog.createMany({
      data: [
        {
          id: `audit_${ulid()}`,
          eventKey: input.eventKey,
          action: "identity.didit_webhook_unmatched",
          resourceType: "kyc_session",
          resourceId: input.diditReference,
          changes: {
            trace_id: input.traceId,
            provider_event_id: input.eventId,
            provider_status: input.providerStatus,
            webhook_type: input.webhookType,
            reason: input.reason,
          },
          createdAt: input.receivedAt,
        },
      ],
      skipDuplicates: true,
    });
  }
}

function canStartSession(substatus: string): boolean {
  return [
    "kyc_not_started",
    "kyc_session_creation_failed",
    "kyc_restart_required",
    "kyc_reverification_required",
  ].includes(substatus);
}

function toRecord(input: {
  accountId: string;
  diditReference: string | null;
  eligibilityState: string;
  operationalSubstatus: string;
  residenceCountryCode: string | null;
  taxResidenceCountryCode: string | null;
  proofOfAddressCurrentUntil: Date | null;
  lastVerifiedAt: Date | null;
  renewalDueAt: Date | null;
}): KycEligibilityRecord {
  return {
    accountId: input.accountId,
    diditReference: input.diditReference,
    eligibilityState: input.eligibilityState as KycEligibilityState,
    operationalSubstatus: input.operationalSubstatus as KycOperationalSubstatus,
    residenceCountryCode: input.residenceCountryCode,
    taxResidenceCountryCode: input.taxResidenceCountryCode,
    proofOfAddressCurrentUntil: input.proofOfAddressCurrentUntil,
    lastVerifiedAt: input.lastVerifiedAt,
    renewalDueAt: input.renewalDueAt,
  };
}

async function updateReceipt(
  transaction: Parameters<Parameters<DatabaseClient["$transaction"]>[0]>[0],
  eventKey: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await transaction.auditLog.update({
    where: { eventKey },
    data: { changes: changes as never },
  });
}
