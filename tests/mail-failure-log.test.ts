import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/infrastructure/logging/logger.js";
import {
  describeMailFailure,
  logMailDeliveryFailure,
  MAIL_DELIVERY_FAILED_EVENT,
  type MailFailureLogger,
} from "../src/shared/logging/mail-failure.js";

const ADDRESS = "Investor.Name+vista@Example.test";

function nodemailerError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("describeMailFailure", () => {
  it("keeps the error code, which is what tells nodemailer failures apart, and the class", () => {
    expect(describeMailFailure(nodemailerError("Greeting never received", "ETIMEDOUT"), [])).toEqual({
      error_class: "Error",
      error_code: "ETIMEDOUT",
      error_message: "Greeting never received",
    });
    expect(describeMailFailure(new TypeError("bad input"), []).error_class).toBe("TypeError");
  });

  it("removes the withheld values wherever they appear and in any case", () => {
    const description = describeMailFailure(
      nodemailerError(`Invalid recipient "${ADDRESS}" / ${ADDRESS.toLowerCase()} / code 482913`, "EENVELOPE"),
      [ADDRESS, "482913"],
    );

    expect(description.error_message).toBe('Invalid recipient "[withheld]" / [withheld] / code [withheld]');
  });

  it("removes an address the caller did not name, such as the one in a server's reply", () => {
    const description = describeMailFailure(
      nodemailerError("Recipient command failed: 550 5.1.1 <someone.else@other.example>: User unknown", "EENVELOPE"),
      [ADDRESS],
    );

    expect(description.error_message).toBe("Recipient command failed: 550 5.1.1 <[email]>: User unknown");
  });

  it("removes a link, and treats a value with regular-expression characters literally", () => {
    const description = describeMailFailure(
      new Error("relay denied for https://mail.example.test/recover?token=abc.def (a+b) at (a+b)"),
      ["(a+b)"],
    );

    expect(description.error_message).toBe("relay denied for [url] [withheld] at [withheld]");
  });

  it("flattens whitespace and cuts a long message", () => {
    const description = describeMailFailure(new Error(`line one\r\nline two\n${"x".repeat(500)}`), []);

    expect(description.error_message.startsWith("line one line two xxx")).toBe(true);
    expect(description.error_message).not.toMatch(/[\r\n]/);
    expect(description.error_message.length).toBeLessThanOrEqual(303);
    expect(description.error_message.endsWith("...")).toBe(true);
  });

  it("does not carry over an error name or code that is not a short identifier", () => {
    const error = Object.assign(new Error("boom"), { code: "see https://example.test/x?token=1", name: "bad name\nwith newline" });

    expect(describeMailFailure(error, [])).toEqual({ error_class: "Error", error_code: null, error_message: "boom" });
    expect(describeMailFailure(Object.assign(new Error("boom"), { code: 535 }), []).error_code).toBeNull();
  });

  it("describes a thrown string or object without echoing the object", () => {
    expect(describeMailFailure(`refused for ${ADDRESS}`, [ADDRESS])).toEqual({
      error_class: "NonError",
      error_code: null,
      error_message: "refused for [withheld]",
    });
    expect(describeMailFailure({ secret: ADDRESS }, [ADDRESS]).error_message).toBe("non-error value thrown");
  });
});

describe("logMailDeliveryFailure", () => {
  it("writes one warn line with a stable event, the kind, the ids and the error shape", () => {
    const warn = vi.fn();

    logMailDeliveryFailure({ warn } as MailFailureLogger, {
      kind: "account_recovery_approved",
      traceId: "trace_9",
      accountId: "acct_9",
      caseId: "case_9",
      error: nodemailerError(`550 <${ADDRESS}> rejected`, "EENVELOPE"),
      withhold: [ADDRESS],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: MAIL_DELIVERY_FAILED_EVENT,
      severity: "warn",
      mail_kind: "account_recovery_approved",
      trace_id: "trace_9",
      account_id: "acct_9",
      case_id: "case_9",
      error_class: "Error",
      error_code: "EENVELOPE",
      error_message: "550 <[withheld]> rejected",
    });
    expect(MAIL_DELIVERY_FAILED_EVENT).toBe("email.delivery_failed");
    expect(typeof warn.mock.calls[0]?.[1]).toBe("string");
  });

  it("does not throw when the error cannot be read, and still logs that something failed", () => {
    const warn = vi.fn();
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter blew up");
      },
    });

    expect(() =>
      logMailDeliveryFailure({ warn } as MailFailureLogger, {
        kind: "device_replacement_code",
        traceId: "t",
        accountId: "a",
        error: hostile,
        withhold: [],
      }),
    ).not.toThrow();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: MAIL_DELIVERY_FAILED_EVENT, error_message: "[unreadable]" });
  });

  it("does not throw when the logger does, because it runs inside the catch that keeps the mail failure away from the caller", () => {
    const warn = vi.fn(() => {
      throw new Error("log destination closed");
    });

    expect(() =>
      logMailDeliveryFailure({ warn } as unknown as MailFailureLogger, {
        kind: "device_replacement_code",
        traceId: "t",
        error: new Error("x"),
        withhold: [],
      }),
    ).not.toThrow();
  });

  it("writes JSON through the real logger with the ids and nothing of the recipient or the code", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger("warn", destination);

    logMailDeliveryFailure(logger, {
      kind: "device_replacement_code",
      traceId: "trace_1",
      accountId: "acct_1",
      error: nodemailerError(`Invalid recipient "${ADDRESS}" (code 482913) via https://smtp.example.test/x`, "EENVELOPE"),
      withhold: [ADDRESS, "482913"],
    });

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 40,
      event: "email.delivery_failed",
      mail_kind: "device_replacement_code",
      trace_id: "trace_1",
      account_id: "acct_1",
      error_code: "EENVELOPE",
      error_message: 'Invalid recipient "[withheld]" (code [withheld]) via [url]',
    });
    expect(lines[0]).not.toMatch(/example\.test\/x|482913|investor/i);
  });
});
