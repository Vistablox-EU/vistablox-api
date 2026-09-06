import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  StaffWebAuthnChallengeRecord,
  StaffWebAuthnCredentialRecord,
  StaffWebAuthnRepository,
  WebAuthnChallengePurpose,
} from "./staff-webauthn.repository.js";

export class PrismaStaffWebAuthnRepository implements StaffWebAuthnRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listCredentials(accountId: string): Promise<StaffWebAuthnCredentialRecord[]> {
    const credentials = await this.database.staffWebAuthnCredential.findMany({
      where: { accountId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return credentials.map(toCredential);
  }

  public async findCredential(
    accountId: string,
    credentialId: string,
  ): Promise<StaffWebAuthnCredentialRecord | null> {
    const credential = await this.database.staffWebAuthnCredential.findFirst({
      where: { id: credentialId, accountId },
    });
    return credential === null ? null : toCredential(credential);
  }

  public async isSessionVerified(
    accountId: string,
    providerSessionId: string,
  ): Promise<boolean> {
    const passkeySession = await this.database.session.findFirst({
      where: {
        accountId,
        betterAuthSessionId: providerSessionId,
        status: "active",
        authMethodAtLogin: "passkey",
      },
      select: { id: true },
    });
    if (passkeySession !== null) return true;

    // Transitional support for sessions that completed the former separate
    // WebAuthn ceremony before the unified passkey login was deployed.
    const proof = await this.database.staffSessionMfa.findFirst({
      where: { accountId, providerSessionId },
      select: { providerSessionId: true },
    });
    return proof !== null;
  }

  public async replaceChallenge(input: {
    accountId: string;
    providerSessionId: string;
    purpose: WebAuthnChallengePurpose;
    challenge: string;
    credentialLabel: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<StaffWebAuthnChallengeRecord> {
    return this.database.$transaction(async (transaction) => {
      await transaction.staffWebAuthnChallenge.updateMany({
        where: {
          accountId: input.accountId,
          providerSessionId: input.providerSessionId,
          purpose: input.purpose,
          usedAt: null,
        },
        data: { usedAt: input.createdAt },
      });
      const challenge = await transaction.staffWebAuthnChallenge.create({
        data: {
          id: `wch_${ulid()}`,
          accountId: input.accountId,
          providerSessionId: input.providerSessionId,
          purpose: input.purpose,
          challenge: input.challenge,
          credentialLabel: input.credentialLabel,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        },
      });
      return toChallenge(challenge);
    });
  }

  public async getActiveChallenge(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    purpose: WebAuthnChallengePurpose;
    now: Date;
  }): Promise<StaffWebAuthnChallengeRecord | null> {
    const challenge = await this.database.staffWebAuthnChallenge.findFirst({
      where: {
        id: input.challengeId,
        accountId: input.accountId,
        providerSessionId: input.providerSessionId,
        purpose: input.purpose,
        usedAt: null,
        expiresAt: { gt: input.now },
      },
    });
    return challenge === null ? null : toChallenge(challenge);
  }

  public async failChallenge(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    purpose: WebAuthnChallengePurpose;
    traceId: string;
    reason: "credential_not_found" | "verification_failed";
    failedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const consumed = await transaction.staffWebAuthnChallenge.updateMany({
        where: {
          id: input.challengeId,
          accountId: input.accountId,
          providerSessionId: input.providerSessionId,
          purpose: input.purpose,
          usedAt: null,
          expiresAt: { gt: input.failedAt },
        },
        data: { usedAt: input.failedAt },
      });
      if (consumed.count !== 1) return false;

      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "authentication.staff_webauthn_challenge_failed",
          resourceType: "session",
          resourceId: input.providerSessionId,
          changes: {
            trace_id: input.traceId,
            challenge_purpose: input.purpose,
            reason: input.reason,
          },
        },
      });
      return true;
    });
  }

  public async completeRegistration(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    traceId: string;
    credentialId: string;
    publicKey: Uint8Array<ArrayBuffer>;
    counter: number;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    transports: string[];
    completedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const consumed = await transaction.staffWebAuthnChallenge.updateMany({
        where: {
          id: input.challengeId,
          accountId: input.accountId,
          providerSessionId: input.providerSessionId,
          purpose: "registration",
          usedAt: null,
          expiresAt: { gt: input.completedAt },
        },
        data: { usedAt: input.completedAt },
      });
      if (consumed.count !== 1) return false;

      const challenge = await transaction.staffWebAuthnChallenge.findUniqueOrThrow({
        where: { id: input.challengeId },
        select: { credentialLabel: true },
      });
      await transaction.staffWebAuthnCredential.create({
        data: {
          id: input.credentialId,
          accountId: input.accountId,
          publicKey: input.publicKey,
          counter: BigInt(input.counter),
          deviceType: input.deviceType,
          backedUp: input.backedUp,
          transports: input.transports,
          label: challenge.credentialLabel,
        },
      });
      await transaction.staffSessionMfa.upsert({
        where: { providerSessionId: input.providerSessionId },
        update: {
          accountId: input.accountId,
          credentialId: input.credentialId,
          verifiedAt: input.completedAt,
        },
        create: {
          providerSessionId: input.providerSessionId,
          accountId: input.accountId,
          credentialId: input.credentialId,
          verifiedAt: input.completedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "authentication.staff_webauthn_credential_registered",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {
            trace_id: input.traceId,
            credential_id: input.credentialId,
            provider_session_id: input.providerSessionId,
            device_type: input.deviceType,
            backed_up: input.backedUp,
          },
        },
      });
      return true;
    });
  }

  public async completeAuthentication(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    traceId: string;
    credentialId: string;
    expectedCounter: number;
    newCounter: number;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    completedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const consumed = await transaction.staffWebAuthnChallenge.updateMany({
        where: {
          id: input.challengeId,
          accountId: input.accountId,
          providerSessionId: input.providerSessionId,
          purpose: "authentication",
          usedAt: null,
          expiresAt: { gt: input.completedAt },
        },
        data: { usedAt: input.completedAt },
      });
      if (consumed.count !== 1) return false;

      const updated = await transaction.staffWebAuthnCredential.updateMany({
        where: {
          id: input.credentialId,
          accountId: input.accountId,
          counter: BigInt(input.expectedCounter),
        },
        data: {
          counter: BigInt(input.newCounter),
          deviceType: input.deviceType,
          backedUp: input.backedUp,
          lastUsedAt: input.completedAt,
        },
      });
      if (updated.count !== 1) {
        throw new Error("WebAuthn credential changed during authentication");
      }
      await transaction.staffSessionMfa.upsert({
        where: { providerSessionId: input.providerSessionId },
        update: {
          accountId: input.accountId,
          credentialId: input.credentialId,
          verifiedAt: input.completedAt,
        },
        create: {
          providerSessionId: input.providerSessionId,
          accountId: input.accountId,
          credentialId: input.credentialId,
          verifiedAt: input.completedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "authentication.staff_webauthn_challenge_succeeded",
          resourceType: "session",
          resourceId: input.providerSessionId,
          changes: {
            trace_id: input.traceId,
            credential_id: input.credentialId,
          },
        },
      });
      return true;
    });
  }
}

