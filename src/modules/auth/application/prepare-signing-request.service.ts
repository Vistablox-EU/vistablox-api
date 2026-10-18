import { AppError } from "../../../shared/errors/app-error.js";
import { SIGNING_REQUEST_STATUS_PENDING } from "../domain/signing-request.policy.js";
import type {
  CreateSigningRequestInput,
  SigningRequest,
  SigningRequestRepository,
} from "../repository/signing-request.repository.js";

/**
 * T1-side preparation: creates the `pending` signing request row the client
 * will later discover, challenge and sign. This is the seam the sensitive
 * routes (Phase 2 cut-over) call at action initiation, so request creation
 * always happens server-side with the server's own view of the action --
 * the client never proposes its own claims to store.
 */
export class PrepareSigningRequestService {
  public constructor(private readonly repository: SigningRequestRepository) {}

  public async execute(input: CreateSigningRequestInput): Promise<SigningRequest> {
    if (input.expiresAt.getTime() <= new Date().getTime()) {
      throw new AppError({
        code: "signing_request.invalid_expiry",
        title: "Invalid signing request",
        status: 422,
        detail: "A signing request cannot expire in the past.",
      });
    }
    return this.repository.create(input);
  }
}

export { SIGNING_REQUEST_STATUS_PENDING };

export { type SigningRequest };