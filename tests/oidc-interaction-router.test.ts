import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type Provider from "oidc-provider";

import { createOidcInteractionRouter } from "../src/modules/auth/api/oidc-interaction.router.js";
import type { AuthenticatedIdentity, SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function buildApp(provider: Provider, sessions: SessionResolver) {
  const app = express();
  app.use(requestContext);
  app.use("/oidc/interaction", createOidcInteractionRouter(provider, sessions));
  app.use(errorHandler);
  return app;
}

function fakeSessionResolver(identity: AuthenticatedIdentity | null): SessionResolver {
  return { resolve: vi.fn().mockResolvedValue(identity) };
}

describe("OIDC interaction router", () => {
  it("requires better-auth authentication for a login prompt", async () => {
    const interactionDetails = vi.fn().mockResolvedValue({
      uid: "int_01",
      prompt: { name: "login", reasons: [], details: {} },
      params: {},
    });
    const interactionFinished = vi.fn();
    const provider = { interactionDetails, interactionFinished } as unknown as Provider;

    const response = await request(buildApp(provider, fakeSessionResolver(null))).get(
      "/oidc/interaction/int_01",
    );

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "authentication.required" });
    expect(interactionFinished).not.toHaveBeenCalled();
  });

  it("rejects a staff_partner identity from native sign-in", async () => {
    const interactionDetails = vi.fn().mockResolvedValue({
      uid: "int_01",
      prompt: { name: "login", reasons: [], details: {} },
      params: {},
    });
    const interactionFinished = vi.fn();
    const provider = { interactionDetails, interactionFinished } as unknown as Provider;
    const sessions = fakeSessionResolver({
      betterAuthUserId: "auth_staff_01",
      providerSessionId: "auth_session_01",
      population: "staff_partner",
    });

    const response = await request(buildApp(provider, sessions)).get("/oidc/interaction/int_01");

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "oidc.customer_only" });
    expect(interactionFinished).not.toHaveBeenCalled();
  });

  it("finishes a login prompt with the better-auth user id once authenticated", async () => {
    const interactionDetails = vi.fn().mockResolvedValue({
      uid: "int_01",
      prompt: { name: "login", reasons: [], details: {} },
      params: {},
    });
    const interactionFinished = vi.fn().mockImplementation(async (_req, res: express.Response) => {
      res.status(302).end();
    });
    const provider = { interactionDetails, interactionFinished } as unknown as Provider;
    const sessions = fakeSessionResolver({
      betterAuthUserId: "auth_customer_01",
      providerSessionId: "auth_session_01",
      population: "customer",
    });

    const response = await request(buildApp(provider, sessions)).get("/oidc/interaction/int_01");

    expect(response.status).toBe(302);
    expect(interactionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: "auth_customer_01", remember: false } },
      { mergeWithLastSubmission: false },
    );
  });

  it("auto-confirms a first-party consent prompt with the missing scope", async () => {
    const addOIDCScope = vi.fn();
    const save = vi.fn().mockResolvedValue("grant_01");
    const GrantConstructor = vi.fn().mockImplementation(function FakeGrant() {
      return { addOIDCScope, save };
    });

    const interactionDetails = vi.fn().mockResolvedValue({
      uid: "int_02",
      prompt: {
        name: "consent",
        reasons: ["op_scopes_missing"],
        details: { missingOIDCScope: ["offline_access"] },
      },
      params: { client_id: "vistablox-native" },
      session: { accountId: "auth_customer_01" },
    });
    const interactionFinished = vi.fn().mockImplementation(async (_req, res: express.Response) => {
      res.status(302).end();
    });
    const provider = {
      interactionDetails,
      interactionFinished,
      Grant: GrantConstructor,
    } as unknown as Provider;

    const response = await request(buildApp(provider, fakeSessionResolver(null))).get(
      "/oidc/interaction/int_02",
    );

    expect(response.status).toBe(302);
    expect(GrantConstructor).toHaveBeenCalledWith({
      accountId: "auth_customer_01",
      clientId: "vistablox-native",
    });
    expect(addOIDCScope).toHaveBeenCalledWith(["offline_access"]);
    expect(interactionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { consent: { grantId: "grant_01" } },
      { mergeWithLastSubmission: true },
    );
  });

  it("aborts an interaction on request", async () => {
    const interactionFinished = vi.fn().mockImplementation(async (_req, res: express.Response) => {
      res.status(302).end();
    });
    const provider = { interactionFinished } as unknown as Provider;

    const response = await request(buildApp(provider, fakeSessionResolver(null))).post(
      "/oidc/interaction/int_01/abort",
    );

    expect(response.status).toBe(302);
    expect(interactionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { error: "access_denied", error_description: "End-user aborted interaction" },
      { mergeWithLastSubmission: false },
    );
  });
});
