import { describe, expect, it } from "vitest";

import {
  evaluateReversalActions,
  getReversalAction,
  reversalCommandSchema,
  type ReversalCommand,
  type ReversalSnapshot,
} from "../src/modules/intake/domain/intake-reversal.policy.js";

type OfferingSnapshot = NonNullable<ReversalSnapshot["offering"]>;

function offering(overrides: Partial<OfferingSnapshot> = {}): OfferingSnapshot {
  return {
    offeringId: "offering_01",
    status: "pre_offering",
    finalOfferingPublishedAt: null,
    reservationCount: 0,
    fundedReservationCount: 0,
    disclosurePackPublished: false,
    reconfirmationOpen: false,
    finalizedReservationCount: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ReversalSnapshot> = {}): ReversalSnapshot {
  return {
    stage: "submitted",
    workflowEventSequence: 7,
    latestTransition: { eventId: "evt_01", fromStage: "draft", toStage: "submitted" },
    latestTransitionReversed: false,
    activeInformationRequest: false,
    offering: null,
    legalExecutionCompleted: false,
    appraisalCompleted: false,
    correctionInProgress: false,
    ...overrides,
  };
}

function commandsFor(input: ReversalSnapshot): ReversalCommand[] {
  return evaluateReversalActions(input).map((action) => action.command);
}

const allStages = [
  "draft",
  "submitted",
  "waiting_on_applicant",
  "pre_offering_open",
  "post_ipo_structuring",
  "approved_for_final_offering",
  "rejected",
  "withdrawn",
  "expired",
] as const;

describe("intake reversal policy", () => {
  describe("which command each stage can offer when nothing blocks it", () => {
    const cleanSnapshots: Record<(typeof allStages)[number], ReversalSnapshot> = {
      draft: snapshot({ stage: "draft", latestTransition: null }),
      submitted: snapshot({ stage: "submitted" }),
      waiting_on_applicant: snapshot({
        stage: "waiting_on_applicant",
        latestTransition: { eventId: "evt_02", fromStage: "submitted", toStage: "waiting_on_applicant" },
        activeInformationRequest: true,
      }),
      pre_offering_open: snapshot({
        stage: "pre_offering_open",
        latestTransition: { eventId: "evt_03", fromStage: "submitted", toStage: "pre_offering_open" },
        offering: offering(),
      }),
      post_ipo_structuring: snapshot({
        stage: "post_ipo_structuring",
        latestTransition: { eventId: "evt_04", fromStage: "pre_offering_open", toStage: "post_ipo_structuring" },
        offering: offering({ status: "final_offering" }),
      }),
      approved_for_final_offering: snapshot({
        stage: "approved_for_final_offering",
        latestTransition: { eventId: "evt_05", fromStage: "post_ipo_structuring", toStage: "approved_for_final_offering" },
        offering: offering({ status: "final_offering" }),
      }),
      rejected: snapshot({ stage: "rejected" }),
      withdrawn: snapshot({ stage: "withdrawn" }),
      expired: snapshot({ stage: "expired" }),
    };

    it.each([
      ["draft", []],
      ["submitted", ["return_to_draft"]],
      ["waiting_on_applicant", ["withdraw_information_request"]],
      ["pre_offering_open", ["reopen_pre_offering"]],
      ["post_ipo_structuring", ["reopen_structuring"]],
      ["approved_for_final_offering", ["reopen_final_offering_review"]],
      ["rejected", []],
      ["withdrawn", []],
      ["expired", []],
    ] as const)("%s offers exactly %j", (stage, expected) => {
      expect(commandsFor(cleanSnapshots[stage])).toEqual(expected);
    });

    it("never offers a command from a stage other than its own", () => {
      for (const command of reversalCommandSchema.options) {
        const offeredFrom = allStages.filter((stage) => getReversalAction(cleanSnapshots[stage], command) !== null);
        expect(offeredFrom).toHaveLength(1);
      }
    });

    it("offers nothing from any stage while a correction is already in progress", () => {
      for (const stage of allStages) {
        expect(evaluateReversalActions({ ...cleanSnapshots[stage], correctionInProgress: true })).toEqual([]);
      }
    });

    it("offers nothing once the transition it would rewind has itself been rewound, because the ledger reverses an event only once", () => {
      for (const stage of allStages) {
        expect(evaluateReversalActions({ ...cleanSnapshots[stage], latestTransitionReversed: true })).toEqual([]);
      }
      // the same snapshots do offer their command when that transition is still standing
      expect(commandsFor({ ...cleanSnapshots.pre_offering_open, latestTransitionReversed: false })).toEqual(["reopen_pre_offering"]);
      expect(commandsFor({ ...cleanSnapshots.post_ipo_structuring, latestTransitionReversed: false })).toEqual(["reopen_structuring"]);
    });

    it("offers nothing from a terminal stage even when the rest of the snapshot looks reversible", () => {
      for (const stage of ["rejected", "withdrawn", "expired"]) {
        expect(
          evaluateReversalActions({
            ...cleanSnapshots.pre_offering_open,
            stage,
            activeInformationRequest: true,
          }),
        ).toEqual([]);
      }
    });
  });

  describe("action shape", () => {
    it("return_to_draft is a single-person synchronous correction back to draft", () => {
      expect(getReversalAction(snapshot(), "return_to_draft")).toMatchObject({
        command: "return_to_draft",
        targetStage: "draft",
        requiresSecondApproval: false,
        executionMode: "synchronous",
        blockers: [],
      });
    });

    it("withdraw_information_request is a single-person synchronous correction back to submitted", () => {
      expect(
        getReversalAction(
          snapshot({ stage: "waiting_on_applicant", activeInformationRequest: true }),
          "withdraw_information_request",
        ),
      ).toMatchObject({
        targetStage: "submitted",
        requiresSecondApproval: false,
        executionMode: "synchronous",
      });
    });

    it.each([
      ["pre_offering_open", "reopen_pre_offering", "submitted"],
      ["post_ipo_structuring", "reopen_structuring", "pre_offering_open"],
      ["approved_for_final_offering", "reopen_final_offering_review", "post_ipo_structuring"],
    ] as const)("%s -> %s needs a second approver and rewinds to %s", (stage, command, targetStage) => {
      expect(getReversalAction(snapshot({ stage, offering: offering() }), command)).toMatchObject({
        command,
        targetStage,
        requiresSecondApproval: true,
        executionMode: "asynchronous",
        blockers: [],
      });
    });

    it("returns null for a command the stage does not offer", () => {
      expect(getReversalAction(snapshot(), "reopen_structuring")).toBeNull();
    });
  });

  describe("return_to_draft preconditions", () => {
    it("is not offered when the latest transition was not into submitted", () => {
      expect(
        commandsFor(snapshot({ latestTransition: { eventId: "evt_09", fromStage: "waiting_on_applicant", toStage: "waiting_on_applicant" } })),
      ).toEqual([]);
    });

    it("is not offered when the case has no recorded transition", () => {
      expect(commandsFor(snapshot({ latestTransition: null }))).toEqual([]);
    });

    it("is not offered while an information request is active", () => {
      expect(commandsFor(snapshot({ activeInformationRequest: true }))).toEqual([]);
    });

    it("is not offered once an offering exists for the case", () => {
      expect(commandsFor(snapshot({ offering: offering() }))).toEqual([]);
    });
  });

  describe("withdraw_information_request preconditions", () => {
    it("needs an active information request", () => {
      expect(commandsFor(snapshot({ stage: "waiting_on_applicant", activeInformationRequest: false }))).toEqual([]);
    });
  });

  describe("reopen_pre_offering blockers", () => {
    const base = (overrides: Partial<OfferingSnapshot>) =>
      snapshot({ stage: "pre_offering_open", offering: offering(overrides) });

    it("is available for an offering with no activity at all", () => {
      expect(commandsFor(base({}))).toEqual(["reopen_pre_offering"]);
    });

    it("is not available without an offering to suspend", () => {
      expect(commandsFor(snapshot({ stage: "pre_offering_open", offering: null }))).toEqual([]);
    });

    it.each([
      ["reservations_exist", { reservationCount: 1 }],
      ["funding_exists", { fundedReservationCount: 1 }],
      ["disclosure_pack_published", { disclosurePackPublished: true }],
      ["final_terms_published", { finalOfferingPublishedAt: new Date("2026-09-01T00:00:00.000Z") }],
      ["reconfirmation_open", { reconfirmationOpen: true }],
      ["offering_finalized", { finalizedReservationCount: 1 }],
    ] as const)("%s alone blocks it", (_blocker, overrides) => {
      expect(commandsFor(base(overrides))).toEqual([]);
    });

    it("stays blocked when several blockers hold at once", () => {
      expect(commandsFor(base({ reservationCount: 3, fundedReservationCount: 2, disclosurePackPublished: true }))).toEqual([]);
    });
  });

  describe("reopen_structuring blockers", () => {
    const base = (overrides: Partial<ReversalSnapshot> = {}, offeringOverrides: Partial<OfferingSnapshot> = {}) =>
      snapshot({ stage: "post_ipo_structuring", offering: offering(offeringOverrides), ...overrides });

    it("is available with a clean offering", () => {
      expect(commandsFor(base())).toEqual(["reopen_structuring"]);
    });

    it("is available when the case has no offering row at all", () => {
      expect(commandsFor(base({ offering: null }))).toEqual(["reopen_structuring"]);
    });

    it.each([
      ["final_terms_published", {}, { finalOfferingPublishedAt: new Date("2026-09-01T00:00:00.000Z") }],
      ["reconfirmation_open", {}, { reconfirmationOpen: true }],
      ["offering_finalized", {}, { finalizedReservationCount: 1 }],
      ["legal_execution_completed", { legalExecutionCompleted: true }, {}],
      ["appraisal_completed", { appraisalCompleted: true }, {}],
    ] as const)("%s alone blocks it", (_blocker, snapshotOverrides, offeringOverrides) => {
      expect(commandsFor(base(snapshotOverrides, offeringOverrides))).toEqual([]);
    });

    it("is not blocked by reservations or funding, which only matter before the IPO closes", () => {
      expect(commandsFor(base({}, { reservationCount: 4, fundedReservationCount: 4, disclosurePackPublished: true }))).toEqual([
        "reopen_structuring",
      ]);
    });
  });

  describe("reopen_final_offering_review blockers", () => {
    const base = (offeringOverrides: Partial<OfferingSnapshot> = {}) =>
      snapshot({ stage: "approved_for_final_offering", offering: offering(offeringOverrides) });

    it("is available with a clean offering", () => {
      expect(commandsFor(base())).toEqual(["reopen_final_offering_review"]);
    });

    it.each([
      ["final_terms_published", { finalOfferingPublishedAt: new Date("2026-09-01T00:00:00.000Z") }],
      ["reconfirmation_open", { reconfirmationOpen: true }],
      ["offering_finalized", { finalizedReservationCount: 1 }],
    ] as const)("%s alone blocks it", (_blocker, overrides) => {
      expect(commandsFor(base(overrides))).toEqual([]);
    });

    it("ignores legal and appraisal completion, which structuring already recorded", () => {
      expect(
        commandsFor(
          snapshot({
            stage: "approved_for_final_offering",
            offering: offering(),
            legalExecutionCompleted: true,
            appraisalCompleted: true,
          }),
        ),
      ).toEqual(["reopen_final_offering_review"]);
    });
  });
});
