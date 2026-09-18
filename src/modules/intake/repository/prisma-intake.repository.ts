import type { PgBoss } from "pg-boss";
import { ulid } from "ulid";
import { z } from "zod";

import { Prisma } from "../../../generated/prisma/client.js";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { enqueueTransactionalJob } from "../../../shared/jobs/enqueue-job.js";
import type { KycEligibilityReader } from "../../identity/repository/kyc-eligibility-reader.js";
import {
  ApplicantAccountNotFoundError,
  CaseSubmissionConflictError,
  EvidenceCaseMismatchError,
  EvidenceNotFoundError,
} from "./intake.repository.js";
import type {
  PostIpoStructuringHandoffRepository,
  TransitionedToPostIpoStructuring,
  TransitionToPostIpoStructuringInput,
} from "./post-ipo-structuring-handoff.repository.js";
import type {
  AssignedPartnerOrganization,
  AssignPartnerOrganizationInput,
  CaseMessageRecord,
  CasePartnerAssignment,
  ClosedCase,
  CloseCaseInput,
  FounderDecisionInput,
  CreateDraftIntakeInput,
  CreatedDraftIntake,
  CreatedStaffCase,
  CreateStaffCaseInput,
  InformationRequestRecord,
  IntakePrerequisites,
  OperationsCaseDetail,
  IntakeCaseCursor,
  IntakeRepository,
  OwnedIntakeCase,
  PartnerCaseDetail,
  PublishedInformationRequest,
  PublishedInformationRequestForTimer,
  RecordAppraisalInput,
  RecordedFounderDecision,
  RecordLegalStructuringInput,
  ResubmittedCase,
  ReviewedEvidence,
  ReviewEvidenceInput,
  SubmitInitialCaseInput,
  SubmittedCase,
  ThreadLane,
  WithdrawnInformationRequest,
} from "./intake.repository.js";
import { CaseReviewConflictError } from "./intake.repository.js";

const propertyFloorSettingSchema = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal("EUR"),
});

const responseWindowSettingSchema = z.object({
  business_days: z.number().int().min(1).max(60),
});

const reminderDaysSettingSchema = z.object({
  business_days: z.array(z.number().int().min(1).max(60)).min(1),
});

