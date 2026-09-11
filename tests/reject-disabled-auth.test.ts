import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { rejectDisabledAuthRoutes } from "../src/modules/auth/api/reject-disabled-auth.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function buildApp() {
  const app = express();
  app.use(requestContext);
  // Mirrors app.ts's actual mounting exactly (app.all with a wildcard route
  // pattern, not app.use(prefix, ...)) -- req.path only reflects the full
  // /api/auth/... path under the former; app.use's mount-relative stripping
  // would silently make every pattern here match nothing.
  app.all(
    "/api/auth/*splat",
    rejectDisabledAuthRoutes,
    (_request, response) => response.json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

describe("reject disabled auth routes", () => {
  it("404s the generic passkey delete endpoint", async () => {
    const response = await request(buildApp()).post("/api/auth/passkey/delete-passkey");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "resource.not_found", status: 404 });
  });

  it("404s the generic passkey delete endpoint with a trailing slash", async () => {
    const response = await request(buildApp()).post("/api/auth/passkey/delete-passkey/");

    expect(response.status).toBe(404);
  });

  it("leaves update-passkey (rename) open", async () => {
    const response = await request(buildApp()).post("/api/auth/passkey/update-passkey");

    expect(response.status).toBe(200);
  });

  it("leaves the passkey endpoints the mobile app actually uses open", async () => {
    const openPaths = [
      "/api/auth/passkey/list-user-passkeys",
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/passkey/verify-authentication",
      "/api/auth/passkey/generate-register-options",
      "/api/auth/passkey/verify-registration",
    ];

    for (const path of openPaths) {
      const response = await request(buildApp()).post(path);
      expect(response.status).toBe(200);
    }
  });

  it("still 404s disabled credential/email-code routes (pre-existing behavior)", async () => {
    const response = await request(buildApp()).post("/api/auth/sign-in/email");

    expect(response.status).toBe(404);
  });
});
