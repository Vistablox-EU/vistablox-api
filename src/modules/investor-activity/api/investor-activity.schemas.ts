import { z } from "zod";

const dateTime = z.iso.datetime();

export const investorActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

const investorPropertySummarySchema = z.object({
  property_type: z.literal("residential"),
  country_code: z.string().regex(/^[A-Z]{2}$/),
  city: z.string().nullable(),
});

export const investorReservationHistoryResponseSchema = z.object({
  data: z.array(
    z.object({
      reservation_id: z.string().min(1),
      offering_id: z.string().min(1),
      offering_status: z.enum(["pre_offering", "final_offering", "closed"]),
      amount_eur: z.string().regex(/^\d+\.\d{2}$/),
      reservation_stage: z.enum([
        "initiated",
        "awaiting_reconfirmation",
        "reconfirmed",
        "finalized",
        "cancelled",
        "lapsed",
      ]),
      disclosure_pack_version_at_reservation: z.string().nullable(),
      reconfirmed_at: dateTime.nullable(),
      reservation_finalized_at: dateTime.nullable(),
      created_at: dateTime,
      latest_capital_state: z
        .object({
          state: z.enum([
            "initiated",
            "eurc_purchase_pending",
            "purchase_failed",
            "eurc_reserved",
            "reconfirmation_pending",
            "eurc_finalized",
            "provider_disputed",
          ]),
          amount_eur: z.string().regex(/^\d+\.\d{2}$/),
          amount_eurc: z.string().regex(/^\d+\.\d{6}$/).nullable(),
          recorded_at: dateTime,
        })
        .nullable(),
      property: investorPropertySummarySchema,
    }),
  ),
  page: z.object({ next_cursor: z.string().nullable() }),
});

export const investorCurrentPositionsResponseSchema = z.object({
  data: z.array(
    z.object({
      position_id: z.string().min(1),
      // Null for a position that was not created from a reservation: today
      // that is the AD-256 escrow mint (recordEscrowMintedPosition writes no
      // reservation_id), and CORE_TABLES allows the same for owner-retained
      // positions. offering_id is resolved only through the reservation, so
      // it is null with it.
      reservation_id: z.string().min(1).nullable(),
      offering_id: z.string().min(1).nullable(),
      piv_id: z.string().min(1),
      unit_count: z.string().regex(/^\d+\.\d{6}$/),
      cost_basis_eur: z.string().regex(/^\d+\.\d{2}$/),
      position_status: z.enum(["pending_internal_settlement", "active"]),
      activated_at: dateTime.nullable(),
      property: investorPropertySummarySchema,
    }),
  ),
  page: z.object({ next_cursor: z.string().nullable() }),
});

export type InvestorActivityQuery = z.infer<typeof investorActivityQuerySchema>;