export class PrismaIntakeRepository
  implements IntakeRepository, PostIpoStructuringHandoffRepository
{
  public constructor(
    private readonly database: DatabaseClient,
    private readonly pgBoss: PgBoss,
    private readonly kycEligibilityReader: KycEligibilityReader,
  ) {}

  public async getIntakePrerequisites(
    accountId: string,
  ): Promise<IntakePrerequisites> {
    const [eligibility, minimumPropertyValueEur] = await Promise.all([
      this.kycEligibilityReader.getEligibilitySnapshot(accountId),
      this.getMinimumPropertyValueEur(),
    ]);

    return {
      eligibilityState: eligibility?.eligibilityState ?? "not_started",
      proofOfAddressCurrentUntil:
        eligibility?.proofOfAddressCurrentUntil ?? null,
      minimumPropertyValueEur,
    };
  }

  public async getMinimumPropertyValueEur(): Promise<string> {
    const floorSetting = await this.database.platformSetting.findUnique({
      where: { key: "intake.minimum_property_value_eur" },
      select: { value: true },
    });
    if (floorSetting === null) {
      throw new Error(
        "Missing intake.minimum_property_value_eur platform setting",
      );
    }
    return propertyFloorSettingSchema.parse(floorSetting.value).amount;
  }

  public async createDraftIntake(
    input: CreateDraftIntakeInput,
  ): Promise<CreatedDraftIntake> {
    const propertyId = `prop_${ulid()}`;
    const caseId = `case_${ulid()}`;

    await this.database.$transaction(async (transaction) => {
      await transaction.property.create({
        data: {
          id: propertyId,
          propertyType: "residential",
          countryCode: input.property.countryCode,
          city: input.property.city,
          addressLine: input.property.addressLine,
          landRegistryReference: input.property.landRegistryReference,
          latitude: input.property.latitude,
          longitude: input.property.longitude,
          ownerDeclaredValueEur: input.property.ownerDeclaredValueEur,
          hasExistingEncumbrance: input.property.hasExistingEncumbrance,
          residentialSubtype: input.property.residentialSubtype,
          livingAreaSqM: input.property.livingAreaSqM,
          bedrooms: input.property.bedrooms,
          bathrooms: input.property.bathrooms,
          floor: input.property.floor,
          totalFloors: input.property.totalFloors,
          yearBuilt: input.property.yearBuilt,
          condition: input.property.condition,
          energyRating: input.property.energyRating,
        },
      });
      if (input.property.rooms.length > 0) {
        await transaction.propertyRoom.createMany({
          data: input.property.rooms.map((room) => ({
            id: `room_${ulid()}`,
            propertyId,
            roomType: room.roomType,
            sizeSqM: room.sizeSqM,
          })),
        });
      }
      await transaction.intakeCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: input.accountId,
          stage: "draft",
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "intake.case_draft_created",
          resourceType: "intake_case",
          resourceId: caseId,
          changes: {
            trace_id: input.traceId,
            stage: "draft",
            property_id: propertyId,
          },
        },
      });
    });

    return { caseId, propertyId, stage: "draft" };
  }

  public async createStaffCase(
    input: CreateStaffCaseInput,
  ): Promise<CreatedStaffCase> {
    const propertyId = `prop_${ulid()}`;
    const caseId = `case_${ulid()}`;
    const revisionId = `rev_${ulid()}`;

    return this.database.$transaction(async (transaction) => {
      const applicant = await transaction.account.findUnique({
        where: { id: input.applicantAccountId },
        select: { id: true },
      });
      if (applicant === null) {
        throw new ApplicantAccountNotFoundError(input.applicantAccountId);
      }

      await transaction.property.create({
        data: {
          id: propertyId,
          propertyType: "residential",
          countryCode: input.property.countryCode,
          city: input.property.city,
          addressLine: input.property.addressLine,
          landRegistryReference: input.property.landRegistryReference,
          latitude: null,
          longitude: null,
          ownerDeclaredValueEur: input.property.ownerDeclaredValueEur,
          hasExistingEncumbrance: input.property.hasExistingEncumbrance,
          residentialSubtype: input.property.residentialSubtype,
          livingAreaSqM: input.property.livingAreaSqM,
          bedrooms: input.property.bedrooms,
          bathrooms: input.property.bathrooms,
          floor: input.property.floor,
          totalFloors: input.property.totalFloors,
          yearBuilt: input.property.yearBuilt,
          condition: input.property.condition,
          energyRating: input.property.energyRating,
        },
      });
      if (input.property.rooms.length > 0) {
        await transaction.propertyRoom.createMany({
          data: input.property.rooms.map((room) => ({
            id: `room_${ulid()}`,
            propertyId,
            roomType: room.roomType,
            sizeSqM: room.sizeSqM,
          })),
        });
      }
      await transaction.intakeCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: input.applicantAccountId,
          stage: "draft",
        },
      });

      const submittedAt = new Date();
      await transaction.submissionRevision.create({
        data: {
          id: revisionId,
          caseId,
          revisionNumber: 1,
          submittedAt,
          submittedByAccountId: input.staffAccountId,
          submissionData: input.submissionData as Prisma.InputJsonObject,
          reason: "initial_staff_created",
        },
      });
      await transaction.documentaryScreeningEvidence.createMany({
        data: input.documents.map((document) => ({
          id: `evidence_${ulid()}`,
          caseId,
          submissionRevisionId: revisionId,
          documentType: document.documentType,
          status: "pending",
          documentRef: document.documentRef,
          extractDated: document.extractDated,
        })),
      });
      await transaction.intakeCase.update({
        where: { id: caseId },
        data: {
          stage: "submitted",
          currentSubmissionRevisionId: revisionId,
          updatedAt: submittedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.staffAccountId,
          action: "intake.case_created_by_staff",
          resourceType: "intake_case",
          resourceId: caseId,
          changes: {
            trace_id: input.traceId,
            applicant_account_id: input.applicantAccountId,
            staff_actor_account_id: input.staffAccountId,
            property_id: propertyId,
            revision_id: revisionId,
            stage: "submitted",
          },
        },
      });

      return {
        caseId,
        revisionId,
        revisionNumber: 1 as const,
        stage: "submitted" as const,
        submittedAt,
        applicantAccountId: input.applicantAccountId,
      };
    });
  }

  public async listOwnedCases(input: {
    accountId: string;
    limit: number;
    after?: IntakeCaseCursor;
  }): Promise<OwnedIntakeCase[]> {
    const cases = await this.database.intakeCase.findMany({
      where: {
        applicantAccountId: input.accountId,
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                {
                  createdAt: input.after.createdAt,
                  id: { lt: input.after.id },
                },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: ownedCaseSelect,
    });

    return cases.map(toOwnedCase);
  }

  public async getOwnedCase(
    accountId: string,
    caseId: string,
  ): Promise<OwnedIntakeCase | null> {
    const intakeCase = await this.database.intakeCase.findFirst({
      where: { id: caseId, applicantAccountId: accountId },
      select: ownedCaseSelect,
    });
    return intakeCase === null ? null : toOwnedCase(intakeCase);
  }

  public async submitInitialCase(
    input: SubmitInitialCaseInput,
  ): Promise<SubmittedCase | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
          AND applicant_account_id = ${input.accountId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        return null;
      }

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true, currentSubmissionRevisionId: true },
      });
      if (
        current.stage !== "draft" ||
        current.currentSubmissionRevisionId !== null
      ) {
        throw new CaseSubmissionConflictError(current.stage);
      }

      const revisionId = `rev_${ulid()}`;
      const submittedAt = new Date();
      await transaction.submissionRevision.create({
        data: {
          id: revisionId,
          caseId: input.caseId,
          revisionNumber: 1,
          submittedAt,
          submittedByAccountId: input.accountId,
          submissionData: input.submissionData as Prisma.InputJsonObject,
          reason: "initial",
        },
      });
      await transaction.documentaryScreeningEvidence.createMany({
        data: input.documents.map((document) => ({
          id: `evidence_${ulid()}`,
          caseId: input.caseId,
          submissionRevisionId: revisionId,
          documentType: document.documentType,
          status: "pending",
          documentRef: document.documentRef,
          extractDated: document.extractDated,
        })),
      });
      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          stage: "submitted",
          currentSubmissionRevisionId: revisionId,
          updatedAt: submittedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "intake.case_submitted",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: "draft",
            new_stage: "submitted",
            revision_id: revisionId,
            revision_number: 1,
          },
        },
      });

      return {
        caseId: input.caseId,
        revisionId,
        revisionNumber: 1,
        stage: "submitted",
        submittedAt,
      };
    });
  }

  public async listCasesForOperations(input: {
    limit: number;
    stage?: string;
    after?: IntakeCaseCursor;
  }): Promise<OwnedIntakeCase[]> {
    const cases = await this.database.intakeCase.findMany({
      where: {
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                {
                  createdAt: input.after.createdAt,
                  id: { lt: input.after.id },
                },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: ownedCaseSelect,
    });
    return cases.map(toOwnedCase);
  }

  public async getCaseForOperations(
    caseId: string,
  ): Promise<OperationsCaseDetail | null> {
    const intakeCase = await this.database.intakeCase.findUnique({
      where: { id: caseId },
      select: {
        ...ownedCaseSelect,
        applicantAccountId: true,
        founderReviewNotes: true,
        reviewedByAccountId: true,
        approvedAt: true,
        rejectedAt: true,
        rejectionReasonCode: true,
        rejectionNotes: true,
        ipoPeriodDays: true,
        ipoEndAt: true,
        ipoValueEur: true,
        legalPracticeId: true,
        appraisalFirmId: true,
        // One case -> Piv is one-to-many in the schema (no unique
        // constraint on pivs.case_id), though in practice there is at most
        // one -- a Piv is only ever created against the case's own single
        // property (openOfferingForApprovedCase), and Piv.property_id is
        // itself unique. id desc (piv_${ulid()}, lexicographically
        // chronological) is a defensive tiebreak if that ever changes.
        // Offering under a Piv is a genuine one-to-many with no "current"
        // flag (unlike disclosure_packs.is_current) and no unique
        // constraint on offerings.piv_id -- but nothing in the application
        // today creates a second Offering for an existing Piv;
        // openOfferingForApprovedCase reuses the existing one instead of
        // creating another. createdAt/id desc picks the most recent if that
        // invariant is ever violated. Nested here (not a separate query) to
        // keep this a single round-trip.
        pivs: {
          orderBy: { id: "desc" },
          take: 1,
          select: {
            offerings: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1,
              select: {
                id: true,
                status: true,
                finalOfferingPublishedAt: true,
              },
            },
          },
        },
        currentSubmissionRevision: {
          select: {
            id: true,
            revisionNumber: true,
            submittedAt: true,
            submittedByAccountId: true,
            submissionData: true,
            evidence: {
              orderBy: [{ documentType: "asc" }, { id: "asc" }],
              select: {
                id: true,
                documentType: true,
                status: true,
                documentRef: true,
                extractDated: true,
                uploadedAt: true,
                reviewedByAccountId: true,
                reviewedAt: true,
                reviewNotes: true,
              },
            },
          },
        },
        informationRequests: {
          orderBy: [{ proposedAt: "desc" }, { id: "desc" }],
          select: informationRequestSelect,
        },
      },
    });
    if (intakeCase === null) return null;

    const owned = toOwnedCase({
      ...intakeCase,
      currentSubmissionRevision:
        intakeCase.currentSubmissionRevision === null
          ? null
          : {
              revisionNumber:
                intakeCase.currentSubmissionRevision.revisionNumber,
              submittedAt:
                intakeCase.currentSubmissionRevision.submittedAt,
            },
    });
    const latestOffering = intakeCase.pivs[0]?.offerings[0];
    return {
      ...owned,
      applicantAccountId: intakeCase.applicantAccountId,
      founderReviewNotes: intakeCase.founderReviewNotes,
      reviewedByAccountId: intakeCase.reviewedByAccountId,
      approvedAt: intakeCase.approvedAt,
      rejectedAt: intakeCase.rejectedAt,
      rejectionReasonCode: intakeCase.rejectionReasonCode,
      rejectionNotes: intakeCase.rejectionNotes,
      ipoPeriodDays: intakeCase.ipoPeriodDays,
      ipoEndAt: intakeCase.ipoEndAt,
      ipoValueEur: intakeCase.ipoValueEur?.toFixed(2) ?? null,
      legalPracticeId: intakeCase.legalPracticeId,
      appraisalFirmId: intakeCase.appraisalFirmId,
      offering:
        latestOffering === undefined
          ? null
          : {
              offeringId: latestOffering.id,
              status: latestOffering.status,
              finalOfferingPublishedAt: latestOffering.finalOfferingPublishedAt,
            },
      submission:
        intakeCase.currentSubmissionRevision === null
          ? null
          : {
              revisionId: intakeCase.currentSubmissionRevision.id,
              revisionNumber:
                intakeCase.currentSubmissionRevision.revisionNumber,
              submittedAt:
                intakeCase.currentSubmissionRevision.submittedAt,
              submittedByAccountId:
                intakeCase.currentSubmissionRevision.submittedByAccountId,
              submissionData:
                intakeCase.currentSubmissionRevision.submissionData,
              evidence: intakeCase.currentSubmissionRevision.evidence.map(
                (evidence) => ({
                  evidenceId: evidence.id,
                  documentType: evidence.documentType,
                  status: evidence.status,
                  documentRef: evidence.documentRef,
                  extractDated: evidence.extractDated,
                  uploadedAt: evidence.uploadedAt,
                  reviewedByAccountId: evidence.reviewedByAccountId,
                  reviewedAt: evidence.reviewedAt,
                  reviewNotes: evidence.reviewNotes,
                }),
              ),
            },
      informationRequests:
        intakeCase.informationRequests.map(toInformationRequest),
    };
  }

  public async getOperationsReadiness(caseId: string) {
    // A single Prisma read transaction keeps the case, offering and funding
    // projection on one database snapshot; this endpoint never writes.
    return this.database.$transaction(async (transaction) => {
      const row = await transaction.intakeCase.findUnique({
        where: { id: caseId },
        select: {
          id: true,
          stage: true,
          legalPracticeId: true,
          legalStructuringCompletedAt: true,
          appraisalFirmId: true,
          appraisalCompletedAt: true,
          reviewedByAccountId: true,
          approvedAt: true,
          rejectedAt: true,
          ipoPeriodDays: true,
          ipoValueEur: true,
          ipoEndAt: true,
          currentSubmissionRevision: {
            select: {
              revisionNumber: true,
              evidence: { select: { documentType: true, status: true } },
            },
          },
          pivs: {
            orderBy: { id: "desc" },
            take: 1,
            select: {
              offerings: {
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 1,
                select: {
                  id: true,
                  status: true,
                  minimumRaiseEur: true,
                  targetRaiseEur: true,
                  finalOfferingPublishedAt: true,
                  platformRightsEndAt: true,
                  effectiveRightsEndAt: true,
                  disclosurePacks: {
                    where: { isCurrent: true, supersededAt: null },
                    orderBy: [{ version: "desc" }, { id: "desc" }],
                    take: 1,
                    select: {
                      id: true,
                      version: true,
                      publishedAt: true,
                      documents: { select: { documentType: true } },
                    },
                  },
                  reservations: {
                    select: {
                      reservationStage: true,
                      amountEur: true,
                      moneyEvents: {
                        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
                        take: 1,
                        select: { capitalState: true, amountEur: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!row) return null;
      const offering = row.pivs[0]?.offerings[0];
      return {
        caseId: row.id,
        stage: row.stage,
        submission:
          row.currentSubmissionRevision === null
            ? null
            : {
                revisionNumber: row.currentSubmissionRevision.revisionNumber,
                evidence: row.currentSubmissionRevision.evidence,
              },
        legalPracticeId: row.legalPracticeId,
        legalStructuringCompletedAt: row.legalStructuringCompletedAt,
        appraisalFirmId: row.appraisalFirmId,
        appraisalCompletedAt: row.appraisalCompletedAt,
        founder: {
          reviewedByAccountId: row.reviewedByAccountId,
          approvedAt: row.approvedAt,
          rejectedAt: row.rejectedAt,
          ipoPeriodDays: row.ipoPeriodDays,
          ipoValueEur: row.ipoValueEur?.toFixed(2) ?? null,
          ipoEndAt: row.ipoEndAt,
        },
        offering:
          offering === undefined
            ? null
            : {
                offeringId: offering.id,
                status: offering.status,
                minimumRaiseEur: offering.minimumRaiseEur.toFixed(2),
                targetRaiseEur: offering.targetRaiseEur.toFixed(2),
                finalOfferingPublishedAt: offering.finalOfferingPublishedAt,
                platformRightsEndAt: offering.platformRightsEndAt,
                effectiveRightsEndAt: offering.effectiveRightsEndAt,
                disclosurePack:
                  offering.disclosurePacks[0] === undefined
                    ? null
                    : {
                        id: offering.disclosurePacks[0].id,
                        version: offering.disclosurePacks[0].version,
                        publishedAt: offering.disclosurePacks[0].publishedAt,
                        documentTypes:
                          offering.disclosurePacks[0].documents.map(
                            (d) => d.documentType,
                          ),
                      },
                reservations: offering.reservations.map((r) => ({
                  stage: r.reservationStage,
                  amountEur: r.amountEur.toFixed(2),
                  latestCapitalState: r.moneyEvents[0]?.capitalState ?? null,
                  latestAmountEur:
                    r.moneyEvents[0]?.amountEur.toFixed(2) ?? null,
                })),
              },
      };
    });
  }

  public async getCasePartnerAssignment(
    caseId: string,
  ): Promise<CasePartnerAssignment | null> {
    const intakeCase = await this.database.intakeCase.findUnique({
      where: { id: caseId },
      select: { stage: true, legalPracticeId: true, appraisalFirmId: true },
    });
    if (intakeCase === null) return null;
    return {
      stage: intakeCase.stage,
      legalPracticeId: intakeCase.legalPracticeId,
      appraisalFirmId: intakeCase.appraisalFirmId,
    };
  }

  public async assignPartnerOrganization(
    input: AssignPartnerOrganizationInput,
  ): Promise<AssignedPartnerOrganization | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true },
      });
      // Mirrors domain/case-review.policy.ts's canAssignPartnerOrganization --
      // this repository layer doesn't import the domain layer, so the
      // condition is duplicated here as this transaction's own recheck,
      // matching every other stage-guarded write in this file.
      if (
        current.stage !== "post_ipo_structuring" &&
        current.stage !== "approved_for_final_offering"
      ) {
        throw new CaseReviewConflictError(
          current.stage,
          "assign a legal practice or appraisal firm",
        );
      }

      const updated = await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          ...(input.legalPracticeId === undefined
            ? {}
            : { legalPracticeId: input.legalPracticeId }),
          ...(input.appraisalFirmId === undefined
            ? {}
            : { appraisalFirmId: input.appraisalFirmId }),
          updatedAt: input.assignedAt,
        },
        select: { id: true, legalPracticeId: true, appraisalFirmId: true },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "intake.case_partner_organization_assigned",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            legal_practice_id: updated.legalPracticeId,
            appraisal_firm_id: updated.appraisalFirmId,
          },
          createdAt: input.assignedAt,
        },
      });
      return {
        caseId: updated.id,
        legalPracticeId: updated.legalPracticeId,
        appraisalFirmId: updated.appraisalFirmId,
      };
    });
  }

  public async transitionToPostIpoStructuring(
    input: TransitionToPostIpoStructuringInput,
  ): Promise<TransitionedToPostIpoStructuring> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new Error(
          `Intake case ${input.caseId} not found while transitioning to post_ipo_structuring.`,
        );
      }

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true },
      });
      // A retried or twice-delivered job replaying an already-applied
      // transition must be a safe no-op, the same idempotency
      // openOfferingForApprovedCase's own reverse-direction handoff relies
      // on -- never a thrown error just because the write already landed.
      if (
        current.stage === "post_ipo_structuring" ||
        current.stage === "approved_for_final_offering"
      ) {
        return { caseId: input.caseId, stage: current.stage };
      }
      if (current.stage !== "pre_offering_open") {
        // Not a CaseReviewConflictError: that class models an HTTP staff
        // action losing a race against the case's current stage. This is a
        // worker-only invariant -- publishFinalOfferingTerms only ever
        // enqueues this job for a case that already reached
        // pre_offering_open (the only path to having an offering at all) --
        // so reaching any other stage here means the data is inconsistent,
        // not that the caller should retry.
        throw new Error(
          `Intake case ${input.caseId} is in stage ${current.stage}, not pre_offering_open; cannot transition to post_ipo_structuring.`,
        );
      }

      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          stage: "post_ipo_structuring",
          updatedAt: input.transitionedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "intake.case_post_ipo_structuring_started",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: "pre_offering_open",
            new_stage: "post_ipo_structuring",
          },
          createdAt: input.transitionedAt,
        },
      });
      return { caseId: input.caseId, stage: "post_ipo_structuring" };
    });
  }

  public async listCasesForPartner(input: {
    role: "legal_partner" | "appraisal_partner";
    organizationId: string;
    limit: number;
    after?: IntakeCaseCursor;
  }): Promise<PartnerCaseDetail[]> {
    const cases = await this.database.intakeCase.findMany({
      where: {
        ...(input.role === "legal_partner"
          ? { legalPracticeId: input.organizationId }
          : { appraisalFirmId: input.organizationId }),
        // Same accessible-stage set require-partner-case-assignment.ts's
        // middleware enforces for a single case -- a partner's list must
        // never surface a case outside what they could otherwise open.
        stage: { in: ["post_ipo_structuring", "approved_for_final_offering"] },
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                {
                  createdAt: input.after.createdAt,
                  id: { lt: input.after.id },
                },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: partnerCaseSelect,
    });
    return cases.map(toPartnerCaseDetail);
  }

  public async getCaseForPartner(
    caseId: string,
  ): Promise<PartnerCaseDetail | null> {
    const intakeCase = await this.database.intakeCase.findUnique({
      where: { id: caseId },
      select: partnerCaseSelect,
    });
    if (intakeCase === null) return null;
    return toPartnerCaseDetail(intakeCase);
  }

  public async recordLegalStructuring(
    input: RecordLegalStructuringInput,
  ): Promise<PartnerCaseDetail | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          legalStructuringCompletedAt: true,
          appraisalCompletedAt: true,
        },
      });
      // Mirrors domain/case-review.policy.ts's canRecordPartnerWriteback --
      // this repository layer doesn't import the domain layer, so the
      // condition is duplicated here as this transaction's own recheck,
      // matching every other stage-guarded write in this file.
      if (current.stage !== "post_ipo_structuring") {
        throw new CaseReviewConflictError(
          current.stage,
          "record legal structuring",
        );
      }

      // A completed_at already set is never refreshed by a later call --
      // it records when the work first finished, not when it was last
      // touched. markCompleted is otherwise a one-way switch: there is no
      // "uncomplete" (see recordAppraisal's mirrored comment).
      const legalStructuringCompletedAt =
        current.legalStructuringCompletedAt ??
        (input.markCompleted === true ? input.recordedAt : null);
      // Mirrors domain/case-review.policy.ts's isPostIpoStructuringComplete,
      // duplicated here for the same reason as the recheck above.
      const bothComplete =
        legalStructuringCompletedAt !== null &&
        current.appraisalCompletedAt !== null;

      const updated = await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          ...(input.legalDocumentRefs === undefined
            ? {}
            : { legalDocumentRefs: input.legalDocumentRefs }),
          legalStructuringCompletedAt,
          ...(bothComplete
            ? {
                stage: "approved_for_final_offering",
                approvedForFinalOfferingAt: input.recordedAt,
                postIpoStructuringCompletedAt: input.recordedAt,
              }
            : {}),
          updatedAt: input.recordedAt,
        },
        select: partnerCaseSelect,
      });
      const detail = toPartnerCaseDetail(updated);
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "intake.case_legal_structuring_recorded",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            legal_document_refs: detail.legalDocumentRefs,
            legal_structuring_completed_at:
              detail.legalStructuringCompletedAt?.toISOString() ?? null,
          },
          createdAt: input.recordedAt,
        },
      });
      if (bothComplete) {
        await transaction.auditLog.create({
          data: postIpoStructuringCompleteAuditData(input),
        });
      }
      return detail;
    });
  }

  public async recordAppraisal(
    input: RecordAppraisalInput,
  ): Promise<PartnerCaseDetail | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          legalStructuringCompletedAt: true,
          appraisalCompletedAt: true,
        },
      });
      if (current.stage !== "post_ipo_structuring") {
        throw new CaseReviewConflictError(current.stage, "record an appraisal");
      }

      // See recordLegalStructuring's mirrored comment: completed_at, once
      // set, is never refreshed or unset by a later call.
      const appraisalCompletedAt =
        current.appraisalCompletedAt ??
        (input.markCompleted === true ? input.recordedAt : null);
      const bothComplete =
        current.legalStructuringCompletedAt !== null &&
        appraisalCompletedAt !== null;

      const updated = await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          ...(input.appraisalValueOpinionEur === undefined
            ? {}
            : { appraisalValueOpinionEur: input.appraisalValueOpinionEur }),
          ...(input.appraisalDocumentRefs === undefined
            ? {}
            : { appraisalDocumentRefs: input.appraisalDocumentRefs }),
          appraisalCompletedAt,
          ...(bothComplete
            ? {
                stage: "approved_for_final_offering",
                approvedForFinalOfferingAt: input.recordedAt,
                postIpoStructuringCompletedAt: input.recordedAt,
              }
            : {}),
          updatedAt: input.recordedAt,
        },
        select: partnerCaseSelect,
      });
      const detail = toPartnerCaseDetail(updated);
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "intake.case_appraisal_recorded",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            appraisal_value_opinion_eur: detail.appraisalValueOpinionEur,
            appraisal_document_refs: detail.appraisalDocumentRefs,
            appraisal_completed_at:
              detail.appraisalCompletedAt?.toISOString() ?? null,
          },
          createdAt: input.recordedAt,
        },
      });
      if (bothComplete) {
        await transaction.auditLog.create({
          data: postIpoStructuringCompleteAuditData(input),
        });
      }
      return detail;
    });
  }

  public async getApplicantResponseWindowBusinessDays(): Promise<number> {
    const setting = await this.database.platformSetting.findUnique({
      where: { key: "intake.applicant_response_window_business_days" },
      select: { value: true },
    });
    if (setting === null) {
      throw new Error(
        "Missing intake.applicant_response_window_business_days setting",
      );
    }
    return responseWindowSettingSchema.parse(setting.value).business_days;
  }

  public async getInformationRequestReminderBusinessDays(): Promise<number[]> {
    const setting = await this.database.platformSetting.findUnique({
      where: { key: "intake.information_request_reminder_business_days" },
      select: { value: true },
    });
    if (setting === null) {
      throw new Error(
        "Missing intake.information_request_reminder_business_days setting",
      );
    }
    return reminderDaysSettingSchema.parse(setting.value).business_days;
  }

  public async publishInformationRequest(input: {
    accountId: string;
    caseId: string;
    traceId: string;
    requestBody: string;
    publishedAt: Date;
    dueAt: Date;
  }): Promise<PublishedInformationRequest | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          currentSubmissionRevisionId: true,
          informationRequests: {
            where: { status: "published" },
            take: 1,
            select: { id: true },
          },
        },
      });
      if (
        current.stage !== "submitted" ||
        current.currentSubmissionRevisionId === null ||
        current.informationRequests.length > 0
      ) {
        throw new CaseReviewConflictError(
          current.stage,
          "publish an information request",
        );
      }

      const request = await transaction.informationRequest.create({
        data: {
          id: `rfi_${ulid()}`,
          caseId: input.caseId,
          requestingWorkstream: "intake",
          proposedByAccountId: input.accountId,
          proposedAt: input.publishedAt,
          status: "published",
          publishedByAccountId: input.accountId,
          publishedAt: input.publishedAt,
          dueAt: input.dueAt,
          requestBody: input.requestBody,
        },
        select: informationRequestSelect,
      });
      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: { stage: "waiting_on_applicant", updatedAt: input.publishedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "intake.information_request_published",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            request_id: request.id,
            previous_stage: "submitted",
            new_stage: "waiting_on_applicant",
            due_at: input.dueAt.toISOString(),
          },
        },
      });
      return {
        ...toInformationRequest(request),
        status: "published",
        publishedAt: input.publishedAt,
        dueAt: input.dueAt,
      };
    });
  }

  public async listPublishedInformationRequestsForTimers(): Promise<
    PublishedInformationRequestForTimer[]
  > {
    const requests = await this.database.informationRequest.findMany({
      where: { status: "published" },
      select: {
        id: true,
        caseId: true,
        publishedAt: true,
        dueAt: true,
        case: {
          select: {
            applicantAccountId: true,
            applicant: { select: { protectedContactEmail: true } },
          },
        },
      },
    });
    return requests
      .filter(
        (request) => request.publishedAt !== null && request.dueAt !== null,
      )
      .map((request) => ({
        requestId: request.id,
        caseId: request.caseId,
        applicantAccountId: request.case.applicantAccountId,
        applicantContactEmail: request.case.applicant.protectedContactEmail,
        publishedAt: request.publishedAt as Date,
        dueAt: request.dueAt as Date,
      }));
  }

  public async getPublishedInformationRequestForTimer(
    caseId: string,
    requestId: string,
  ): Promise<PublishedInformationRequestForTimer | null> {
    const request = await this.database.informationRequest.findFirst({
      where: { id: requestId, caseId, status: "published" },
      select: {
        id: true,
        caseId: true,
        publishedAt: true,
        dueAt: true,
        case: {
          select: {
            applicantAccountId: true,
            applicant: { select: { protectedContactEmail: true } },
          },
        },
      },
    });
    if (
      request === null ||
      request.publishedAt === null ||
      request.dueAt === null
    ) {
      return null;
    }
    return {
      requestId: request.id,
      caseId: request.caseId,
      applicantAccountId: request.case.applicantAccountId,
      applicantContactEmail: request.case.applicant.protectedContactEmail,
      publishedAt: request.publishedAt,
      dueAt: request.dueAt,
    };
  }

  public async expireInformationRequest(input: {
    requestId: string;
    caseId: string;
    traceId: string;
    expiredAt: Date;
    manualOverride?: { reason: string; actorAccountId: string };
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return false;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          informationRequests: {
            where: { id: input.requestId },
            take: 1,
            select: { id: true, status: true },
          },
        },
      });
      const request = current.informationRequests[0];
      if (
        current.stage !== "waiting_on_applicant" ||
        request?.status !== "published"
      ) {
        return false;
      }

      await transaction.informationRequest.update({
        where: { id: input.requestId },
        data: {
          status: "expired",
          resolvedAt: input.expiredAt,
          resolutionType: "expired",
        },
      });
      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          stage: "expired",
          expiredAt: input.expiredAt,
          updatedAt: input.expiredAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.manualOverride?.actorAccountId ?? null,
          action: "intake.information_request_expired",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            request_id: input.requestId,
            previous_stage: "waiting_on_applicant",
            new_stage: "expired",
            ...(input.manualOverride === undefined
              ? {}
              : { manual_override: true, reason: input.manualOverride.reason }),
          },
          createdAt: input.expiredAt,
        },
      });
      return true;
    });
  }

  // Targeted counterpart to expireInformationRequest above: same
  // $transaction + row-lock + existence/status recheck shape, but instead
  // of expiring the request and terminating the case, it withdraws just the
  // request and hands the case back to "submitted" -- the same revert
  // resubmitAfterInformationRequest below performs on a normal answer,
  // copied verbatim here since staff withdrawing a mistaken RFI must leave
  // the case exactly where a correct resubmission would have. Unlike
  // resubmitAfterInformationRequest, currentSubmissionRevisionId is left
  // untouched: there is no new revision, the case resumes reviewing the one
  // it was already on.
  public async withdrawInformationRequest(input: {
    accountId: string;
    caseId: string;
    requestId: string;
    traceId: string;
    founderReviewNotes: string | null;
    withdrawnAt: Date;
  }): Promise<WithdrawnInformationRequest | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          informationRequests: {
            where: { id: input.requestId },
            take: 1,
            select: { id: true, status: true },
          },
        },
      });
      const request = current.informationRequests[0];
      if (
        current.stage !== "waiting_on_applicant" ||
        request?.status !== "published"
      ) {
        throw new CaseReviewConflictError(
          current.stage,
          "withdraw this information request",
        );
      }

      await transaction.informationRequest.update({
        where: { id: input.requestId },
        data: {
          status: "withdrawn",
          resolvedAt: input.withdrawnAt,
          resolutionType: "withdrawn",
        },
      });
      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          stage: "submitted",
          updatedAt: input.withdrawnAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "intake.information_request_withdrawn",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            request_id: input.requestId,
            previous_stage: "waiting_on_applicant",
            new_stage: "submitted",
            founder_review_notes: input.founderReviewNotes,
          },
          createdAt: input.withdrawnAt,
        },
      });
      return {
        requestId: input.requestId,
        caseId: input.caseId,
        status: "withdrawn",
        resolvedAt: input.withdrawnAt,
        stage: "submitted",
      };
    });
  }

  public async getOwnedInformationRequest(
    accountId: string,
    caseId: string,
    requestId: string,
  ): Promise<InformationRequestRecord | null> {
    const request = await this.database.informationRequest.findFirst({
      where: {
        id: requestId,
        caseId,
        case: { applicantAccountId: accountId },
      },
      select: informationRequestSelect,
    });
    return request === null ? null : toInformationRequest(request);
  }

  public async listOwnedInformationRequests(
    accountId: string,
    caseId: string,
  ): Promise<InformationRequestRecord[] | null> {
    const ownedCase = await this.database.intakeCase.findFirst({
      where: { id: caseId, applicantAccountId: accountId },
      select: {
        informationRequests: {
          where: { publishedAt: { not: null } },
          orderBy: [{ proposedAt: "desc" }, { id: "desc" }],
          select: informationRequestSelect,
        },
      },
    });
    return ownedCase === null
      ? null
      : ownedCase.informationRequests.map(toInformationRequest);
  }

  public async resubmitAfterInformationRequest(
    input: SubmitInitialCaseInput & { requestId: string; submittedAt: Date },
  ): Promise<ResubmittedCase | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
          AND applicant_account_id = ${input.accountId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          currentSubmissionRevision: { select: { revisionNumber: true } },
          informationRequests: {
            where: { id: input.requestId },
            take: 1,
            select: { id: true, status: true },
          },
        },
      });
      const request = current.informationRequests[0];
      if (
        current.stage !== "waiting_on_applicant" ||
        current.currentSubmissionRevision === null ||
        request?.status !== "published"
      ) {
        throw new CaseReviewConflictError(current.stage, "resubmit this case");
      }

      const revisionNumber =
        current.currentSubmissionRevision.revisionNumber + 1;
      const revisionId = `rev_${ulid()}`;
      await transaction.submissionRevision.create({
        data: {
          id: revisionId,
          caseId: input.caseId,
          revisionNumber,
          submittedAt: input.submittedAt,
          submittedByAccountId: input.accountId,
          submissionData: input.submissionData as Prisma.InputJsonObject,
          reason: "resubmission_after_rfi",
        },
      });
      await transaction.documentaryScreeningEvidence.createMany({
        data: input.documents.map((document) => ({
          id: `evidence_${ulid()}`,
          caseId: input.caseId,
          submissionRevisionId: revisionId,
          documentType: document.documentType,
          status: "pending",
          documentRef: document.documentRef,
          extractDated: document.extractDated,
        })),
      });
      await transaction.informationRequest.update({
        where: { id: input.requestId },
        data: {
          status: "answered",
          resolvedAt: input.submittedAt,
          resolutionType: "resubmitted",
          resolvingRevisionId: revisionId,
        },
      });
      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          stage: "submitted",
          currentSubmissionRevisionId: revisionId,
          updatedAt: input.submittedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "intake.case_resubmitted",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            request_id: input.requestId,
            previous_stage: "waiting_on_applicant",
            new_stage: "submitted",
            revision_id: revisionId,
            revision_number: revisionNumber,
          },
        },
      });
      return {
        caseId: input.caseId,
        revisionId,
        revisionNumber,
        stage: "submitted",
        submittedAt: input.submittedAt,
      };
    });
  }

  public async recordFounderDecision(
    input: FounderDecisionInput,
  ): Promise<RecordedFounderDecision | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          currentSubmissionRevisionId: true,
          propertyId: true,
        },
      });
      if (
        current.stage !== "submitted" ||
        current.currentSubmissionRevisionId === null
      ) {
        throw new CaseReviewConflictError(
          current.stage,
          "record a founder decision",
        );
      }

      const stage =
        input.decision === "approve" ? "pre_offering_open" : "rejected";
      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data:
          input.decision === "approve"
            ? {
                stage,
                founderReviewNotes: input.founderReviewNotes,
                reviewedByAccountId: input.accountId,
                approvedAt: input.decidedAt,
                ipoPeriodDays: input.ipoPeriodDays,
                ipoEndAt: input.ipoEndAt,
                ipoValueEur: input.ipoValueEur,
                exclusivityCommencedAt: input.decidedAt,
                updatedAt: input.decidedAt,
              }
            : {
                stage,
                canReopen: false,
                founderReviewNotes: input.founderReviewNotes,
                reviewedByAccountId: input.accountId,
                rejectedAt: input.decidedAt,
                rejectionReasonCode: input.rejectionReasonCode,
                rejectionNotes: input.rejectionNotes,
                updatedAt: input.decidedAt,
              },
      });
      if (input.decision === "approve") {
        // AD-145: intake approval never writes into the offering
        // domain's tables directly — it durably hands off, in this same
        // transaction, to the job that opens the Piv/Offering shell the
        // now-`pre_offering_open` property needs to be browsable and
        // reservation-ready.
        await enqueueTransactionalJob(
          this.pgBoss,
          transaction,
          "case_timers.pre_offering_open_handoff",
          {
            case_id: input.caseId,
            property_id: current.propertyId,
            ipo_value_eur: input.ipoValueEur,
          },
          input.traceId,
        );
      }
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: `intake.case_${input.decision === "approve" ? "approved" : "rejected"}`,
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: "submitted",
            new_stage: stage,
            reviewed_revision_id: current.currentSubmissionRevisionId,
            ...(input.decision === "approve"
              ? {
                  ipo_period_days: input.ipoPeriodDays,
                  ipo_end_at: input.ipoEndAt.toISOString(),
                  ipo_value_eur: input.ipoValueEur,
                }
              : { rejection_reason_code: input.rejectionReasonCode }),
          },
        },
      });
      return {
        caseId: input.caseId,
        stage,
        decidedAt: input.decidedAt,
        ipoEndAt: input.decision === "approve" ? input.ipoEndAt : null,
      };
    });
  }

  // Purely advisory (nothing reads documentary_screening_evidence.status
  // for any decision) and reviewable at any case stage, so this locks and
  // validates the evidence row itself rather than the case row every other
  // write above locks -- there's no case-stage recheck to protect. Throws
  // EvidenceNotFoundError if no row exists with that id at all, or
  // EvidenceCaseMismatchError if it exists under a different case.
  public async reviewEvidence(
    input: ReviewEvidenceInput,
  ): Promise<ReviewedEvidence> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<
        Array<{ evidence_id: string; case_id: string }>
      >`
        SELECT evidence_id, case_id
        FROM intake.documentary_screening_evidence
        WHERE evidence_id = ${input.evidenceId}
        FOR UPDATE
      `;
      const row = locked[0];
      if (row === undefined) throw new EvidenceNotFoundError(input.evidenceId);
      if (row.case_id !== input.caseId) {
        throw new EvidenceCaseMismatchError(input.evidenceId, input.caseId);
      }

      await transaction.documentaryScreeningEvidence.update({
        where: { id: input.evidenceId },
        data: {
          status: input.status,
          reviewedByAccountId: input.accountId,
          reviewedAt: input.reviewedAt,
          reviewNotes: input.reviewNotes,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "intake.evidence_reviewed",
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            evidence_id: input.evidenceId,
            status: input.status,
            review_notes: input.reviewNotes,
          },
        },
      });
      return {
        evidenceId: input.evidenceId,
        caseId: input.caseId,
        status: input.status,
        reviewedByAccountId: input.accountId,
        reviewedAt: input.reviewedAt,
        reviewNotes: input.reviewNotes,
      };
    });
  }

  // REAL_ESTATE_INTAKE_LIFECYCLE.md's state diagram, distinct from
  // recordFounderDecision above (the submitted-stage initial review):
  // withdrawn is reachable from draft/submitted/waiting_on_applicant/
  // pre_offering_open; the only other manual closure the diagram shows is
  // pre_offering_open -> rejected ("ipo_period ends underfunded, founder
  // closes the case"). expired has no manual path — see
  // expireInformationRequest above.
  public async closeCase(input: CloseCaseInput): Promise<ClosedCase | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM intake.intake_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.intakeCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true },
      });
      const closableFrom: Record<CloseCaseInput["outcome"], readonly string[]> =
        {
          withdrawn: [
            "draft",
            "submitted",
            "waiting_on_applicant",
            "pre_offering_open",
          ],
          rejected: ["pre_offering_open"],
        };
      if (!closableFrom[input.outcome].includes(current.stage)) {
        throw new CaseReviewConflictError(current.stage, "close the case");
      }

      await transaction.intakeCase.update({
        where: { id: input.caseId },
        data: {
          stage: input.outcome,
          canReopen: false,
          founderReviewNotes: input.founderReviewNotes,
          reviewedByAccountId: input.accountId,
          updatedAt: input.closedAt,
          ...(input.outcome === "withdrawn"
            ? { withdrawnAt: input.closedAt }
            : {
                rejectedAt: input.closedAt,
                rejectionReasonCode: input.rejectionReasonCode,
                rejectionNotes: input.rejectionNotes,
              }),
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: `intake.case_${input.outcome}`,
          resourceType: "intake_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: current.stage,
            new_stage: input.outcome,
            ...(input.outcome === "rejected"
              ? { rejection_reason_code: input.rejectionReasonCode }
              : {}),
          },
          createdAt: input.closedAt,
        },
      });
      return {
        caseId: input.caseId,
        stage: input.outcome,
        closedAt: input.closedAt,
      };
    });
  }

  public async listCaseMessages(
    caseId: string,
    lane: ThreadLane,
  ): Promise<CaseMessageRecord[]> {
    const thread = await this.database.caseThread.findUnique({
      where: { caseId_lane: { caseId, lane } },
      select: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            authorAccountId: true,
            body: true,
            createdAt: true,
          },
        },
      },
    });
    return (thread?.messages ?? []).map(toCaseMessageRecord);
  }

  public async postCaseMessage(input: {
    caseId: string;
    lane: ThreadLane;
    authorAccountId: string;
    body: string;
    postedAt: Date;
  }): Promise<CaseMessageRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const exists = await transaction.intakeCase.findUnique({
        where: { id: input.caseId },
        select: { id: true },
      });
      if (exists === null) return null;

      const thread = await transaction.caseThread.upsert({
        where: { caseId_lane: { caseId: input.caseId, lane: input.lane } },
        create: {
          id: `thread_${ulid()}`,
          caseId: input.caseId,
          lane: input.lane,
        },
        update: {},
      });
      const message = await transaction.caseMessage.create({
        data: {
          id: `msg_${ulid()}`,
          threadId: thread.id,
          authorAccountId: input.authorAccountId,
          body: input.body,
          createdAt: input.postedAt,
        },
        select: {
          id: true,
          authorAccountId: true,
          body: true,
          createdAt: true,
        },
      });
      return toCaseMessageRecord(message);
    });
  }
}

