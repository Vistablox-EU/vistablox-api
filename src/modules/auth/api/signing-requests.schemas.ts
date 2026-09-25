import { z } from "zod";

import {
  SIGNING_REQUEST_CLIENT_FILTERABLE_STATUSES,
  SIGNING_REQUEST_STATUSES,
  TX_CREATED_BY_KINDS,
  TX_DESTINATION_KINDS,
} from "../domain/signing-request.policy.js";
import { mobileAttestationSchema } from "../application/mobile-attestation.schemas.js";

// T1 (plan table row): the request object the client reads. `destination` may
// carry a display-only `display_name` the server stored (never signed, never
// compared -- contract 3.2's destination has just {kind, value}; the T1 echo
// may enrich it for rendering). `user_op` is on-chain-only and absent here.

export const signingRequestObjectSchema = z.object({
  request_id: z.string(),
  request_type: z.string(),
  amount_minor: z.string().nullable(),
  currency: z.string().nullable(),
  destination: z
    .object({
      kind: z.enum(TX_DESTINATION_KINDS),
      value: z.string(),
      display_name: z.string().optional(),
    })
    .nullable(),
  created_by: z.object({
    kind: z.enum(TX_CREATED_BY_KINDS),
    label: z.string(),
  }),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  status: z.enum(SIGNING_REQUEST_STATUSES),
});

export const signingRequestsListResponseSchema = z.object({
  data: z.array(signingRequestObjectSchema),
});

export const signingRequestResponseSchema = z.object({
  data: signingRequestObjectSchema,
});

// Optional?status= filter (T1); validated against the client-filterable set,
// defaulting to `pending` -- the actionable inbox.
export const signingRequestsListQuerySchema = z.object({
  status: z.enum(SIGNING_REQUEST_CLIENT_FILTERABLE_STATUSES).optional(),
});

export const signingRequestParamsSchema = z.object({
  request_id: z.string().min(1),
});

// T2 (contract table row): session-authenticated, empty request body.
export const signingChallengeRequestSchema = z.object({});

export const signingChallengeResponseSchema = z.object({
  data: z.object({
    challenge: z.string(),
    expires_at: z.iso.datetime(),
  }),
});

// T3 (contract table row, off-chain types): the device signs the tx claims
// and returns the JWS plus the challenge it was issued at T2. Attestation is
// part of the contract on every signing action; this phase records it without
// enforcing an integrity verdict (matching the plan's staging posture), so
// the schema demands it but the handler passes it through unexamined.
export const signingSignRequestSchema = z.object({
  challenge: z.string().min(1),
  jws: z.string().min(1),
  attestation: mobileAttestationSchema,
});

// T3 response. The contract's literal is `submitted|executed`; see
// signing-requests.router.ts for why this phase can also answer `signed`.
export const signingSignResponseSchema = z.object({
  data: z.object({
    status: z.enum(["signed", "submitted", "executed"]),
  }),
});