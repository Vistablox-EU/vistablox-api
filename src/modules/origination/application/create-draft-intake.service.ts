import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CreateDraftIntakeBody,
  CreateDraftIntakeResponse,
} from "../api/origination.schemas.js";
import { evaluateIntakeEntry } from "../domain/intake-entry.policy.js";
import type { OriginationRepository } from "../repository/origination.repository.js";

export class CreateDraftIntakeService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    traceId: string;
    body: CreateDraftIntakeBody;
  }): Promise<CreateDraftIntakeResponse> {
    const prerequisites = await this.repository.getIntakePrerequisites(input.accountId);
    const decision = evaluateIntakeEntry({
      eligibilityState: prerequisites.eligibilityState,
      proofOfAddressCurrentUntil: prerequisites.proofOfAddressCurrentUntil,
      now: this.clock(),
      declaredValueCents: moneyToCents(input.body.property.owner_declared_value_eur),
      minimumValueCents: moneyToCents(prerequisites.minimumPropertyValueEur),
      intakeTermsAccepted: input.body.intake_terms_accepted,
      oneTitleConfirmed: input.body.one_title_confirmed,
      propertyType: input.body.property.property_type,
    });

    if (!decision.allowed) {
      throw intakePolicyError(decision.reason, prerequisites.minimumPropertyValueEur);
    }

    const created = await this.repository.createDraftIntake({
      accountId: input.accountId,
      traceId: input.traceId,
      property: {
        countryCode: input.body.property.country_code,
        city: input.body.property.city,
        addressLine: input.body.property.address_line,
        landRegistryReference: input.body.property.land_registry_reference,
        latitude: input.body.property.latitude,
        longitude: input.body.property.longitude,
        ownerDeclaredValueEur: input.body.property.owner_declared_value_eur,
        hasExistingEncumbrance: input.body.property.has_existing_encumbrance,
      },
    });

    return {
      data: {
        case_id: created.caseId,
        property_id: created.propertyId,
        stage: created.stage,
      },
    };
  }
}

function moneyToCents(value: string): bigint {
  const [euros, cents] = value.split(".");
  if (euros === undefined || cents === undefined) {
    throw new Error("Money value must contain two decimal places");
  }
  return BigInt(euros) * 100n + BigInt(cents);
}

function intakePolicyError(reason: string, minimumValue: string): AppError {
  const errors: Record<string, AppError> = {
    kyc_not_eligible: new AppError({
      code: "identity.kyc_required",
      title: "Identity verification required",
      status: 403,
      detail: "Eligible KYC status is required before starting property intake.",
    }),
    proof_of_address_required: new AppError({
      code: "identity.proof_of_address_required",
      title: "Current proof of address required",
      status: 403,
      detail: "A current proof of address is required for owner-side property intake.",
    }),
    terms_not_accepted: new AppError({
      code: "origination.terms_required",
      title: "Intake terms required",
      status: 422,
      detail: "The owner intake terms must be accepted.",
    }),
    one_title_required: new AppError({
      code: "origination.one_title_required",
      title: "One title per case",
      status: 422,
      detail: "A phase-1 intake case must cover exactly one title or deed.",
    }),
    residential_only: new AppError({
      code: "origination.residential_only",
      title: "Residential property required",
      status: 422,
      detail: "Only residential property is accepted in phase 1.",
    }),
    property_value_below_minimum: new AppError({
      code: "origination.property_value_below_minimum",
      title: "Property value below minimum",
      status: 422,
      detail: `The owner-declared property value must be at least EUR ${minimumValue}.`,
      fieldErrors: [
        {
          field: "property.owner_declared_value_eur",
          code: "number.min",
          message: `Value must be at least EUR ${minimumValue}.`,
        },
      ],
    }),
  };
  return errors[reason] ?? new AppError({
    code: "origination.intake_not_allowed",
    title: "Property intake not allowed",
    status: 422,
    detail: "The property intake request is not allowed.",
  });
}
