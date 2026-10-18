import { describe, expect, it } from "vitest";

import {
  redactQueryObject,
  redactQueryString,
  redactUrl,
  requestLogSerializer,
} from "../src/infrastructure/logging/request-log-redaction.js";

describe("redactQueryString", () => {
  it("masks the value of a parameter on the deny-list and keeps its name", () => {
    expect(redactQueryString("email=anyone")).toBe("email=[REDACTED]");
    expect(redactQueryString("token=abc&limit=5")).toBe("token=[REDACTED]&limit=5");
  });

  it.each([
    "email",
    "EMAIL",
    "contact_email",
    "ownerEmail",
    "phone",
    "token",
    "access_token",
    "refresh-token",
    "id_token",
    "password",
    "passwd",
    "client_secret",
    "signature",
    "authorization",
    "assertion",
    "challenge",
    "dpop",
    "code",
    "state",
    "otp",
    "key",
    "api_key",
    "name",
    "given_name",
    "family_name",
    "full_name",
    "full_display_name",
  ])("treats %s as a sensitive parameter name", (name) => {
    expect(redactQueryString(`${name}=value`)).toBe(`${name}=[REDACTED]`);
  });

  it.each(["limit", "after", "document_ref", "room_id", "document_type", "country_code", "status"])(
    "leaves %s readable",
    (name) => {
      expect(redactQueryString(`${name}=value_1`)).toBe(`${name}=value_1`);
    },
  );

  it("masks a value that looks like an email under any parameter name", () => {
    expect(redactQueryString("q=jane.doe@example.test")).toBe("q=[REDACTED]");
    expect(redactQueryString("search=jane.doe%40example.test&limit=5")).toBe("search=[REDACTED]&limit=5");
    expect(redactQueryString("q=jane+doe%40example.test")).toBe("q=[REDACTED]");
    expect(redactQueryString("q=JANE%40EXAMPLE.TEST")).toBe("q=[REDACTED]");
    expect(redactQueryString("q=a%40b")).toBe("q=[REDACTED]");
  });

  it("masks an email typed as a prefix, since a search box sends one keystroke at a time", () => {
    expect(redactQueryString("q=jane.doe%40")).toBe("q=[REDACTED]");
  });

  it("masks an email inside a longer value", () => {
    expect(redactQueryString("note=sent+to+jane%40example.test+today")).toBe("note=[REDACTED]");
  });

  it("masks an email that is the parameter name or a bare segment", () => {
    expect(redactQueryString("jane.doe@example.test")).toBe("[REDACTED]");
    expect(redactQueryString("jane.doe%40example.test=1&limit=5")).toBe("[REDACTED]&limit=5");
  });

  it("still masks when the value is not valid percent-encoding", () => {
    expect(redactQueryString("q=%E0%A4%A%40example.test")).toBe("q=[REDACTED]");
    expect(redactQueryString("email=%E0%A4%A")).toBe("email=[REDACTED]");
  });

  it("masks every occurrence of a repeated parameter", () => {
    expect(redactQueryString("email=a%40x.test&email=b%40y.test")).toBe(
      "email=[REDACTED]&email=[REDACTED]",
    );
  });

  it("keeps the shape of everything it does not mask", () => {
    expect(redactQueryString("")).toBe("");
    expect(redactQueryString("limit=5&&after=cursor%5F1&flag&empty=")).toBe(
      "limit=5&&after=cursor%5F1&flag&empty=",
    );
    expect(redactQueryString("document_ref=intake%2Fcase_01%2Fphoto.png")).toBe(
      "document_ref=intake%2Fcase_01%2Fphoto.png",
    );
  });
});

describe("redactUrl", () => {
  it("masks only the query string and keeps the path", () => {
    expect(redactUrl("/internal/v1/accounts?email=jane%40example.test")).toBe(
      "/internal/v1/accounts?email=[REDACTED]",
    );
  });

  it("returns a url without a query string unchanged", () => {
    expect(redactUrl("/v1/offerings")).toBe("/v1/offerings");
    expect(redactUrl("/")).toBe("/");
  });

  it("keeps a question mark that has nothing after it", () => {
    expect(redactUrl("/v1/offerings?")).toBe("/v1/offerings?");
  });

  it("only treats the first question mark as the start of the query", () => {
    expect(redactUrl("/v1/x?token=a?b&limit=1")).toBe("/v1/x?token=[REDACTED]&limit=1");
  });
});

describe("redactQueryObject", () => {
  it("masks by parameter name and by email-shaped value", () => {
    expect(
      redactQueryObject({ email: "jane@example.test", q: "john@example.test", limit: "5" }),
    ).toEqual({ email: "[REDACTED]", q: "[REDACTED]", limit: "5" });
  });

  it("masks inside repeated parameters", () => {
    expect(redactQueryObject({ email: ["a@x.test", "b@y.test"], tag: ["a", "b@y.test"] })).toEqual({
      email: ["[REDACTED]", "[REDACTED]"],
      tag: ["a", "[REDACTED]"],
    });
  });

  it("masks inside nested parameters, and a sensitive name hides the whole subtree", () => {
    expect(
      redactQueryObject({ filter: { contact_email: "jane@example.test", status: "open" }, token: { a: "b" } }),
    ).toEqual({ filter: { contact_email: "[REDACTED]", status: "open" }, token: "[REDACTED]" });
  });

  it("masks a parameter whose name is an email, as the string form does", () => {
    expect(redactQueryObject({ "jane@example.test": "1", limit: "5" })).toEqual({
      "[REDACTED]": "[REDACTED]",
      limit: "5",
    });
  });

  it("does not modify the object it was given", () => {
    const query = { email: "jane@example.test", tag: ["x@y.test"] };

    redactQueryObject(query);

    expect(query).toEqual({ email: "jane@example.test", tag: ["x@y.test"] });
  });

  it("passes through what is not an object", () => {
    expect(redactQueryObject(undefined)).toBeUndefined();
    expect(redactQueryObject(null)).toBeNull();
    expect(redactQueryObject("")).toBe("");
  });

  it("handles an object without a prototype, as node:querystring returns", () => {
    const query = Object.assign(Object.create(null), { email: "jane@example.test", limit: "5" });

    expect(redactQueryObject(query)).toEqual({ email: "[REDACTED]", limit: "5" });
  });
});

describe("requestLogSerializer", () => {
  const request = {
    id: "req_01",
    method: "GET",
    url: "/internal/v1/accounts?email=jane%40example.test",
    query: { email: "jane@example.test" },
    params: {},
    headers: { host: "api.example.test", "x-forwarded-for": "203.0.113.7" },
    remoteAddress: "10.0.0.2",
    remotePort: 41234,
  };

  it("masks url and query and returns every other field untouched", () => {
    const result = requestLogSerializer({ ...request } as never);

    expect(result).toEqual({
      ...request,
      url: "/internal/v1/accounts?email=[REDACTED]",
      query: { email: "[REDACTED]" },
    });
    expect(Object.keys(result)).toEqual(Object.keys(request));
  });

  it("does not add a query field the request did not have", () => {
    const { query: _query, ...withoutQuery } = request;

    const result = requestLogSerializer({ ...withoutQuery } as never);

    expect(Object.keys(result)).toEqual(Object.keys(withoutQuery));
  });

  it("does not modify the serialized request it was given", () => {
    const input = { ...request, query: { email: "jane@example.test" } };

    requestLogSerializer(input as never);

    expect(input.url).toBe(request.url);
    expect(input.query).toEqual({ email: "jane@example.test" });
  });
});