function toCredential(input: {
  id: string;
  accountId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: bigint;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  label: string | null;
}): StaffWebAuthnCredentialRecord {
  const counter = Number(input.counter);
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error("Stored WebAuthn counter is outside the supported range");
  }
  if (input.deviceType !== "singleDevice" && input.deviceType !== "multiDevice") {
    throw new Error(`Unknown WebAuthn device type: ${input.deviceType}`);
  }
  return {
    credentialId: input.id,
    accountId: input.accountId,
    publicKey: input.publicKey,
    counter,
    deviceType: input.deviceType,
    backedUp: input.backedUp,
    transports: input.transports,
    label: input.label,
  };
}

function toChallenge(input: {
  id: string;
  accountId: string;
  providerSessionId: string;
  purpose: string;
  challenge: string;
  credentialLabel: string | null;
  expiresAt: Date;
}): StaffWebAuthnChallengeRecord {
  if (input.purpose !== "registration" && input.purpose !== "authentication") {
    throw new Error(`Unknown WebAuthn challenge purpose: ${input.purpose}`);
  }
  return {
    challengeId: input.id,
    accountId: input.accountId,
    providerSessionId: input.providerSessionId,
    purpose: input.purpose,
    challenge: input.challenge,
    credentialLabel: input.credentialLabel,
    expiresAt: input.expiresAt,
  };
}