function toCaseMessageRecord(input: {
  id: string;
  authorAccountId: string | null;
  body: string;
  createdAt: Date;
}): CaseMessageRecord {
  return {
    messageId: input.id,
    authorAccountId: input.authorAccountId,
    body: input.body,
    createdAt: input.createdAt,
  };
}

const ownedCaseSelect = {
  id: true,
  stage: true,
  createdAt: true,
  updatedAt: true,
  currentSubmissionRevision: {
    select: { revisionNumber: true, submittedAt: true },
  },
  property: {
    select: {
      id: true,
      propertyType: true,
      countryCode: true,
      city: true,
      addressLine: true,
      landRegistryReference: true,
      ownerDeclaredValueEur: true,
      hasExistingEncumbrance: true,
      residentialSubtype: true,
      livingAreaSqM: true,
      bedrooms: true,
      bathrooms: true,
      floor: true,
      totalFloors: true,
      yearBuilt: true,
      condition: true,
      energyRating: true,
      rooms: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          roomType: true,
          sizeSqM: true,
          preferredPhotoId: true,
          photos: {
            where: { documentType: "room_photo", uploadStatus: "accepted", deletedAt: null },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, objectKey: true, contentType: true, createdAt: true, variants: { where: { variantType: "thumbnail", uploadStatus: "accepted", deletedAt: null }, select: { objectKey: true }, take: 1 } },
          },
        },
      },
    },
  },
} satisfies Prisma.IntakeCaseSelect;

