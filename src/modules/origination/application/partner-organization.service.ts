import { AppError } from "../../../shared/errors/app-error.js";
import type {
  AppraisalFirmRecord,
  LegalPracticeRecord,
  PartnerOrganizationRepository,
  PartnerOrganizationStatus,
} from "../repository/partner-organization.repository.js";

export class CreateLegalPracticeService {
  public constructor(
    private readonly repository: PartnerOrganizationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    name: string;
    countryCode: string;
    actorAccountId: string;
    traceId: string;
  }) {
    const practice = await this.repository.createLegalPractice({
      name: input.name,
      countryCode: input.countryCode,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      createdAt: this.clock(),
    });
    return { data: toLegalPracticePayload(practice) };
  }
}

export class ListLegalPracticesService {
  public constructor(private readonly repository: PartnerOrganizationRepository) {}

  public async execute() {
    const practices = await this.repository.listLegalPractices();
    return { data: practices.map(toLegalPracticePayload) };
  }
}

export class UpdateLegalPracticeStatusService {
  public constructor(
    private readonly repository: PartnerOrganizationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    id: string;
    status: PartnerOrganizationStatus;
    actorAccountId: string;
    traceId: string;
  }) {
    const practice = await this.repository.updateLegalPracticeStatus({
      id: input.id,
      status: input.status,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      updatedAt: this.clock(),
    });
    if (practice === null) throw partnerOrganizationNotFoundError("legal_practice");
    return { data: toLegalPracticePayload(practice) };
  }
}

export class CreateAppraisalFirmService {
  public constructor(
    private readonly repository: PartnerOrganizationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    name: string;
    countryCode: string;
    actorAccountId: string;
    traceId: string;
  }) {
    const firm = await this.repository.createAppraisalFirm({
      name: input.name,
      countryCode: input.countryCode,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      createdAt: this.clock(),
    });
    return { data: toAppraisalFirmPayload(firm) };
  }
}

export class ListAppraisalFirmsService {
  public constructor(private readonly repository: PartnerOrganizationRepository) {}

  public async execute() {
    const firms = await this.repository.listAppraisalFirms();
    return { data: firms.map(toAppraisalFirmPayload) };
  }
}

export class UpdateAppraisalFirmStatusService {
  public constructor(
    private readonly repository: PartnerOrganizationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    id: string;
    status: PartnerOrganizationStatus;
    actorAccountId: string;
    traceId: string;
  }) {
    const firm = await this.repository.updateAppraisalFirmStatus({
      id: input.id,
      status: input.status,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      updatedAt: this.clock(),
    });
    if (firm === null) throw partnerOrganizationNotFoundError("appraisal_firm");
    return { data: toAppraisalFirmPayload(firm) };
  }
}

function toLegalPracticePayload(practice: LegalPracticeRecord) {
  return {
    legal_practice_id: practice.id,
    name: practice.name,
    country_code: practice.countryCode,
    status: practice.status,
  };
}

function toAppraisalFirmPayload(firm: AppraisalFirmRecord) {
  return {
    appraisal_firm_id: firm.id,
    name: firm.name,
    country_code: firm.countryCode,
    status: firm.status,
  };
}

function partnerOrganizationNotFoundError(
  resourceType: "legal_practice" | "appraisal_firm",
): AppError {
  return new AppError({
    code: `origination.${resourceType}_not_found`,
    title: "Partner organization not found",
    status: 404,
    detail: `No ${resourceType.replace("_", " ")} exists with the given id.`,
  });
}
