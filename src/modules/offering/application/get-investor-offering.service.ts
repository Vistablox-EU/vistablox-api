import { AppError } from "../../../shared/errors/app-error.js";
import type { InvestorOfferingDetailResponse } from "../api/offering.schemas.js";
import { subtractCurrencyFloorZero } from "../domain/currency.js";
import {
  computeReservationBlockers,
  isInvestmentEligible,
  isKycCurrent,
  isLoginMethodsComplete,
} from "../domain/reservation-eligibility.policy.js";
import type { OfferingRepository } from "../repository/offering.repository.js";

export class GetInvestorOfferingService {
  public constructor(
    private readonly repository: OfferingRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly fundingRailAvailable = false,
  ) {}

  public async execute(input: {
    offeringId: string;
    accountId: string;
  }): Promise<InvestorOfferingDetailResponse> {
    const record = await this.repository.getInvestorDetail(input);
    if (record === null) {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }

    const now = this.clock();
    const kycCurrent = isKycCurrent({
      kycEligibilityState: record.accountReadiness.kycEligibilityState,
      kycRenewalDueAt: record.accountReadiness.kycRenewalDueAt,
      now,
    });
    const loginMethodsComplete = isLoginMethodsComplete(record.accountReadiness.loginMethods);
    const investmentEligible = isInvestmentEligible({
      accountStatus: record.accountReadiness.status,
      kycCurrent,
      loginMethodsComplete,
    });
    const remainingCapacityEur = subtractCurrencyFloorZero(
      record.targetRaiseEur,
      record.reservedCapacityEur,
    );
    // Kept closed (never true) until a go-live step deliberately wires this
    // to a verified Coinbase CDP readiness check (AD-255) — never create an
    // unfunded capacity hold here.
    const blockers = computeReservationBlockers({
      now,
      fundingRailAvailable: this.fundingRailAvailable,
      offeringStatus: record.status,
      hasDisclosurePack:
        record.currentDisclosurePack !== null && record.currentDisclosurePack.documents.length > 0,
      remainingCapacityEur,
      accountStatus: record.accountReadiness.status,
      kycEligibilityState: record.accountReadiness.kycEligibilityState,
      kycRenewalDueAt: record.accountReadiness.kycRenewalDueAt,
      loginMethods: record.accountReadiness.loginMethods,
      walletProvisioned: record.accountReadiness.walletProvisioned,
    });

    return {
      data: {
        id: record.id,
        status: record.status,
        terms: {
          minimum_raise_eur: record.minimumRaiseEur,
          target_raise_eur: record.targetRaiseEur,
          ipo_end_at: record.ipoEndAt?.toISOString() ?? null,
          final_offering_published_at:
            record.finalOfferingPublishedAt?.toISOString() ?? null,
          platform_rights_end_at: record.platformRightsEndAt?.toISOString() ?? null,
          effective_rights_end_at: record.effectiveRightsEndAt?.toISOString() ?? null,
        },
        progress: {
          reserved_capacity_eur: record.reservedCapacityEur,
          funded_eur: record.fundedEur,
          remaining_capacity_eur: remainingCapacityEur,
        },
        issuer: {
          piv_id: record.issuer.pivId,
          legal_name: record.issuer.legalName,
          jurisdiction: record.issuer.jurisdiction,
          registration_number: record.issuer.registrationNumber,
          structure_pattern: record.issuer.structurePattern,
          incorporated_at: record.issuer.incorporatedAt?.toISOString() ?? null,
        },
        property: {
          property_id: record.property.propertyId,
          property_type: record.property.propertyType,
          country_code: record.property.countryCode,
          city: record.property.city,
          address_line: record.property.addressLine,
          owner_declared_value_eur: record.property.ownerDeclaredValueEur,
          appraisal_value_opinion_eur: record.property.appraisalValueOpinionEur,
        },
        current_disclosure_pack:
          record.currentDisclosurePack === null
            ? null
            : {
                disclosure_pack_id: record.currentDisclosurePack.id,
                version: record.currentDisclosurePack.version,
                published_at: record.currentDisclosurePack.publishedAt.toISOString(),
                documents: record.currentDisclosurePack.documents.map((document) => ({
                  document_id: document.id,
                  document_type: document.documentType,
                  download_path: `/v1/offerings/${encodeURIComponent(record.id)}/documents/${encodeURIComponent(document.id)}/download`,
                  is_core_reading: document.isCoreReading,
                })),
              },
        change_log: record.materialityRecords.map((change) => ({
          materiality_record_id: change.id,
          description: change.changeDescription,
          classification: change.classification,
          reconfirmation_reset: change.resetTriggered,
          classified_at: change.classifiedAt.toISOString(),
        })),
        readiness: {
          investment_eligible: investmentEligible,
          payment_account_ready: record.accountReadiness.walletProvisioned,
          payout_account_verified: record.accountReadiness.payoutWalletRegistered,
        },
        reservation: {
          available: blockers.length === 0,
          blockers,
        },
      },
    };
  }
}
