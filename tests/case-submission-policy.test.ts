import { describe, expect, it } from "vitest";

import {
  evaluateCaseResubmission,
  evaluateInitialCaseSubmission,
  requiredInitialEvidenceTypes,
} from "../src/modules/origination/domain/case-submission.policy.js";

describe("initial case submission policy", () => {
  it("allows a draft with exactly one of every required evidence type", () => {
    expect(
      evaluateInitialCaseSubmission({
        stage: "draft",
        hasCurrentRevision: false,
        documentTypes: [...requiredInitialEvidenceTypes],
      }),
    ).toEqual({ allowed: true });
  });

  it.each([
    "submitted",
    "waiting_on_applicant",
    "pre_offering_open",
    "post_ipo_structuring",
    "approved_for_final_offering",
    "rejected",
    "withdrawn",
    "expired",
  ])("rejects initial submission from %s", (stage) => {
    expect(
      evaluateInitialCaseSubmission({
        stage,
        hasCurrentRevision: false,
        documentTypes: [...requiredInitialEvidenceTypes],
      }),
    ).toEqual({ allowed: false, reason: "invalid_stage" });
  });

  it("rejects a draft that already points to a revision", () => {
    expect(
      evaluateInitialCaseSubmission({
        stage: "draft",
        hasCurrentRevision: true,
        documentTypes: [...requiredInitialEvidenceTypes],
      }),
    ).toEqual({ allowed: false, reason: "already_has_revision" });
  });

  it("reports every missing required evidence type", () => {
    expect(
      evaluateInitialCaseSubmission({
        stage: "draft",
        hasCurrentRevision: false,
        documentTypes: ["photo_set"],
      }),
    ).toEqual({
      allowed: false,
      reason: "missing_evidence",
      missingEvidence: [
        "ownership_declaration",
        "property_facts_sheet",
        "encumbrance_declaration",
      ],
    });
  });

  it("rejects duplicate evidence types", () => {
    expect(
      evaluateInitialCaseSubmission({
        stage: "draft",
        hasCurrentRevision: false,
        documentTypes: [...requiredInitialEvidenceTypes, "photo_set"],
      }),
    ).toEqual({ allowed: false, reason: "duplicate_evidence" });
  });
});

describe("case resubmission policy", () => {
  it("allows a complete package for the current published request", () => {
    expect(
      evaluateCaseResubmission({
        stage: "waiting_on_applicant",
        hasCurrentRevision: true,
        requestStatus: "published",
        documentTypes: [...requiredInitialEvidenceTypes],
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects an answered request and a case outside the waiting stage", () => {
    expect(
      evaluateCaseResubmission({
        stage: "waiting_on_applicant",
        hasCurrentRevision: true,
        requestStatus: "answered",
        documentTypes: [...requiredInitialEvidenceTypes],
      }),
    ).toEqual({ allowed: false, reason: "invalid_stage" });
    expect(
      evaluateCaseResubmission({
        stage: "submitted",
        hasCurrentRevision: true,
        requestStatus: "published",
        documentTypes: [...requiredInitialEvidenceTypes],
      }),
    ).toEqual({ allowed: false, reason: "invalid_stage" });
  });
});
