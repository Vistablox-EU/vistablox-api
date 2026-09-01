import { AppError } from "../../../shared/errors/app-error.js";
import type { InvestorOfferingDetailResponse } from "../api/offering.schemas.js";
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
    const loginMethods = new Set(record.accountReadiness.loginMethods);
    const kycCurrent =
      record.accountReadiness.kycEligibilityState === "eligible" &&
      record.accountReadiness.kycRenewalDueAt !== null &&
      record.accountReadiness.kycRenewalDueAt > now;
    const loginMethodsComplete =
      loginMethods.has("google") && loginMethods.has("email_password");
    const investmentEligible =
      record.accountReadiness.status === "active" &&
      kycCurrent &&
      loginMethodsComplete;
    const remainingCapacityEur = subtractCurrencyFloorZero(
      record.targetRaiseEur,
      record.reservedCapacityEur,
    );
    const blockers: InvestorOfferingDetailResponse["data"]["reservation"]["blockers"] = [];

    if (record.accountReadiness.status !== "active") blockers.push("account_restricted");
    if (record.accountReadiness.kycEligibilityState !== "eligible") {
      blockers.push("kyc_not_eligible");
    } else if (!kycCurrent) {
      blockers.push("kyc_renewal_due");
    }
    if (!loginMethodsComplete) blockers.push("login_methods_incomplete");
    if (!record.accountReadiness.walletProvisioned) {
      blockers.push("payment_account_not_ready");
    }
    if (
      record.currentDisclosurePack === null ||
      record.currentDisclosurePack.documents.length === 0
    ) {
      blockers.push("disclosure_pack_unavailable");
    }
    if (record.status !== "pre_offering") blockers.push("offering_not_open");
    if (remainingCapacityEur === "0.00") blockers.push("capacity_exhausted");

    if (!this.fundingRailAvailable) {
      // The selected phase-1 EUR -> EURC rail is not currently implementable as
      // documented. Keep this provider-neutral capability closed until a supported
      // rail is selected; never create an unfunded capacity hold here.
      blockers.push("funding_rail_unavailable");
    }

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

function subtractCurrencyFloorZero(minuend: string, subtrahend: string): string {
  const remaining = toCents(minuend) - toCents(subtrahend);
  const cents = remaining > 0n ? remaining : 0n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function toCents(value: string): bigint {
  const [euros, fraction = "00"] = value.split(".");
  return BigInt(euros!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}
