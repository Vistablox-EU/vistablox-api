import type { Logger } from "pino";

import { maskLongHexValues, stripEmailAddresses, stripUrls } from "./log-redaction.js";

// Where a mail failure that the caller deliberately swallows becomes visible.
// The caller keeps its behaviour (the request answers as before, so nothing
// tells a stranger whether an address exists); this only leaves a line an
// operator can find. A line carries ids and the shape of the failure, never
// the recipient, a code, a link or any part of the body: the logging strategy
// wants "what happened to case X", not "whose mailbox is behind account X".

/** The stable name an alert rule or a grep keys on, never the message. */
export const MAIL_DELIVERY_FAILED_EVENT = "email.delivery_failed";

export type MailKind =
  | "account_recovery_case_opened"
  | "account_recovery_approved"
  | "account_recovery_rejected"
  | "account_recovery_completed"
  | "account_recovery_reenrolment_notice"
  | "device_replacement_code";

export type MailFailureLogger = Pick<Logger, "warn">;

const WITHHELD_PLACEHOLDER = "[withheld]";
const UNREADABLE_PLACEHOLDER = "[unreadable]";
const MAX_MESSAGE_LENGTH = 300;
// An error name or code is a short identifier ("Error", "ETIMEDOUT", "EAUTH").
// Anything else is not carried over, so a hostile or odd value cannot be
// smuggled into a log line through these two fields.
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface MailFailureDescription {
  error_class: string;
  error_code: string | null;
  error_message: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubMessage(text: string, withhold: readonly string[]): string {
  let scrubbed = text;
  // The values this mail carries come out first and literally, so they go even
  // where the pattern based passes below would not recognise them (a code is
  // just digits).
  for (const value of withhold) {
    if (value.length === 0) continue;
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(value), "gi"), WITHHELD_PLACEHOLDER);
  }
  scrubbed = maskLongHexValues(stripEmailAddresses(stripUrls(scrubbed))).replace(/\s+/g, " ").trim();
  return scrubbed.length > MAX_MESSAGE_LENGTH ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}...` : scrubbed;
}

/**
 * The loggable shape of a send failure. nodemailer throws a plain `Error`
 * whose `name` says nothing, so the discriminating field is its `code`
 * (ETIMEDOUT, ESOCKET, ECONNECTION, EAUTH, EENVELOPE ...). The message is
 * scrubbed: nodemailer appends the server's reply to it and an envelope error
 * quotes the recipient, so `withhold` names what this particular mail carries
 * (the recipient, a one-time code) and must never survive.
 */
export function describeMailFailure(error: unknown, withhold: readonly string[]): MailFailureDescription {
  if (!(error instanceof Error)) {
    return {
      error_class: "NonError",
      error_code: null,
      error_message: scrubMessage(typeof error === "string" ? error : "non-error value thrown", withhold),
    };
  }
  const code = (error as { code?: unknown }).code;
  return {
    error_class: IDENTIFIER.test(error.name) ? error.name : "Error",
    error_code: typeof code === "string" && IDENTIFIER.test(code) ? code : null,
    error_message: scrubMessage(error.message, withhold),
  };
}

/**
 * Logs one swallowed mail failure at warn. It cannot throw: it runs inside the
 * catch block that exists to keep a mail failure from reaching the caller, so
 * a failure to describe or write the line must not undo that.
 */
export function logMailDeliveryFailure(
  logger: MailFailureLogger,
  input: {
    kind: MailKind;
    traceId: string;
    accountId?: string;
    caseId?: string;
    error: unknown;
    withhold: readonly string[];
  },
): void {
  try {
    let description: MailFailureDescription;
    try {
      description = describeMailFailure(input.error, input.withhold);
    } catch {
      description = { error_class: "Error", error_code: null, error_message: UNREADABLE_PLACEHOLDER };
    }
    logger.warn(
      {
        event: MAIL_DELIVERY_FAILED_EVENT,
        severity: "warn",
        mail_kind: input.kind,
        trace_id: input.traceId,
        account_id: input.accountId,
        case_id: input.caseId,
        ...description,
      },
      "email delivery failed; the request carried on without it",
    );
  } catch {
    // Nothing to fall back to: the swallow around the send is the contract.
  }
}
