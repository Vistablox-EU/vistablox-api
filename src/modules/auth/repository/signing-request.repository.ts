import type {
  SigningRequestStatus,
  TxCreatedBy,
  TxDestination,
} from "../domain/signing-request.policy.js";

/** The stored signing request as the repository hands it to services. */
export interface SigningRequest {
  id: string;
  accountId: string;
  deviceId: string;
  requestType: string;
  amountMinor: string | null;
  currency: string | null;
  destination: TxDestination | null;
  createdBy: TxCreatedBy;
  status: SigningRequestStatus;
  /** The plain device-auth JWS the device returned at T3 (off-chain types). */
  signedJws: unknown | null;
  signedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateSigningRequestInput {
  accountId: string;
  deviceId: string;
  requestType: string;
  amountMinor: string | null;
  currency: string | null;
  destination: TxDestination | null;
  createdBy: TxCreatedBy;
  expiresAt: Date;
  // Defaults to now(); injectable for deterministic tests.
  now?: Date;
}

export interface SigningRequestRepository {
  /** Creates a `pending` request row with a server-generated id. */
  create(input: CreateSigningRequestInput): Promise<SigningRequest>;
  /** A request owned by this account (T1 fetch / T2 / T3 ownership checks). */
  findOwned(requestId: string, accountId: string): Promise<SigningRequest | null>;
  /** The account's requests, newest first; optional `status` filter (T1 list). */
  listForAccount(accountId: string, status?: string): Promise<SigningRequest[]>;
  /**
   * Atomically transitions `pending` -> `signed`, recording the device's JWS
   * and the signing time. Succeeds only while the row is still `pending` and
   * its expiry is still in the future (database clock), so two racing T3
   * requests can't both win.
   */
  markSigned(input: {
    requestId: string;
    accountId: string;
    signedJws: unknown;
    signedAt: Date;
  }): Promise<SigningRequest | null>;
  /** Atomically transitions `signed` -> `executed` (off-chain dispatch done). */
  markExecuted(input: { requestId: string; accountId: string }): Promise<SigningRequest | null>;
  /**
   * D3 / recovery start: cancels every `pending`/`signed` request for a
   * device. Returns the number cancelled.
   */
  cancelPendingAndSignedForDevice(deviceId: string): Promise<number>;
  /**
   * Hourly prune: marks `pending`/`signed` requests whose `expires_at` has
   * passed `expired` on the database clock. Returns the number pruned.
   */
  markExpired(): Promise<number>;
}