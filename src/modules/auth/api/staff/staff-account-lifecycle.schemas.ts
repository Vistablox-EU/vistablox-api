import { z } from "zod";

export const staffAccountLifecycleParamsSchema = z.object({
  account_id: z.string().trim().min(1),
});

export const staffRoleAssignmentParamsSchema = z.object({
  account_id: z.string().trim().min(1),
  assignment_id: z.string().trim().min(1),
});

export const recoverStaffAccountBodySchema = z.object({}).strict();

export const offboardStaffAccountBodySchema = z.object({
  reason: z.enum(["employment_ended", "partner_firm_notice", "security_action"]),
});

export const recoverStaffAccountResponseSchema = z.object({
  data: z.object({
    recovery_started: z.literal(true),
    webauthn_reenrollment_required: z.literal(true),
  }),
});

export const offboardStaffAccountResponseSchema = z.object({
  data: z.object({ offboarded: z.literal(true) }),
});

const staffRoleSchema = z.enum(["admin_operations", "legal_partner", "appraisal_partner"]);

const staffRoleAssignmentSchema = z.object({
  assignment_id: z.string(),
  role: staffRoleSchema,
  legal_practice_id: z.string().nullable(),
  appraisal_firm_id: z.string().nullable(),
  granted_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().nullable(),
});

// Unpaginated: the staff/partner roster is organizationally bounded (headcount,
// not customer activity), unlike every cursor-paginated list elsewhere in this API.
export const listStaffAccountsResponseSchema = z.object({
  data: z.array(
    z.object({
      account_id: z.string(),
      email: z.string().nullable(),
      status: z.enum(["active", "recovery_review", "suspended_restricted"]),
      roles: z.array(staffRoleAssignmentSchema),
    }),
  ),
});

export const grantStaffRoleBodySchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("admin_operations"),
    legal_practice_id: z.null().optional().default(null),
    appraisal_firm_id: z.null().optional().default(null),
  }),
  z.object({
    role: z.literal("legal_partner"),
    legal_practice_id: z.string().trim().min(1),
    appraisal_firm_id: z.null().optional().default(null),
  }),
  z.object({
    role: z.literal("appraisal_partner"),
    legal_practice_id: z.null().optional().default(null),
    appraisal_firm_id: z.string().trim().min(1),
  }),
]);

export const grantStaffRoleResponseSchema = z.object({
  data: staffRoleAssignmentSchema,
});

export const revokeStaffRoleResponseSchema = z.object({
  data: z.object({ revoked: z.literal(true) }),
});