const informationRequestSelect = {
  id: true,
  caseId: true,
  status: true,
  requestBody: true,
  publishedAt: true,
  dueAt: true,
  resolvedAt: true,
  resolutionType: true,
  resolvingRevisionId: true,
} as const;

function toInformationRequest(input: {
  id: string;
  caseId: string;
  status: string;
  requestBody: string;
  publishedAt: Date | null;
  dueAt: Date | null;
  resolvedAt: Date | null;
  resolutionType: string | null;
  resolvingRevisionId: string | null;
}): InformationRequestRecord {
  return {
    requestId: input.id,
    caseId: input.caseId,
    status: input.status,
    requestBody: input.requestBody,
    publishedAt: input.publishedAt,
    dueAt: input.dueAt,
    resolvedAt: input.resolvedAt,
    resolutionType: input.resolutionType,
    resolvingRevisionId: input.resolvingRevisionId,
  };
}

function toOwnedCase(input: {
  id: string;
  stage: string;
  createdAt: Date;
  updatedAt: Date;
  currentSubmissionRevision: {
    revisionNumber: number;
    submittedAt: Date;
  } | null;
  property: {
    id: string;
    propertyType: string;
    countryCode: string;
    city: string | null;
    addressLine: string | null;
    landRegistryReference: string | null;
    ownerDeclaredValueEur: { toFixed(fractionDigits: number): string };
    hasExistingEncumbrance: boolean;
    residentialSubtype: string | null;
    livingAreaSqM: { toNumber(): number } | null;
    bedrooms: number | null;
    bathrooms: number | null;
    floor: number | null;
    totalFloors: number | null;
    yearBuilt: number | null;
    condition: string | null;
    energyRating: string | null;
    rooms: Array<{
      id: string;
      roomType: string;
      sizeSqM: { toNumber(): number };
      preferredPhotoId?: string | null;
      photos?: Array<{ id: string; objectKey: string; contentType: string; createdAt: Date; variants?: Array<{ objectKey: string }> }>;
    }>;
  };
}): OwnedIntakeCase {
  return {
    caseId: input.id,
    stage: input.stage,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    currentRevision: input.currentSubmissionRevision,
    property: {
      propertyId: input.property.id,
      propertyType: input.property.propertyType,
      countryCode: input.property.countryCode,
      city: input.property.city,
      addressLine: input.property.addressLine,
      landRegistryReference: input.property.landRegistryReference,
      ownerDeclaredValueEur: input.property.ownerDeclaredValueEur.toFixed(2),
      hasExistingEncumbrance: input.property.hasExistingEncumbrance,
      residentialSubtype: input.property.residentialSubtype,
      livingAreaSqM:
        input.property.livingAreaSqM === null
          ? null
          : input.property.livingAreaSqM.toNumber(),
      bedrooms: input.property.bedrooms,
      bathrooms: input.property.bathrooms,
      floor: input.property.floor,
      totalFloors: input.property.totalFloors,
      yearBuilt: input.property.yearBuilt,
      condition: input.property.condition,
      energyRating: input.property.energyRating,
      rooms: input.property.rooms.map((room) => ({
        roomId: room.id,
        roomType: room.roomType,
        sizeSqM: room.sizeSqM.toNumber(),
        preferredPhotoId: room.preferredPhotoId ?? null,
        photos: (room.photos ?? []).map((photo) => ({
          documentId: photo.id,
          documentRef: photo.objectKey,
          thumbnailRef: photo.variants?.[0]?.objectKey ?? null,
          contentType: photo.contentType,
          uploadedAt: photo.createdAt,
        })),
      })),
    },
  };
}

