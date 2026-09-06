import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

import express from "express";
import { makeSignature } from "better-auth/crypto";
import { toNodeHandler } from "better-auth/node";
import type { JWK } from "oidc-provider";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import { createRequireAuthentication } from "../src/modules/auth/api/require-authentication.js";
import { createOidcInteractionRouter } from "../src/modules/auth/api/oidc-interaction.router.js";
import { CompositeSessionResolver } from "../src/modules/auth/application/composite-session.resolver.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { BetterAuthSessionResolver } from "../src/modules/auth/infrastructure/better-auth-session.resolver.js";
import { OidcBearerSessionResolver } from "../src/modules/auth/infrastructure/oidc-bearer-session.resolver.js";
import { createOidcProvider } from "../src/modules/auth/infrastructure/oidc-provider.factory.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * supertest resolves a bare path against its own ephemeral test-server
 * origin by string-concatenating `http://127.0.0.1:<port>` onto whatever
 * it's given — so a `Location` header that's already absolute (built from
 * oidc-provider's own configured issuer, a different origin) collides into
 * a garbled, unparseable URL. Every redirect in this flow needs to be
 * reduced to just path+query before the next request follows it.
 */
function toPath(location: string): string {
  const url = new URL(location, "http://placeholder.invalid");
  return url.pathname + url.search;
}

/**
 * Closes the one gap the README names for native-client OIDC: every prior
 * exercise either drove the full PKCE flow against an in-memory adapter
 * stand-in, or validated the Postgres adapter's own SQL directly without
 * oidc-provider driving it. This test removes both stand-ins at once — a
 * simulated native client (real PKCE math, no fakes) against the real
 * Express app, the real oidc-provider library, the real Postgres-backed
 * adapter, and a real Better Auth session, exercising the entire chain a
 * physical device would after OAuth and passkey verification: authorize, complete both interaction
 * prompts, exchange the code, call a protected resource with the bearer
 * token, rotate the refresh token, and confirm reuse-detection revokes the
 * whole grant. What it still cannot cover — an actual mobile/desktop app
 * binary and a real reverse-proxied deployment — is named in the README
 * as the remaining gap for a reason: neither is reachable from this
 * backend-only repository.
 */
describe.skipIf(databaseUrl === undefined)("native-client OIDC PKCE end-to-end integration", () => {
  const suffix = randomUUID();
  const email = `native-login-${suffix}@example.test`;
  const accountId = `acct_${suffix}`;
  const nativeRedirectUri = "vistablox://oauth-callback";
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  let betterAuthUserId = "";
  let authCookie = "";
  let app: express.Express;

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
    jwk.kid = randomUUID();
    jwk.use = "sig";
    jwk.alg = "RS256";

    const auth = createBetterAuth({
      database: authPool,
      baseURL: "http://localhost:3000",
      secret: "integration-test-secret-that-is-at-least-32-characters",
      secureCookies: false,
      trustedOrigins: ["http://localhost:3000"],
    });
    const authContext = await auth.$context;
    const created = await authContext.internalAdapter.createUser({
      name: "Native Login Test Investor",
      email,
      emailVerified: true,
      population: "customer",
    }, { method: "internal" });
    betterAuthUserId = created.id;
    const session = await authContext.internalAdapter.createSession(
      created.id,
      false,
      { authenticationLevel: "oauth_passkey" },
      true,
    );
    await authPool.query(
      'UPDATE "auth_session" SET "authenticationLevel" = $1 WHERE "id" = $2',
      ["oauth_passkey", session.id],
    );
    const signedToken = `${session.token}.${await makeSignature(
      session.token,
      "integration-test-secret-that-is-at-least-32-characters",
    )}`;
    authCookie = `${authContext.authCookies.sessionToken.name}=${signedToken}`;
    await database.account.create({ data: { id: accountId, betterAuthUserId } });

    const provider = createOidcProvider({
      baseUrl: "http://localhost:3000",
      pool: authPool,
      cookieSecret: "integration-test-secret-that-is-at-least-32-characters",
      jwks: { keys: [jwk as unknown as JWK] },
      nativeRedirectUris: [nativeRedirectUri],
      secureCookies: false,
    });
    const betterAuthSessions = new BetterAuthSessionResolver(auth);
    const requireAuthentication = createRequireAuthentication(
      new CompositeSessionResolver([betterAuthSessions, new OidcBearerSessionResolver(provider)]),
      new PrismaAccountRepository(database),
    );

    app = express();
    app.use(requestContext);
    app.all("/api/auth/*splat", toNodeHandler(auth));
    app.use(express.json({ limit: "1mb", type: "application/json" }));
    app.use("/oidc/interaction", createOidcInteractionRouter(provider, betterAuthSessions));
    app.use("/oidc", provider.callback());
    app.get("/test/protected", requireAuthentication, (_request, response) => {
      const authContext = response.locals.authContext;
      if (authContext === undefined) throw new Error("authContext missing after requireAuthentication");
      response.json({ account_id: authContext.accountId });
    });
    app.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    if (betterAuthUserId !== "") {
      await authPool.query('DELETE FROM "oidc_model_instances" WHERE "payload"->>\'accountId\' = $1', [
        betterAuthUserId,
      ]);
      await database.account.deleteMany({ where: { id: accountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("drives an OAuth-plus-passkey session through PKCE authorization, token exchange, resource access, and refresh rotation with reuse detection", async () => {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomUUID();

    const authorize = await request(app).get("/oidc/auth").set("Cookie", authCookie).query({
      client_id: "vistablox-native",
      response_type: "code",
      redirect_uri: nativeRedirectUri,
      scope: "openid offline_access",
      // oidc-provider strips offline_access at the very start of the request
      // unless prompt=consent is explicitly requested (check_scope.js) — a
      // real native client requesting refresh-token continuity needs to know
      // this, so the test requests it the same way a real client must.
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    expect(authorize.status).toBeGreaterThanOrEqual(300);
    expect(authorize.status).toBeLessThan(400);
    const loginInteractionPath = toPath(authorize.headers.location as string);
    expect(loginInteractionPath).toContain("/oidc/interaction/");

    // The login interaction: already authenticated via the cookie above, so
    // this resolves immediately without a second credential prompt.
    const loginInteraction = await request(app).get(loginInteractionPath).set("Cookie", authCookie);
    expect(loginInteraction.status).toBeGreaterThanOrEqual(300);
    expect(loginInteraction.status).toBeLessThan(400);
    const afterLoginPath = toPath(loginInteraction.headers.location as string);

    const afterLogin = await request(app).get(afterLoginPath).set("Cookie", authCookie);
    expect(afterLogin.status).toBeGreaterThanOrEqual(300);
    expect(afterLogin.status).toBeLessThan(400);
    const nextLocation = afterLogin.headers.location as string;

    // offline_access on a first authorization needs consent; the router
    // auto-confirms it for this first-party native client. If oidc-provider
    // decided no further interaction was needed, nextLocation is already the
    // client redirect and this second round-trip is skipped.
    let finalRedirectLocation: string;
    if (nextLocation.includes("/oidc/interaction/")) {
      const consentInteraction = await request(app).get(toPath(nextLocation)).set("Cookie", authCookie);
      expect(consentInteraction.status).toBeGreaterThanOrEqual(300);
      expect(consentInteraction.status).toBeLessThan(400);
      const afterConsentPath = toPath(consentInteraction.headers.location as string);

      const afterConsent = await request(app).get(afterConsentPath).set("Cookie", authCookie);
      expect(afterConsent.status).toBeGreaterThanOrEqual(300);
      expect(afterConsent.status).toBeLessThan(400);
      finalRedirectLocation = afterConsent.headers.location as string;
    } else {
      finalRedirectLocation = nextLocation;
    }

    expect(finalRedirectLocation.startsWith(nativeRedirectUri)).toBe(true);
    const clientRedirect = new URL(finalRedirectLocation);
    expect(clientRedirect.searchParams.get("state")).toBe(state);
    const code = clientRedirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await request(app)
      .post("/oidc/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: nativeRedirectUri,
        client_id: "vistablox-native",
        code_verifier: codeVerifier,
      });
    expect(tokenResponse.status).toBe(200);
    const accessToken = tokenResponse.body.access_token as string;
    const refreshToken = tokenResponse.body.refresh_token as string;
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    // No cookie here at all — a real native client only ever has the token.
    const protectedResource = await request(app)
      .get("/test/protected")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(protectedResource.status).toBe(200);
    expect(protectedResource.body).toEqual({ account_id: accountId });

    const refreshResponse = await request(app)
      .post("/oidc/token")
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "vistablox-native" });
    expect(refreshResponse.status).toBe(200);
    const rotatedAccessToken = refreshResponse.body.access_token as string;
    const rotatedRefreshToken = refreshResponse.body.refresh_token as string;
    expect(rotatedRefreshToken).not.toBe(refreshToken);

    const rotatedResourceAccess = await request(app)
      .get("/test/protected")
      .set("Authorization", `Bearer ${rotatedAccessToken}`);
    expect(rotatedResourceAccess.status).toBe(200);

    // Replaying the already-rotated-away refresh token is reuse of a
    // revoked token family — oidc-provider rejects it and, per
    // rotateRefreshToken's documented behavior, revokes the whole grant.
    const reuseAttempt = await request(app)
      .post("/oidc/token")
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "vistablox-native" });
    expect(reuseAttempt.status).toBe(400);

    const postRevocationAccess = await request(app)
      .get("/test/protected")
      .set("Authorization", `Bearer ${rotatedAccessToken}`);
    expect(postRevocationAccess.status).toBe(401);
  });
});
