export type PartnerOrganizationStatus = "active" | "suspended";

export interface LegalPracticeRecord {
  id: string;
  name: string;
  countryCode: string;
  status: PartnerOrganizationStatus;
}

export interface AppraisalFirmRecord {
  id: string;
  name: string;
  countryCode: string;
  status: PartnerOrganizationStatus;
}

export interface PartnerOrganizationRepository {
  createLegalPractice(input: {
    name: string;
    countryCode: string;
    actorAccountId: string;
    traceId: string;
    createdAt: Date;
  }): Promise<LegalPracticeRecord>;
  listLegalPractices(): Promise<LegalPracticeRecord[]>;
  getLegalPracticeById(id: string): Promise<LegalPracticeRecord | null>;
  updateLegalPracticeStatus(input: {
    id: string;
    status: PartnerOrganizationStatus;
    actorAccountId: string;
    traceId: string;
    updatedAt: Date;
  }): Promise<LegalPracticeRecord | null>;

  createAppraisalFirm(input: {
    name: string;
    countryCode: string;
    actorAccountId: string;
    traceId: string;
    createdAt: Date;
  }): Promise<AppraisalFirmRecord>;
  listAppraisalFirms(): Promise<AppraisalFirmRecord[]>;
  getAppraisalFirmById(id: string): Promise<AppraisalFirmRecord | null>;
  updateAppraisalFirmStatus(input: {
    id: string;
    status: PartnerOrganizationStatus;
    actorAccountId: string;
    traceId: string;
    updatedAt: Date;
  }): Promise<AppraisalFirmRecord | null>;
}
