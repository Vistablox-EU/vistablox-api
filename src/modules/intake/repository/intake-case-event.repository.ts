import { ulid } from "ulid";

import type { Prisma } from "../../../generated/prisma/client.js";
import { getIntakeWorkflowForStage } from "../domain/intake-workflow.catalog.js";

export type IntakeCaseEventActor = "staff" | "applicant" | "partner" | "system";

export interface AppendIntakeCaseEventInput {
  caseId: string;
  eventKey: string;
  eventType: string;
  actorType: IntakeCaseEventActor;
  actorAccountId?: string | null;
  traceId?: string | null;
  causationEventId?: string | null;
  fromStage?: string | null;
  toStage?: string | null;
  relatedResourceType?: string | null;
  relatedResourceId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  eventSource?: "live" | "legacy_audit";
  sourceAuditLogId?: string | null;
  sourceJobId?: string | null;
  reversalOfEventId?: string | null;
  workflowVersion?: number;
}

/**
 * Appends one immutable lifecycle event in the caller's transaction. The
 * parent-row counter serializes event ordering without relying on max()+1.
 * Existing event keys are treated as successful idempotent replays.
 */
export async function appendIntakeCaseEvent(
  transaction: Prisma.TransactionClient,
  input: AppendIntakeCaseEventInput,
): Promise<string> {
  const existing = await transaction.intakeCaseEvent.findUnique({
    where: { eventKey: input.eventKey },
    select: { id: true },
  });
  if (existing !== null) return existing.id;

  const targetStage = input.toStage ?? input.fromStage;
  if (targetStage === null || targetStage === undefined) {
    const current = await transaction.intakeCase.findUniqueOrThrow({
      where: { id: input.caseId },
      select: { stage: true },
    });
    input.toStage = null;
    input.fromStage = null;
    const workflow = getIntakeWorkflowForStage(current.stage);
    return appendWithWorkflow(transaction, input, workflow.type, workflowVersion(input));
  }

  const workflow = getIntakeWorkflowForStage(targetStage);
  return appendWithWorkflow(transaction, input, workflow.type, workflowVersion(input));
}

function workflowVersion(input: AppendIntakeCaseEventInput): number {
  return input.workflowVersion ?? (input.eventSource === "legacy_audit" ? 0 : 1);
}

async function appendWithWorkflow(
  transaction: Prisma.TransactionClient,
  input: AppendIntakeCaseEventInput,
  workflowType: string,
  workflowVersion: number,
): Promise<string> {
  const sequenceRow = await transaction.intakeCase.update({
    where: { id: input.caseId },
    data: { workflowEventSequence: { increment: 1 } },
    select: { workflowEventSequence: true },
  });
  const eventId = `evt_${ulid()}`;
  await transaction.intakeCaseEvent.create({
    data: {
      id: eventId,
      caseId: input.caseId,
      eventSequence: sequenceRow.workflowEventSequence,
      eventKey: input.eventKey,
      eventType: input.eventType,
      workflowType,
      workflowVersion,
      fromStage: input.fromStage ?? null,
      toStage: input.toStage ?? null,
      actorType: input.actorType,
      actorAccountId: input.actorAccountId ?? null,
      traceId: input.traceId ?? null,
      causationEventId: input.causationEventId ?? null,
      relatedResourceType: input.relatedResourceType ?? null,
      relatedResourceId: input.relatedResourceId ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      occurredAt: input.occurredAt,
      eventSource: input.eventSource ?? "live",
      sourceAuditLogId: input.sourceAuditLogId ?? null,
      sourceJobId: input.sourceJobId ?? null,
      reversalOfEventId: input.reversalOfEventId ?? null,
    },
  });
  return eventId;
}
