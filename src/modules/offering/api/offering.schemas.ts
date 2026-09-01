import { z } from "zod";

import { publicOfferingStatuses } from "../domain/public-offering.policy.js";

export const listOfferingsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

export const publicOfferingSchema = z.object({
  id: z.string(),
  status: z.enum(publicOfferingStatuses),
  target_raise_eur: z.string().regex(/^\d+\.\d{2}$/),
  ipo_end_at: z.iso.datetime().nullable(),
  property: z.object({
    property_type: z.literal("residential"),
    country_code: z.string().length(2),
    city: z.string().nullable(),
  }),
});

export const listOfferingsResponseSchema = z.object({
  data: z.array(publicOfferingSchema),
  page: z.object({
    next_cursor: z.string().nullable(),
  }),
});

export const investorOfferingParamsSchema = z.object({
  offering_id: z.string().min(1),
});

const currency = z.string().regex(/^\d+\.\d{2}$/);
const nullableDateTime = z.iso.datetime().nullable();

export const investorOfferingDetailResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.enum(["pre_offering", "final_offering", "closed"]),
    terms: z.object({
      minimum_raise_eur: currency,
      target_raise_eur: currency,
      ipo_end_at: nullableDateTime,
      final_offering_published_at: nullableDateTime,
      platform_rights_end_at: nullableDateTime,
      effective_rights_end_at: nullableDateTime,
    }),
    progress: z.object({
      reserved_capacity_eur: currency,
      funded_eur: currency,
      remaining_capacity_eur: currency,
    }),
    issuer: z.object({
      piv_id: z.string().min(1),
      legal_name: z.string().min(1).nullable(),
      jurisdiction: z.string().min(1).nullable(),
      registration_number: z.string().min(1).nullable(),
      structure_pattern: z.string().min(1),
      incorporated_at: nullableDateTime,
    }),
    property: z.object({
      property_id: z.string().min(1),
      property_type: z.literal("residential"),
      country_code: z.string().length(2),
      city: z.string().nullable(),
      address_line: z.string().nullable(),
      owner_declared_value_eur: currency,
      appraisal_value_opinion_eur: currency.nullable(),
    }),
    current_disclosure_pack: z
      .object({
        disclosure_pack_id: z.string().min(1),
        version: z.number().int().positive(),
        published_at: z.iso.datetime(),
        documents: z.array(
          z.object({
            document_id: z.string().min(1),
            document_type: z.string().min(1),
            document_ref: z.string().min(1),
            is_core_reading: z.boolean(),
          }),
        ),
      })
      .nullable(),
    change_log: z.array(
      z.object({
        materiality_record_id: z.string().min(1),
        description: z.string().min(1),
        classification: z.string().min(1),
        reconfirmation_reset: z.boolean(),
        classified_at: z.iso.datetime(),
      }),
    ),
    readiness: z.object({
      investment_eligible: z.boolean(),
      payment_account_ready: z.boolean(),
      payout_account_verified: z.boolean(),
    }),
    reservation: z.object({
      available: z.boolean(),
      blockers: z.array(
        z.enum([
          "account_restricted",
          "kyc_not_eligible",
          "kyc_renewal_due",
          "login_methods_incomplete",
          "payment_account_not_ready",
          "disclosure_pack_unavailable",
          "offering_not_open",
          "capacity_exhausted",
          "funding_rail_unavailable",
        ]),
      ),
    }),
  }),
});

export type ListOfferingsQuery = z.infer<typeof listOfferingsQuerySchema>;
export type ListOfferingsResponse = z.infer<typeof listOfferingsResponseSchema>;
export type InvestorOfferingDetailResponse = z.infer<
  typeof investorOfferingDetailResponseSchema
>;
