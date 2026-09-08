import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  AppraisalFirmRecord,
  LegalPracticeRecord,
  PartnerOrganizationRepository,
  PartnerOrganizationStatus,
} from "./partner-organization.repository.js";

export class PrismaPartnerOrganizationRepository implements PartnerOrganizationRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createLegalPractice(input: {
    name: string;
    countryCode: string;
    actorAccountId: string;
    traceId: string;
    createdAt: Date;
  }): Promise<LegalPracticeRecord> {
    return this.database.$transaction(async (transaction) => {
      const practice = await transaction.legalPractice.create({
        data: {
          id: `legal_practice_${ulid()}`,
          name: input.name,
          countryCode: input.countryCode,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "origination.legal_practice_created",
          resourceType: "legal_practice",
          resourceId: practice.id,
          changes: {
            trace_id: input.traceId,
            name: practice.name,
            country_code: practice.countryCode,
          },
          createdAt: input.createdAt,
        },
      });
      return toLegalPracticeRecord(practice);
    });
  }

  public async listLegalPractices(): Promise<LegalPracticeRecord[]> {
    const practices = await this.database.legalPractice.findMany({
      orderBy: { name: "asc" },
    });
    return practices.map(toLegalPracticeRecord);
  }

  public async getLegalPracticeById(id: string): Promise<LegalPracticeRecord | null> {
    const practice = await this.database.legalPractice.findUnique({ where: { id } });
    return practice === null ? null : toLegalPracticeRecord(practice);
  }

  public async updateLegalPracticeStatus(input: {
    id: string;
    status: PartnerOrganizationStatus;
    actorAccountId: string;
    traceId: string;
    updatedAt: Date;
  }): Promise<LegalPracticeRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const existing = await transaction.legalPractice.findUnique({ where: { id: input.id } });
      if (existing === null) return null;

      const practice = await transaction.legalPractice.update({
        where: { id: input.id },
        data: { status: input.status },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "origination.legal_practice_status_updated",
          resourceType: "legal_practice",
          resourceId: practice.id,
          changes: {
            trace_id: input.traceId,
            previous_status: existing.status,
            new_status: practice.status,
          },
          createdAt: input.updatedAt,
        },
      });
      return toLegalPracticeRecord(practice);
    });
  }

  public async createAppraisalFirm(input: {
    name: string;
    countryCode: string;
    actorAccountId: string;
    traceId: string;
    createdAt: Date;
  }): Promise<AppraisalFirmRecord> {
    return this.database.$transaction(async (transaction) => {
      const firm = await transaction.appraisalFirm.create({
        data: {
          id: `appraisal_firm_${ulid()}`,
          name: input.name,
          countryCode: input.countryCode,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "origination.appraisal_firm_created",
          resourceType: "appraisal_firm",
          resourceId: firm.id,
          changes: {
            trace_id: input.traceId,
            name: firm.name,
            country_code: firm.countryCode,
          },
          createdAt: input.createdAt,
        },
      });
      return toAppraisalFirmRecord(firm);
    });
  }

  public async listAppraisalFirms(): Promise<AppraisalFirmRecord[]> {
    const firms = await this.database.appraisalFirm.findMany({
      orderBy: { name: "asc" },
    });
    return firms.map(toAppraisalFirmRecord);
  }

  public async getAppraisalFirmById(id: string): Promise<AppraisalFirmRecord | null> {
    const firm = await this.database.appraisalFirm.findUnique({ where: { id } });
    return firm === null ? null : toAppraisalFirmRecord(firm);
  }

  public async updateAppraisalFirmStatus(input: {
    id: string;
    status: PartnerOrganizationStatus;
    actorAccountId: string;
    traceId: string;
    updatedAt: Date;
  }): Promise<AppraisalFirmRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const existing = await transaction.appraisalFirm.findUnique({ where: { id: input.id } });
      if (existing === null) return null;

      const firm = await transaction.appraisalFirm.update({
        where: { id: input.id },
        data: { status: input.status },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "origination.appraisal_firm_status_updated",
          resourceType: "appraisal_firm",
          resourceId: firm.id,
          changes: {
            trace_id: input.traceId,
            previous_status: existing.status,
            new_status: firm.status,
          },
          createdAt: input.updatedAt,
        },
      });
      return toAppraisalFirmRecord(firm);
    });
  }
}

function toLegalPracticeRecord(practice: {
  id: string;
  name: string;
  countryCode: string;
  status: string;
}): LegalPracticeRecord {
  return {
    id: practice.id,
    name: practice.name,
    countryCode: practice.countryCode,
    status: practice.status as PartnerOrganizationStatus,
  };
}

function toAppraisalFirmRecord(firm: {
  id: string;
  name: string;
  countryCode: string;
  status: string;
}): AppraisalFirmRecord {
  return {
    id: firm.id,
    name: firm.name,
    countryCode: firm.countryCode,
    status: firm.status as PartnerOrganizationStatus,
  };
}
