import { ulid } from "ulid";
import { z } from "zod";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  DiditStatus,
  KycEligibilityState,
  KycOperationalSubstatus,
  KycPolicyOutcome,
} from "../domain/kyc-policy.js";
import type {
  ProofOfAddressOutcome,
  ProofOfAddressStatus,
} from "../domain/proof-of-address-policy.js";
import type {
  KycEligibilityRecord,
  KycRepository,
} from "./kyc.repository.js";

const renewalLeadDaysSettingSchema = z.object({ days: z.number().int().min(1).max(365) });

export class PrismaKycRepository implements KycRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async getRenewalReminderLeadDays(): Promise<number> {
    const setting = await this.database.platformSetting.findUnique({
      where: { key: "identity.kyc_renewal_reminder_lead_days" },
      select: { value: true },
    });
    if (setting === null) {
      throw new Error("Missing identity.kyc_renewal_reminder_lead_days setting");
    }
    return renewalLeadDaysSettingSchema.parse(setting.value).days;
  }

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

  public async findByProofOfAddressDiditReference(
    diditReference: string,
  ): Promise<KycEligibilityRecord | null> {
    const record = await this.database.kycEligibility.findUnique({
      where: { proofOfAddressDiditReference: diditReference },
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

  public async reserveProofOfAddressSessionStart(input: {
    accountId: string;
    sessionStartId: string;
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
      if (
        current === null ||
        current.eligibilityState !== "eligible" ||
        !canStartProofOfAddress(
          current.proofOfAddressStatus,
          current.proofOfAddressCurrentUntil,
          input.startedAt,
        )
      ) {
        return false;
      }
      await transaction.kycEligibility.update({
        where: { accountId: input.accountId },
        data: {
          proofOfAddressStatus: "creating",
          proofOfAddressSessionStartId: input.sessionStartId,
          updatedAt: input.startedAt,
        },
      });
      return true;
    });
  }

  public async completeProofOfAddressSessionStart(input: {
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
          proofOfAddressSessionStartId: input.sessionStartId,
          proofOfAddressStatus: "creating",
        },
        data: {
          proofOfAddressDiditReference: input.diditReference,
          proofOfAddressProviderStatus: input.providerStatus,
          proofOfAddressProviderUpdatedAt: input.completedAt,
          proofOfAddressStatus: "in_progress",
          updatedAt: input.completedAt,
        },
      });
      if (updated.count !== 1) return false;
      await transaction.kycEligibilityHistory.create({
        data: {
          id: `kych_${ulid()}`,
          accountId: input.accountId,
          previousState: "eligible",
          newState: "eligible",
          reasonCode: "OWNER_PROOF_OF_ADDRESS_SESSION_STARTED",
          changedAt: input.completedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          eventKey: `didit:poa_session_started:${input.diditReference}`,
          actorAccountId: input.accountId,
          action: "identity.proof_of_address_session_started",
          resourceType: "kyc_session",
          resourceId: input.diditReference,
          changes: {
            trace_id: input.traceId,
            provider: "didit",
            provider_status: input.providerStatus,
            proof_of_address_status: "in_progress",
          },
          createdAt: input.completedAt,
        },
      });
      return true;
    });
  }

  public async failProofOfAddressSessionStart(input: {
    accountId: string;
    sessionStartId: string;
    traceId: string;
    failedAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const failed = await transaction.kycEligibility.updateMany({
        where: {
          accountId: input.accountId,
          proofOfAddressSessionStartId: input.sessionStartId,
          proofOfAddressStatus: "creating",
        },
        data: {
          proofOfAddressStatus: "creation_failed",
          updatedAt: input.failedAt,
        },
      });
      if (failed.count !== 1) return;
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          eventKey: `didit:poa_session_start_failed:${input.sessionStartId}`,
          actorAccountId: input.accountId,
          action: "identity.proof_of_address_session_start_failed",
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

      const operationalSubstatus =
        input.outcome.eligibilityState === "eligible" &&
        current.proofOfAddressStatus === "current" &&
        current.proofOfAddressCurrentUntil !== null &&
        current.proofOfAddressCurrentUntil > input.providerUpdatedAt
          ? "kyc_verified"
          : input.outcome.operationalSubstatus;
      await transaction.kycEligibility.update({
        where: { accountId: current.accountId },
        data: {
          providerStatus: input.providerStatus,
          providerUpdatedAt: input.providerUpdatedAt,
          eligibilityState: input.outcome.eligibilityState,
          operationalSubstatus,
          everRequiredManualReview: input.outcome.everRequiredManualReview,
          ...(input.outcome.lastVerifiedAt === null
            ? {}
            : { lastVerifiedAt: input.outcome.lastVerifiedAt }),
          ...(input.outcome.renewalDueAt === null
            ? {}
            : { renewalDueAt: input.outcome.renewalDueAt }),
          updatedAt:
            input.providerUpdatedAt > current.updatedAt
              ? input.providerUpdatedAt
              : current.updatedAt,
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
        operational_substatus: operationalSubstatus,
        reason_code: input.outcome.reasonCode,
      });
      return "applied";
    });
  }

  public async applyProofOfAddressOutcome(input: {
    eventKey: string;
    eventId: string;
    diditReference: string;
    providerStatus: DiditStatus | null;
    webhookType: string;
    traceId: string;
    providerUpdatedAt: Date;
    outcome: ProofOfAddressOutcome;
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
        WHERE proof_of_address_didit_reference = ${input.diditReference}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        await updateReceipt(transaction, input.eventKey, {
          matched: false,
          reason: "session_not_found",
          provider_status: input.providerStatus,
          webhook_type: input.webhookType,
          verification_purpose: "owner_proof_of_address",
        });
        return "unmatched";
      }
      const current = await transaction.kycEligibility.findUniqueOrThrow({
        where: { accountId: locked[0]!.account_id },
      });
      if (
        current.proofOfAddressProviderUpdatedAt !== null &&
        current.proofOfAddressProviderUpdatedAt > input.providerUpdatedAt
      ) {
        await updateReceipt(transaction, input.eventKey, {
          matched: true,
          stale: true,
          provider_status: input.providerStatus,
          webhook_type: input.webhookType,
          verification_purpose: "owner_proof_of_address",
        });
        return "stale";
      }

      const operationalSubstatus =
        current.eligibilityState !== "eligible"
          ? current.operationalSubstatus
          : input.outcome.status === "current"
            ? "kyc_verified"
            : "kyc_verified_owner_poa_missing";
      await transaction.kycEligibility.update({
        where: { accountId: current.accountId },
        data: {
          proofOfAddressProviderStatus: input.providerStatus,
          proofOfAddressProviderUpdatedAt: input.providerUpdatedAt,
          proofOfAddressStatus: input.outcome.status,
          proofOfAddressCurrentUntil: input.outcome.currentUntil,
          operationalSubstatus,
          updatedAt:
            input.providerUpdatedAt > current.updatedAt
              ? input.providerUpdatedAt
              : current.updatedAt,
        },
      });
      await transaction.kycEligibilityHistory.create({
        data: {
          id: `kych_${ulid()}`,
          accountId: current.accountId,
          previousState: current.eligibilityState,
          newState: current.eligibilityState,
          reasonCode: input.outcome.reasonCode,
          changedAt: input.providerUpdatedAt,
        },
      });
      await updateReceipt(transaction, input.eventKey, {
        matched: true,
        provider_event_id: input.eventId,
        provider_status: input.providerStatus,
        webhook_type: input.webhookType,
        verification_purpose: "owner_proof_of_address",
        proof_of_address_status: input.outcome.status,
        operational_substatus: operationalSubstatus,
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

  public async listEligibleAccountsForRenewalTimer(): Promise<
    Array<{ accountId: string; contactEmail: string | null; renewalDueAt: Date }>
  > {
    const rows = await this.database.kycEligibility.findMany({
      where: { eligibilityState: "eligible", renewalDueAt: { not: null } },
      select: {
        accountId: true,
        renewalDueAt: true,
        account: { select: { protectedContactEmail: true } },
      },
    });
    return rows.map((row) => ({
      accountId: row.accountId,
      contactEmail: row.account.protectedContactEmail,
      renewalDueAt: row.renewalDueAt as Date,
    }));
  }

  public async transitionToRequiresRenewal(input: {
    accountId: string;
    traceId: string;
    transitionedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.kycEligibility.updateMany({
        where: { accountId: input.accountId, eligibilityState: "eligible" },
        data: {
          eligibilityState: "requires_renewal",
          updatedAt: input.transitionedAt,
        },
      });
      if (updated.count !== 1) return false;

      await transaction.kycEligibilityHistory.create({
        data: {
          id: `kych_${ulid()}`,
          accountId: input.accountId,
          previousState: "eligible",
          newState: "requires_renewal",
          reasonCode: "KYC_RENEWAL_DUE",
          changedAt: input.transitionedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "identity.kyc_renewal_due",
          resourceType: "kyc_eligibility",
          resourceId: input.accountId,
          changes: {
            trace_id: input.traceId,
            previous_state: "eligible",
            new_state: "requires_renewal",
          },
          createdAt: input.transitionedAt,
        },
      });
      return true;
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

function canStartProofOfAddress(
  status: string,
  currentUntil: Date | null,
  startedAt: Date,
): boolean {
  if (status === "current" && currentUntil !== null && currentUntil > startedAt) {
    return false;
  }
  return [
    "not_started",
    "creation_failed",
    "insufficient",
    "expired",
    "restart_required",
    "integration_anomaly",
    "current",
  ].includes(status);
}

function toRecord(input: {
  accountId: string;
  diditReference: string | null;
  eligibilityState: string;
  operationalSubstatus: string;
  proofOfAddressDiditReference: string | null;
  proofOfAddressProviderStatus: string | null;
  proofOfAddressProviderUpdatedAt: Date | null;
  proofOfAddressStatus: string;
  residenceCountryCode: string | null;
  taxResidenceCountryCode: string | null;
  proofOfAddressCurrentUntil: Date | null;
  lastVerifiedAt: Date | null;
  everRequiredManualReview: boolean;
  renewalDueAt: Date | null;
}): KycEligibilityRecord {
  return {
    accountId: input.accountId,
    diditReference: input.diditReference,
    eligibilityState: input.eligibilityState as KycEligibilityState,
    operationalSubstatus: input.operationalSubstatus as KycOperationalSubstatus,
    proofOfAddressDiditReference: input.proofOfAddressDiditReference,
    proofOfAddressProviderStatus:
      input.proofOfAddressProviderStatus as DiditStatus | null,
    proofOfAddressProviderUpdatedAt: input.proofOfAddressProviderUpdatedAt,
    proofOfAddressStatus: input.proofOfAddressStatus as ProofOfAddressStatus,
    residenceCountryCode: input.residenceCountryCode,
    taxResidenceCountryCode: input.taxResidenceCountryCode,
    proofOfAddressCurrentUntil: input.proofOfAddressCurrentUntil,
    lastVerifiedAt: input.lastVerifiedAt,
    everRequiredManualReview: input.everRequiredManualReview,
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
