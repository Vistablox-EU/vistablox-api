import { AppError } from "../../../shared/errors/app-error.js";
import type {
  ClassifyMaterialityBody,
  ClassifyMaterialityResponse,
} from "../api/offering-operations.schemas.js";
import type { MaterialityRepository } from "../repository/materiality.repository.js";

/**
 * AD-038: the materiality classification for a post-publication change,
 * performed by admin_operations ("assessed by legal and offering
 * ownership"). Recording a per_se_material or reviewed_material change
 * resets every already-reconfirmed reservation on the offering back to
 * awaiting_reconfirmation and restarts the full 168-hour reconfirmation
 * window (PAYMENT_FLOWS.md's Material-change rule); non_material changes
 * are logged only. See docs/investor-offering.md for the full rule and the
 * disclosure-pack-republication gap this deliberately does not build.
 */
export class ClassifyMaterialityService {
  public constructor(
    private readonly repository: MaterialityRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    offeringId: string;
    traceId: string;
    body: ClassifyMaterialityBody;
  }): Promise<ClassifyMaterialityResponse> {
    const result = await this.repository.classifyMateriality({
      offeringId: input.offeringId,
      accountId: input.accountId,
      changeDescription: input.body.change_description,
      classification: input.body.classification,
      thresholdType: input.body.threshold_type,
      traceId: input.traceId,
      classifiedAt: this.clock(),
    });

    if (result.conflict === "offering_not_found") {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }
    if (result.conflict === "no_active_reconfirmation_window") {
      throw new AppError({
        code: "offering.materiality_classification_not_available",
        title: "Materiality change cannot be recorded",
        status: 409,
        detail:
          "This offering has no active reconfirmation window — final terms must be published and not yet committed.",
      });
    }

    const classified = result.classified;
    if (classified === null) {
      throw new AppError({
        code: "internal.unexpected",
        title: "Internal server error",
        status: 500,
        detail: "Materiality classification returned neither a result nor a conflict.",
      });
    }

    return {
      data: {
        materiality_record_id: classified.materialityRecordId,
        offering_id: classified.offeringId,
        classification: classified.classification,
        threshold_type: classified.thresholdType,
        reset_triggered: classified.resetTriggered,
        classified_at: classified.classifiedAt.toISOString(),
        effective_rights_end_at: classified.effectiveRightsEndAt === null ? null : classified.effectiveRightsEndAt.toISOString(),
        reservations_reset: classified.reservationsReset,
      },
    };
  }
}
