import {
  DeviceChallengeExpiredError,
  DeviceChallengeReplayedError,
} from "./device-auth-errors.js";
import { isDeviceAuthJwsVerificationError, verifyDeviceAuthJws } from "./device-auth-jws-verifier.js";
import {
  SIGNING_JWS_PURPOSE,
  SIGNING_REQUEST_STATUS_EXECUTED,
  SIGNING_REQUEST_STATUS_PENDING,
  compareTxClaimsToRequest,
} from "../domain/signing-request.policy.js";
import type { Device, DeviceRepository } from "../repository/device.repository.js";
import type { DeviceChallengeRepository } from "../repository/device-challenge.repository.js";
import type { SigningRequest, SigningRequestRepository } from "../repository/signing-request.repository.js";
import {
  SigningRequestAlreadyConsumedError,
  SigningRequestCancelledError,
  SigningRequestExpiredError,
  SigningRequestNotFoundError,
  TxFieldMismatchError,
  TxSignatureInvalidError,
  TxWrongDeviceError,
} from "./signing-request-errors.js";

const TX_CHALLENGE_TTL_SECONDS = 120;

/**
 * T3 (off-chain types): the server authorizes a signing request -- consume
 * the single-use `tx` challenge bound to the session's DPoP key, verify the
 * device-signed JWS against the device's stored biometric key, compare the
 * signed `tx` claims field-by-field against the stored request, then mark
 * the request `signed`, atomically.
 *
 * Ordering mirrors login (resolve device -> consume challenge -> verify
 * JWS): the challenge is spent before the JWS, so a JWS that never arrives
 * can't leave a spendable challenge dangling; a failed claim comparison
 * (confused-deputy, TX_FIELD_MISMATCH) and a failed signature both burn the
 * challenge, forcing a fresh T2 -- the retry story the contract intends.
 *
 * This phase has no request-type executors (Phase 2 wires those), so
 * completion stops at `signed` and T3 answers the request's resulting
 * status. Phase 2's dispatcher flips the same row to `executed` once the the
 * off-chain action has actually run (the plan's "backend dispatches by
 * request_type" path).
 */
export class AuthorizeSigningRequestService {
  public constructor(
    private readonly challengeRepository: DeviceChallengeRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly requestRepository: SigningRequestRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    requestId: string;
    accountId: string;
    /** From the session's DPoP proof (contract 3.1): the signing device. */
    dpopJkt: string;
    challenge: string;
    jws: string;
  }): Promise<SigningRequest> {
    // Contract 3.1 + line 492: the signing device is the one this request's
    // DPoP key belongs to. A revoked device is never returned by
    // findByDpopJkt, so this is also the device-revoked gate.
    const device = await this.deviceRepository.findByDpopJkt(input.dpopJkt);
    if (device === null) {
      throw new TxWrongDeviceError();
    }

    const request = await this.requestRepository.findOwned(input.requestId, input.accountId);
    if (request === null) {
      throw new SigningRequestNotFoundError();
    }

    this.assertRequestSignable(request);

    // Cross-check before the challenge is spent: a device must only ever
    // sign its own request (plan line 492's "same device record" rule).
    if (request.deviceId !== device.deviceId) {
      throw new TxWrongDeviceError();
    }

    const consumed = await this.challengeRepository.consume({
      challenge: input.challenge,
      purpose: SIGNING_JWS_PURPOSE,
      dpopJkt: input.dpopJkt,
      deviceId: device.deviceId,
    });
    if (!consumed) {
      const recentlyUsed = await this.challengeRepository.wasConsumedWithinReplayWindow({
        challenge: input.challenge,
        purpose: SIGNING_JWS_PURPOSE,
        dpopJkt: input.dpopJkt,
        deviceId: device.deviceId,
      });
      throw recentlyUsed ? new DeviceChallengeReplayedError() : new DeviceChallengeExpiredError();
    }

    let claims;
    try {
      claims = await verifyDeviceAuthJws({
        jws: input.jws,
        expectedPurpose: SIGNING_JWS_PURPOSE,
        expectedChallenge: input.challenge,
        expectedDeviceId: device.deviceId,
        storedPublicJwk: device.biometricPublicJwk,
        expectedDpopJkt: undefined,
        now: this.clock(),
      });
    } catch (error) {
      if (isDeviceAuthJwsVerificationError(error)) {
        // Same code as a bad signature for every failure mode (bad purpose,
        // bad challenge, stale iat, bad kid): TX_SIGNATURE_INVALID (401).
        throw new TxSignatureInvalidError(error.message);
      }
      throw error;
    }

    if (claims.txClaims === undefined) {
      // The verifier only surfaces txClaims for the `tx` purpose, and the
      // purpose was checked above -- this is unreachable unless the verifier
      // and the purpose constant drift apart. Guard it anyway.
      throw new TxSignatureInvalidError("the JWS carried no tx claims");
    }
    const comparison = compareTxClaimsToRequest(claims.txClaims, request);
    if (!comparison.match) {
      throw new TxFieldMismatchError(comparison.field, comparison.expected, comparison.provided);
    }

    // Atomic pending -> signed: only the request that is still `pending` and
    // not yet expired on the database clock may win. A concurrent prune or a
    // racing T3 makes this return null, never a double-sign.
    const signed = await this.requestRepository.markSigned({
      requestId: input.requestId,
      accountId: input.accountId,
      signedJws: input.jws,
      signedAt: this.clock(),
    });
    if (signed === null) {
      throw new SigningRequestAlreadyConsumedError();
    }
    return signed;
  }

  private assertRequestSignable(request: SigningRequest): void {
    if (request.status === SIGNING_REQUEST_STATUS_EXECUTED) {
      throw new SigningRequestAlreadyConsumedError();
    }
    // Lazy expiry: the hourly prune flips status, but a request that has
    // simply aged past expires_at without running the prune must still read
    // REQUEST_EXPIRED here, from the stored data.
    if (request.expiresAt.getTime() < this.clock().getTime()) {
      throw new SigningRequestExpiredError();
    }
    switch (request.status) {
      case "expired":
        throw new SigningRequestExpiredError();
      case "cancelled":
        throw new SigningRequestCancelledError();
      case "pending":
        return;
      default:
        // signed/submitted/included: the ceremony already ran once.
        throw new SigningRequestAlreadyConsumedError();
    }
  }
}

export { TX_CHALLENGE_TTL_SECONDS, SIGNING_REQUEST_STATUS_PENDING };