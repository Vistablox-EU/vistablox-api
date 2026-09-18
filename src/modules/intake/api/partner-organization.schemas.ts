import { z } from "zod";

const partnerOrganizationStatusSchema = z.enum(["active", "suspended"]);

const partnerOrganizationNameSchema = z.string().trim().min(1).max(200);
const countryCodeSchema = z
  .string()
  .length(2)
  .transform((value) => value.toUpperCase());

export const legalPracticeParamsSchema = z.object({
  legal_practice_id: z.string().trim().min(1),
});

export const createLegalPracticeBodySchema = z.object({
  name: partnerOrganizationNameSchema,
  country_code: countryCodeSchema,
});

export const updateLegalPracticeStatusBodySchema = z.object({
  status: partnerOrganizationStatusSchema,
});

const legalPracticeSchema = z.object({
  legal_practice_id: z.string(),
  name: z.string(),
  country_code: z.string(),
  status: partnerOrganizationStatusSchema,
});

export const legalPracticeResponseSchema = z.object({ data: legalPracticeSchema });
export const listLegalPracticesResponseSchema = z.object({ data: z.array(legalPracticeSchema) });

export const appraisalFirmParamsSchema = z.object({
  appraisal_firm_id: z.string().trim().min(1),
});

export const createAppraisalFirmBodySchema = z.object({
  name: partnerOrganizationNameSchema,
  country_code: countryCodeSchema,
});

export const updateAppraisalFirmStatusBodySchema = z.object({
  status: partnerOrganizationStatusSchema,
});

const appraisalFirmSchema = z.object({
  appraisal_firm_id: z.string(),
  name: z.string(),
  country_code: z.string(),
  status: partnerOrganizationStatusSchema,
});

export const appraisalFirmResponseSchema = z.object({ data: appraisalFirmSchema });
export const listAppraisalFirmsResponseSchema = z.object({ data: z.array(appraisalFirmSchema) });
