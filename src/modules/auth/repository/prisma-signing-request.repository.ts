import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import {
  type SigningRequestStatus,
  type TxCreatedBy,
  type TxDestination,
  type TxDestinationKind,
} from "../domain/signing-request.policy.js";
import type {
  CreateSigningRequestInput,
  SigningRequest,
  SigningRequestRepository,
} from "./signing-request.repository.js";

const COLUMNS = {
  id: true,
  accountId: true,
  deviceId: true,
  requestType: true,
  amountMinor: true,
  currency: true,
  destination: true,
  createdBy: true,
  status: true,
  signedJws: true,
  signedAt: true,
  expiresAt: true,
  createdAt: true,
} as const;

function toSigningRequest(row: SigningRequestRow): SigningRequest {
  return {
    id: row.id,
    accountId: row.accountId,
    deviceId: row.deviceId,
    requestType: row.requestType,
    amountMinor: row.amountMinor,
    currency: row.currency,
    destination: toDestination(row.destination),
    createdBy: row.createdBy as TxCreatedBy,
    status: row.status as SigningRequestStatus,
    signedJws: row.signedJws ?? null,
    signedAt: row.signedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

interface SigningRequestRow {
  id: string;
  accountId: string;
  deviceId: string;
  requestType: string;
  amountMinor: string | null;
  currency: string | null;
  destination: unknown;
  createdBy: unknown;
  status: string;
  signedJws: unknown;
  signedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

function toDestination(value: unknown): TxDestination | null {
  if (value === null) return null;
  const destination = value as Record<string, unknown>;
  if (typeof destination.kind !== "string" || typeof destination.value !== "string") return null;
  return {
    kind: destination.kind as TxDestinationKind,
    value: destination.value,
    ...(typeof destination.display_name === "string"
      ? { displayName: destination.display_name }
      : {}),
  };
}

// Stored jsonb is snake_case per the plan ({kind, value, display_name}); the
// domain object spells it displayName, so the stored shape must survive the
// mapping round-trip for T1 to echo exactly what was written.
function toStoredDestination(destination: TxDestination): {
  kind: TxDestinationKind;
  value: string;
  display_name?: string;
} {
  return {
    kind: destination.kind,
    value: destination.value,
    ...(destination.displayName === undefined ? {} : { display_name: destination.displayName }),
  };
}

export class PrismaSigningRequestRepository implements SigningRequestRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async create(input: CreateSigningRequestInput): Promise<SigningRequest> {
    const row = await this.database.signingRequest.create({
      data: {
        id: `req_${ulid()}`,
        accountId: input.accountId,
        deviceId: input.deviceId,
        requestType: input.requestType,
        amountMinor: input.amountMinor,
        currency: input.currency,
        destination:
          input.destination === null ? Prisma.DbNull : (toStoredDestination(input.destination) as Prisma.InputJsonValue),
        createdBy: input.createdBy as unknown as Prisma.InputJsonValue,
        status: "pending",
        expiresAt: input.expiresAt,
        ...(input.now === undefined ? {} : { createdAt: input.now }),
      },
      select: COLUMNS,
    });
    return toSigningRequest(row as never);
  }

  public async findOwned(requestId: string, accountId: string): Promise<SigningRequest | null> {
    const row = await this.database.signingRequest.findFirst({
      where: { id: requestId, accountId },
      select: COLUMNS,
    });
    return row === null ? null : toSigningRequest(row as never);
  }

  public async listForAccount(accountId: string, status?: string): Promise<SigningRequest[]> {
    const rows = await this.database.signingRequest.findMany({
      where: { accountId, ...(status === undefined ? {} : { status }) },
      orderBy: { createdAt: "desc" },
      select: COLUMNS,
    });
    return rows.map((row) => toSigningRequest(row as never));
  }

  public async markSigned(input: {
    requestId: string;
    accountId: string;
    signedJws: unknown;
    signedAt: Date;
  }): Promise<SigningRequest | null> {
    // Atomic pending -> signed on the *database* clock for expiry, like the
    // challenge lifecycle: two racing T3 requests can only ever see one of
    // them win the conditional UPDATE, and a request that aged past its
    // expiry mid-ceremony loses cleanly.
    const rows = await this.database.$queryRaw<Array<Record<string, unknown>>>`
      UPDATE auth.signing_requests
      SET status = 'signed', signed_jws = ${input.signedJws as Prisma.InputJsonValue}, signed_at = ${input.signedAt}
      WHERE signing_request_id = ${input.requestId}
        AND account_id = ${input.accountId}
        AND status = 'pending'
        AND expires_at > now()
      RETURNING *
    `;
    return rows[0] === undefined ? null : toSigningRequestFromRaw(rows[0]);
  }

  public async markExecuted(input: {
    requestId: string;
    accountId: string;
  }): Promise<SigningRequest | null> {
    const rows = await this.database.$queryRaw<Array<Record<string, unknown>>>`
      UPDATE auth.signing_requests
      SET status = 'executed'
      WHERE signing_request_id = ${input.requestId}
        AND account_id = ${input.accountId}
        AND status = 'signed'
      RETURNING *
    `;
    return rows[0] === undefined ? null : toSigningRequestFromRaw(rows[0]);
  }

  public async cancelPendingAndSignedForDevice(deviceId: string): Promise<number> {
    return this.database.$executeRaw`
      UPDATE auth.signing_requests
      SET status = 'cancelled'
      WHERE device_id = ${deviceId}
        AND status IN ('pending', 'signed')
    `;
  }

  public async markExpired(): Promise<number> {
    // No grace period: a signing request past its expires_at is simply
    // expired, unlike a device challenge (which needs the replay window to
    // distinguish REPLAYED from EXPIRED). Signing strictness is enforced by
    // markSigned's own `expires_at > now()` guard, not by pruning.
    return this.database.$executeRaw`
      UPDATE auth.signing_requests
      SET status = 'expired'
      WHERE status IN ('pending', 'signed')
        AND expires_at < now()
    `;
  }
}

// $queryRaw RETURNING * yields the snake_case columns, so the raw path maps
// through the column names while the Prisma-select path maps camelCase.
function toSigningRequestFromRaw(row: Record<string, unknown>): SigningRequest {
  return {
    id: String(row.signing_request_id ?? ""),
    accountId: String(row.account_id ?? ""),
    deviceId: String(row.device_id ?? ""),
    requestType: String(row.request_type ?? ""),
    amountMinor: row.amount_minor === null ? null : String(row.amount_minor ?? null),
    currency: row.currency === null ? null : String(row.currency ?? null),
    destination: toDestination(row.destination ?? null),
    createdBy: row.created_by as TxCreatedBy,
    status: String(row.status ?? "") as SigningRequestStatus,
    signedJws: row.signed_jws ?? null,
    signedAt: row.signed_at instanceof Date ? row.signed_at : null,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(0),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(0),
  };
}