export interface IntakeEntryPolicyInput {
  eligibilityState: string;
  proofOfAddressCurrentUntil: Date | null;
  now: Date;
  declaredValueCents: bigint;
  minimumValueCents: bigint;
  intakeTermsAccepted: boolean;
  oneTitleConfirmed: boolean;
  propertyType: string;
}

export type IntakeEntryDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "kyc_not_eligible"
        | "proof_of_address_required"
        | "terms_not_accepted"
        | "one_title_required"
        | "residential_only"
        | "property_value_below_minimum";
    };

export function evaluateIntakeEntry(input: IntakeEntryPolicyInput): IntakeEntryDecision {
  if (input.eligibilityState !== "eligible") {
    return { allowed: false, reason: "kyc_not_eligible" };
  }
  if (
    input.proofOfAddressCurrentUntil === null ||
    input.proofOfAddressCurrentUntil.getTime() <= input.now.getTime()
  ) {
    return { allowed: false, reason: "proof_of_address_required" };
  }
  if (!input.intakeTermsAccepted) {
    return { allowed: false, reason: "terms_not_accepted" };
  }
  if (!input.oneTitleConfirmed) {
    return { allowed: false, reason: "one_title_required" };
  }
  if (input.propertyType !== "residential") {
    return { allowed: false, reason: "residential_only" };
  }
  if (input.declaredValueCents < input.minimumValueCents) {
    return { allowed: false, reason: "property_value_below_minimum" };
  }
  return { allowed: true };
}
