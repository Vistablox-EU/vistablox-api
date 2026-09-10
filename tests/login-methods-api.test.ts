import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createLoginMethodsRouter } from "../src/modules/auth/api/login-methods.router.js";
import { UnlinkLoginMethodService } from "../src/modules/auth/application/unlink-login-method.service.js";
import {
  LoginMethodNotLinkedError,
  RegistrationLoginMethodLockedError,
  type LoginMethodUnlinker,
} from "../src/modules/auth/application/login-method-unlinker.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function appFor(unlinker: LoginMethodUnlinker) {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "acct_01",
      providerSessionId: "session_01",
      population: "customer",
    };
    next();
  };
  app.use(requestContext);
  app.use(
    "/v1/auth/login-methods",
    createLoginMethodsRouter(authenticated, new UnlinkLoginMethodService(unlinker)),
  );
  app.use(errorHandler);
  return app;
}

describe("login methods API", () => {
  it("unlinks a non-registration social login method", async () => {
    const unlinker: LoginMethodUnlinker = { unlink: vi.fn().mockResolvedValue(undefined) };

    const response = await request(appFor(unlinker)).post(
      "/v1/auth/login-methods/apple/unlink",
    );

    expect(response.status).toBe(204);
    expect(unlinker.unlink).toHaveBeenCalledWith("apple", expect.anything());
  });

  it("refuses to unlink the login method used at registration", async () => {
    const unlinker: LoginMethodUnlinker = {
      unlink: vi.fn().mockRejectedValue(new RegistrationLoginMethodLockedError("google")),
    };

    const response = await request(appFor(unlinker)).post(
      "/v1/auth/login-methods/google/unlink",
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "authentication.registration_login_method_locked",
    });
  });

  it("reports an unlinked method as not found", async () => {
    const unlinker: LoginMethodUnlinker = {
      unlink: vi.fn().mockRejectedValue(new LoginMethodNotLinkedError("apple")),
    };

    const response = await request(appFor(unlinker)).post(
      "/v1/auth/login-methods/apple/unlink",
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: "authentication.login_method_not_linked",
    });
  });

  it("rejects unlinking a passkey through this route", async () => {
    const unlinker: LoginMethodUnlinker = { unlink: vi.fn() };

    const response = await request(appFor(unlinker)).post(
      "/v1/auth/login-methods/passkey/unlink",
    );

    expect(response.status).toBe(422);
  });
});
