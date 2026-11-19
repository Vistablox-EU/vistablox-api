import { createInvestorOfferingRouter } from "../modules/offering/api/offering.router.js";
import { createOfferingOperationsRouter } from "../modules/offering/api/offering-operations.router.js";
import { createOnrampLateEvidenceRouter } from "../modules/offering/api/onramp-late-evidence.router.js";
import { ListOnrampLateEvidenceService } from "../modules/offering/application/list-onramp-late-evidence.service.js";
import { MarkOnrampLateEvidenceReviewedService } from "../modules/offering/application/mark-onramp-late-evidence-reviewed.service.js";
import { GetInvestorOfferingService } from "../modules/offering/application/get-investor-offering.service.js";
import { DownloadDisclosureDocumentService } from "../modules/offering/application/download-disclosure-document.service.js";
import { CreateReservationService } from "../modules/offering/application/create-reservation.service.js";
import { ClassifyMaterialityService } from "../modules/offering/application/classify-materiality.service.js";
import { PublishDisclosurePackService } from "../modules/offering/application/publish-disclosure-pack.service.js";
import { UploadOfferingDocumentService } from "../modules/offering/application/upload-offering-document.service.js";
import { GetOfferingDocumentService } from "../modules/offering/application/get-offering-document.service.js";
import { FinalizeOfferingService } from "../modules/offering/application/finalize-offering.service.js";
import { ReconfirmReservationService } from "../modules/offering/application/reconfirm-reservation.service.js";
import { UpdateOfferingPresentationService } from "../modules/offering/application/update-offering-presentation.service.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

// Investor-facing and staff offering routes, mounted in the order the prefixes
// require ("/internal/v1/offerings/onramp-late-evidence" before "/internal/v1/offerings").
export function composeOffering(context: ProtectedApiContext): void {
  const { app, dependencies, requireAuthentication, requireAdminOperations, requireStaffWebAuthn, requireFreshAuthentication, reservationCreateIdempotency, reconfirmIdempotency, finalizeIdempotency } = context;
  app.use(
    "/v1/offerings",
    createInvestorOfferingRouter(
      requireAuthentication,
      new GetInvestorOfferingService(
        dependencies.offeringRepository,
        undefined,
        dependencies.reservationFundingRailEnabled ?? false,
      ),
      dependencies.protectedApi.disclosureDocuments === undefined
        ? undefined
        : new DownloadDisclosureDocumentService(
            dependencies.protectedApi.disclosureDocuments.repository,
            dependencies.protectedApi.disclosureDocuments.store,
          ),
      dependencies.protectedApi.reservations === undefined
        ? undefined
        : new CreateReservationService(
            dependencies.offeringRepository,
            dependencies.protectedApi.reservations.repository,
            dependencies.protectedApi.reservations.coinbase,
            {
              blockchain: dependencies.protectedApi.reservations.blockchain,
              buildRedirectUrl: dependencies.protectedApi.reservations.buildRedirectUrl,
              fundingRailAvailable: dependencies.reservationFundingRailEnabled ?? false,
            },
          ),
      dependencies.protectedApi.offeringOperations === undefined
        ? undefined
        : new ReconfirmReservationService(dependencies.protectedApi.offeringOperations.repository),
      requireFreshAuthentication,
      reservationCreateIdempotency === undefined || reconfirmIdempotency === undefined
        ? undefined
        : {
            createReservation: reservationCreateIdempotency,
            reconfirmReservation: reconfirmIdempotency,
          },
    ),
  );
  // Mounted before the offering-operations router, whose "/:offering_id/..." routes must not see this prefix.
  if (dependencies.protectedApi.onrampLateEvidence !== undefined) {
    const lateEvidence = dependencies.protectedApi.onrampLateEvidence;
    app.use(
      "/internal/v1/offerings/onramp-late-evidence",
      createOnrampLateEvidenceRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new ListOnrampLateEvidenceService(lateEvidence.repository),
        new MarkOnrampLateEvidenceReviewedService(lateEvidence.repository),
      ),
    );
  }
  if (dependencies.protectedApi.offeringOperations !== undefined) {
    const offeringDocuments = dependencies.protectedApi.offeringOperations.documents;
    const offeringPresentation = dependencies.protectedApi.offeringOperations.presentation;
    app.use(
      "/internal/v1/offerings",
      createOfferingOperationsRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new FinalizeOfferingService(dependencies.protectedApi.offeringOperations.repository),
        new ClassifyMaterialityService(dependencies.protectedApi.offeringOperations.repository),
        new PublishDisclosurePackService(dependencies.protectedApi.offeringOperations.repository),
        finalizeIdempotency,
        offeringDocuments === undefined
          ? undefined
          : {
              upload: new UploadOfferingDocumentService(offeringDocuments.repository, offeringDocuments.store, offeringDocuments.scanner),
              read: new GetOfferingDocumentService(offeringDocuments.repository, offeringDocuments.store),
            },
        offeringPresentation === undefined ? undefined : new UpdateOfferingPresentationService(offeringPresentation),
      ),
    );
  }
}
