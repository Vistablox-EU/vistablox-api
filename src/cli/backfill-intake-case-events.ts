/**
 * Idempotently imports the recoverable intake-case audit history into the
 * normalized immutable case-event ledger. Run after the ledger migration and
 * before enabling the Admin history tab:
 *
 *   npm run intake:backfill-events
 */
import "dotenv/config";

import { loadEnvironment } from "../config/environment.js";
import { createPrismaClient } from "../infrastructure/database/prisma.js";
import { appendIntakeCaseEvent } from "../modules/intake/repository/intake-case-event.repository.js";

type LegacyAuditRow = {
  id: string;
  actorAccountId: string | null;
  action: string;
  resourceId: string;
  changes: unknown;
  createdAt: Date;
};

const mappings: Record<string, { eventType: string; fromStage?: string; toStage?: string; actorType: "staff" | "applicant" | "partner" | "system" }> = {
  "intake.case_draft_created": { eventType: "case_created", actorType: "applicant" },
  "intake.case_created_by_staff": { eventType: "case_created", actorType: "staff" },
  "intake.case_submitted": { eventType: "case_submitted", fromStage: "draft", toStage: "submitted", actorType: "applicant" },
  "intake.case_resubmitted": { eventType: "case_resubmitted", fromStage: "waiting_on_applicant", toStage: "submitted", actorType: "applicant" },
  "intake.information_request_published": { eventType: "case_information_requested", fromStage: "submitted", toStage: "waiting_on_applicant", actorType: "staff" },
  "intake.information_request_withdrawn": { eventType: "case_information_request_withdrawn", fromStage: "waiting_on_applicant", toStage: "submitted", actorType: "staff" },
  "intake.information_request_expired": { eventType: "case_expired", fromStage: "waiting_on_applicant", toStage: "expired", actorType: "system" },
  "intake.evidence_reviewed": { eventType: "case_evidence_reviewed", actorType: "staff" },
  "intake.case_approved": { eventType: "founder_decision_recorded", fromStage: "submitted", toStage: "pre_offering_open", actorType: "staff" },
  "intake.case_rejected": { eventType: "founder_decision_recorded", fromStage: "submitted", toStage: "rejected", actorType: "staff" },
  "intake.case_withdrawn": { eventType: "case_withdrawn", actorType: "staff" },
  "intake.case_post_ipo_structuring_started": { eventType: "case_post_ipo_structuring_started", fromStage: "pre_offering_open", toStage: "post_ipo_structuring", actorType: "system" },
  "intake.case_approved_for_final_offering": { eventType: "case_approved_for_final_offering", fromStage: "post_ipo_structuring", toStage: "approved_for_final_offering", actorType: "system" },
  "intake.case_partner_organization_assigned": { eventType: "partner_assignment_changed", actorType: "staff" },
  "intake.case_legal_structuring_recorded": { eventType: "legal_structuring_updated", actorType: "partner" },
  "intake.case_appraisal_recorded": { eventType: "appraisal_updated", actorType: "partner" },
};

function safeMetadata(changes: unknown): Record<string, unknown> {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) return {};
  const input = changes as Record<string, unknown>;
  const allowed = new Set(["stage", "previous_stage", "new_stage", "revision_id", "revision_number", "request_id", "evidence_id", "status", "legal_practice_id", "appraisal_firm_id", "property_id", "ipo_period_days", "ipo_end_at", "ipo_value_eur", "rejection_reason_code"]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key)));
}

async function main(): Promise<void> {
  const database = createPrismaClient(loadEnvironment().DATABASE_URL);
  try {
    const rows = await database.auditLog.findMany({
      where: { resourceType: { in: ["intake_case", "offering"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, actorAccountId: true, action: true, resourceId: true, changes: true, createdAt: true },
    }) as LegacyAuditRow[];
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const offeringMapping: Record<string, string> = {
        "offering.opened_for_approved_case": "offering_created",
        "offering.disclosure_pack_published": "offering_disclosure_pack_published",
        "offering.final_terms_published": "offering_final_terms_published",
        "offering.finalized": "offering_finalized",
      };
      const offeringEventType = offeringMapping[row.action];
      const mapping: (typeof mappings[string]) | undefined = mappings[row.action]
        ?? (offeringEventType === undefined ? undefined : { eventType: offeringEventType, actorType: row.actorAccountId === null ? "system" as const : "staff" as const });
      if (mapping === undefined) {
        skipped += 1;
        continue;
      }
      await database.$transaction(async (transaction) => {
        const caseId = row.resourceId.startsWith("case_")
          ? row.resourceId
          : (await transaction.offering.findUnique({ where: { id: row.resourceId }, select: { piv: { select: { caseId: true } } } }))?.piv.caseId;
        if (caseId === undefined) return;
        const existingCase = await transaction.intakeCase.findUnique({ where: { id: caseId }, select: { id: true } });
        if (existingCase === null) return;
        await appendIntakeCaseEvent(transaction, {
          caseId,
          eventKey: `legacy:audit:${row.id}`,
          eventType: mapping.eventType,
          actorType: mapping.actorType,
          actorAccountId: mapping.actorType === "system" ? null : row.actorAccountId,
          fromStage: mapping.fromStage ?? null,
          toStage: mapping.toStage ?? null,
          metadata: safeMetadata(row.changes),
          relatedResourceType: row.action.startsWith("offering.") ? "offering" : "intake_case",
          relatedResourceId: row.resourceId,
          occurredAt: row.createdAt,
          eventSource: "legacy_audit",
          sourceAuditLogId: row.id,
          workflowVersion: 0,
        });
      });
      imported += 1;
    }
    process.stdout.write(`Imported ${imported} intake audit events; skipped ${skipped} unmapped rows.\n`);
  } finally {
    await database.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Intake history backfill failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
