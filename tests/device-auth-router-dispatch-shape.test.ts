import { bearer } from "better-auth/plugins";
import { APIError, createAuthEndpoint, dispatchAuthEndpoint } from "better-auth/api";
import { describe, expect, it } from "vitest";

const PATH = "/device/login/verify";
const URL = "http://internal/v1/auth/mobile/login/verify";

/**
 * device-auth.router.ts calls auth.api.enrolVerify/loginVerify with a real
 * `request` (requestForDpopBinding -- needed so DPoP's htu binds to the
 * real /v1 URL, not better-auth's internal mount path). better-auth's own
 * dispatchAuthEndpoint decides whether to return a fetch Response or
 * { response, headers } from exactly one thing: `input.asResponse ??
 * isRequestLike(input.request)` -- a real Request makes that default true
 * unless asResponse is explicitly false. The router destructures
 * `{ response, headers }` off the result; a Response has neither, so
 * `result.device_id` throws a TypeError -- this is the exact #58/#59 bug
 * that made EVERY real E2/L2 call return a 500, confirmed live on
 * staging. device-auth-router.test.ts's mocked auth.api never exercises
 * this real dispatch shape at all, which is why it didn't catch this.
 *
 * These tests hit the real dispatchAuthEndpoint (the same function
 * `auth.api.*` is built on, via toAuthEndpoints) with a stub endpoint, the
 * router's own real options shape, and no database -- confirming the
 * mechanism directly rather than the full plugin end to end.
 */
function buildContext() {
  return {
    secret: "test-secret-at-least-32-characters-long",
    authCookies: {
      sessionToken: { name: "vb.session_token", attributes: {} },
      sessionData: { name: "vb.session_data", attributes: {} },
      accountData: { name: "vb.account_data", attributes: {} },
      dontRememberToken: { name: "vb.dont_remember", attributes: {} },
    },
    createAuthCookie: (name: string) => ({ name: `vb.${name}`, attributes: {} }),
    options: { plugins: [bearer()] },
    logger: {
      level: "error",
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
      debug: () => {},
    },
    // Minimal fake of AuthContext, matching this codebase's own convention
    // for testing against better-auth's real dispatch (see
    // better-auth-dispatch-cookie-merge.test.ts).
  } as never;
}

describe("real dispatchAuthEndpoint shape, matching device-auth.router.ts's own options", () => {
  it("without asResponse: false, a real request makes dispatch return a fetch Response -- reproduces the bug (destructuring .response off this is always undefined)", async () => {
    const stubEndpoint = createAuthEndpoint(PATH, { method: "POST" }, async (ctx) => {
      return ctx.json({ device_id: "device_1" });
    });

    const result = await dispatchAuthEndpoint(stubEndpoint, {
      path: PATH,
      method: "POST",
      headers: new Headers(),
      request: new Request(URL, { method: "POST" }),
      returnHeaders: true,
      context: buildContext(),
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as unknown as { response?: unknown }).response).toBeUndefined();
  });

  it("with asResponse: false, dispatch returns { response, headers } -- what device-auth.router.ts's destructuring actually expects", async () => {
    const stubEndpoint = createAuthEndpoint(PATH, { method: "POST" }, async (ctx) => {
      return ctx.json({ device_id: "device_1", authentication_level: "device_biometric" as const });
    });

    const result = await dispatchAuthEndpoint(stubEndpoint, {
      path: PATH,
      method: "POST",
      headers: new Headers(),
      request: new Request(URL, { method: "POST" }),
      asResponse: false,
      returnHeaders: true,
      context: buildContext(),
    } as never);

    expect(result).not.toBeInstanceOf(Response);
    const { response, headers } = result as { response: { device_id: string }; headers: Headers };
    expect(response.device_id).toBe("device_1");
    expect(headers).toBeInstanceOf(Headers);
  });

  it("with asResponse: false, a thrown APIError is re-thrown (not wrapped in a Response) -- what toAppError's catch block expects", async () => {
    const stubEndpoint = createAuthEndpoint(PATH, { method: "POST" }, async () => {
      throw APIError.from("UNAUTHORIZED", { code: "DEVICE_LOGIN_FAILED", message: "failed" });
    });

    await expect(
      dispatchAuthEndpoint(stubEndpoint, {
        path: PATH,
        method: "POST",
        headers: new Headers(),
        request: new Request(URL, { method: "POST" }),
        asResponse: false,
        returnHeaders: true,
        context: buildContext(),
      } as never),
    ).rejects.toMatchObject({ statusCode: 401, body: { code: "DEVICE_LOGIN_FAILED" } });
  });
});
