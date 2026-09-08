import { describe, expect, it, vi } from "vitest";

import {
  CreateAppraisalFirmService,
  CreateLegalPracticeService,
  ListAppraisalFirmsService,
  ListLegalPracticesService,
  UpdateAppraisalFirmStatusService,
  UpdateLegalPracticeStatusService,
} from "../src/modules/origination/application/partner-organization.service.js";
import type {
  AppraisalFirmRecord,
  LegalPracticeRecord,
  PartnerOrganizationRepository,
} from "../src/modules/origination/repository/partner-organization.repository.js";

const now = new Date("2026-09-05T12:00:00.000Z");

const legalPractice: LegalPracticeRecord = {
  id: "legal_practice_01",
  name: "Avocats Example",
  countryCode: "FR",
  status: "active",
};

const appraisalFirm: AppraisalFirmRecord = {
  id: "appraisal_firm_01",
  name: "Example Valuations",
  countryCode: "DE",
  status: "active",
};

function buildFakeRepository(
  overrides: Partial<PartnerOrganizationRepository> = {},
): PartnerOrganizationRepository {
  return {
    createLegalPractice: vi.fn().mockResolvedValue(legalPractice),
    listLegalPractices: vi.fn().mockResolvedValue([legalPractice]),
    getLegalPracticeById: vi.fn().mockResolvedValue(legalPractice),
    updateLegalPracticeStatus: vi.fn().mockResolvedValue({ ...legalPractice, status: "suspended" }),
    createAppraisalFirm: vi.fn().mockResolvedValue(appraisalFirm),
    listAppraisalFirms: vi.fn().mockResolvedValue([appraisalFirm]),
    getAppraisalFirmById: vi.fn().mockResolvedValue(appraisalFirm),
    updateAppraisalFirmStatus: vi.fn().mockResolvedValue({ ...appraisalFirm, status: "suspended" }),
    ...overrides,
  };
}

describe("partner organization services", () => {
  it("creates a legal practice and returns its wire payload", async () => {
    const repository = buildFakeRepository();
    const service = new CreateLegalPracticeService(repository, () => now);

    const result = await service.execute({
      name: "Avocats Example",
      countryCode: "FR",
      actorAccountId: "acct_admin",
      traceId: "trace_1",
    });

    expect(repository.createLegalPractice).toHaveBeenCalledWith({
      name: "Avocats Example",
      countryCode: "FR",
      actorAccountId: "acct_admin",
      traceId: "trace_1",
      createdAt: now,
    });
    expect(result.data).toEqual({
      legal_practice_id: "legal_practice_01",
      name: "Avocats Example",
      country_code: "FR",
      status: "active",
    });
  });

  it("lists legal practices", async () => {
    const repository = buildFakeRepository();
    const service = new ListLegalPracticesService(repository);

    const result = await service.execute();

    expect(result.data).toEqual([
      { legal_practice_id: "legal_practice_01", name: "Avocats Example", country_code: "FR", status: "active" },
    ]);
  });

  it("updates a legal practice's status", async () => {
    const repository = buildFakeRepository();
    const service = new UpdateLegalPracticeStatusService(repository, () => now);

    const result = await service.execute({
      id: "legal_practice_01",
      status: "suspended",
      actorAccountId: "acct_admin",
      traceId: "trace_2",
    });

    expect(repository.updateLegalPracticeStatus).toHaveBeenCalledWith({
      id: "legal_practice_01",
      status: "suspended",
      actorAccountId: "acct_admin",
      traceId: "trace_2",
      updatedAt: now,
    });
    expect(result.data.status).toBe("suspended");
  });

  it("rejects a status update for a legal practice that does not exist", async () => {
    const repository = buildFakeRepository({
      updateLegalPracticeStatus: vi.fn().mockResolvedValue(null),
    });
    const service = new UpdateLegalPracticeStatusService(repository, () => now);

    await expect(
      service.execute({
        id: "legal_practice_missing",
        status: "suspended",
        actorAccountId: "acct_admin",
        traceId: "trace_3",
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.legal_practice_not_found" });
  });

  it("creates an appraisal firm and returns its wire payload", async () => {
    const repository = buildFakeRepository();
    const service = new CreateAppraisalFirmService(repository, () => now);

    const result = await service.execute({
      name: "Example Valuations",
      countryCode: "DE",
      actorAccountId: "acct_admin",
      traceId: "trace_4",
    });

    expect(repository.createAppraisalFirm).toHaveBeenCalledWith({
      name: "Example Valuations",
      countryCode: "DE",
      actorAccountId: "acct_admin",
      traceId: "trace_4",
      createdAt: now,
    });
    expect(result.data).toEqual({
      appraisal_firm_id: "appraisal_firm_01",
      name: "Example Valuations",
      country_code: "DE",
      status: "active",
    });
  });

  it("lists appraisal firms", async () => {
    const repository = buildFakeRepository();
    const service = new ListAppraisalFirmsService(repository);

    const result = await service.execute();

    expect(result.data).toEqual([
      { appraisal_firm_id: "appraisal_firm_01", name: "Example Valuations", country_code: "DE", status: "active" },
    ]);
  });

  it("rejects a status update for an appraisal firm that does not exist", async () => {
    const repository = buildFakeRepository({
      updateAppraisalFirmStatus: vi.fn().mockResolvedValue(null),
    });
    const service = new UpdateAppraisalFirmStatusService(repository, () => now);

    await expect(
      service.execute({
        id: "appraisal_firm_missing",
        status: "suspended",
        actorAccountId: "acct_admin",
        traceId: "trace_5",
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.appraisal_firm_not_found" });
  });
});