const partnerCaseSelect = {
  ...ownedCaseSelect,
  legalDocumentRefs: true,
  legalStructuringCompletedAt: true,
  appraisalValueOpinionEur: true,
  appraisalDocumentRefs: true,
  appraisalCompletedAt: true,
  postIpoStructuringCompletedAt: true,
} satisfies Prisma.IntakeCaseSelect;

function toPartnerCaseDetail(
  input: Parameters<typeof toOwnedCase>[0] & {
    legalDocumentRefs: string[];
    legalStructuringCompletedAt: Date | null;
    appraisalValueOpinionEur: {
      toFixed(fractionDigits: number): string;
    } | null;
    appraisalDocumentRefs: string[];
    appraisalCompletedAt: Date | null;
    postIpoStructuringCompletedAt: Date | null;
  },
): PartnerCaseDetail {
  return {
    ...toOwnedCase(input),
    legalDocumentRefs: input.legalDocumentRefs,
    legalStructuringCompletedAt: input.legalStructuringCompletedAt,
    appraisalValueOpinionEur:
      input.appraisalValueOpinionEur?.toFixed(2) ?? null,
    appraisalDocumentRefs: input.appraisalDocumentRefs,
    appraisalCompletedAt: input.appraisalCompletedAt,
    postIpoStructuringCompletedAt: input.postIpoStructuringCompletedAt,
  };
}

// The second, separately-named audit entry for the system-computed
// consequence (CORE_TABLES.md's post_ipo_structuring_completed_at comment)
// of whichever partner's writeback happens to complete the pair -- kept
// distinct from that writeback's own entry above so the case's lifecycle
// transition is independently discoverable in the audit log, regardless of
// which partner triggered it.
function postIpoStructuringCompleteAuditData(input: {
  caseId: string;
  traceId: string;
  recordedAt: Date;
}) {
  return {
    id: `audit_${ulid()}`,
    actorAccountId: null,
    action: "intake.case_approved_for_final_offering",
    resourceType: "intake_case",
    resourceId: input.caseId,
    changes: {
      trace_id: input.traceId,
      previous_stage: "post_ipo_structuring",
      new_stage: "approved_for_final_offering",
    },
    createdAt: input.recordedAt,
  };
}
