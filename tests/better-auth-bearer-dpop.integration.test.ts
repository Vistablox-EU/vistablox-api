import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createAuthEndpoint, dispatchAuthEndpoint } from "better-auth/api";
import { toNodeHandler } from "better-auth/node";
import { serializeSignedCookie } from "better-call";
import express from "express";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import { createLoginMethodsRouter } from "../src/modules/auth/api/customer/login-methods.router.js";
import { createRequireFreshAuthentication } from "../src/modules/auth/api/customer/require-fresh-authentication.js";
import { createRequireAuthentication } from "../src/modules/auth/api/shared/require-authentication.js";
import { rejectDisabledAuthRoutes } from "../src/modules/auth/api/shared/reject-disabled-auth.js";
import { decideDpopForSession } from "../src/modules/auth/application/shared/dpop-proof-verifier.js";
import { RegistrationLoginMethodLockedError } from "../src/modules/auth/application/customer/login-method-unlinker.js";
import { UnlinkLoginMethodService } from "../src/modules/auth/application/customer/unlink-login-method.service.js";
import { BetterAuthLoginMethodUnlinker } from "../src/modules/auth/infrastructure/customer/better-auth-login-method-unlinker.js";
import { BetterAuthSessionResolver } from "../src/modules/auth/infrastructure/shared/better-auth-session.resolver.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/shared/better-auth.factory.js";
import { PrismaCustomerSessionRepository } from "../src/modules/auth/repository/customer/prisma-customer-session.repository.js";
import { PrismaDpopReplayRepository } from "../src/modules/auth/repository/shared/prisma-dpop-replay.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const SECRET = "integration-test-secret-that-is-at-least-32-characters";
const HOUR = 60 * 60 * 1000;
const WWW_AUTHENTICATE = 'DPoP error="invalid_dpop_proof"';

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jkt: string;
}

interface Fixture {
  userId: string;
  sessionId: string;
  /** The value after "Bearer ": the signed session token as the app stores and sends it (the set-auth-token value, "value.signature="). */
  bearer: string;
  /** The same token spelled the way a Set-Cookie value carries it (percent-encoded). */
  bearerEncoded: string;
  /** The unsigned session token, as it is stored in auth_session. */
  rawToken: string;
  /** "<cookie name>=<signed value>": the same session, presented as better-auth's own cookie. */
  cookie: string;
  /** The key the session is bound to. */
  keyA: TestKey;
  email: string;
  /** The Google subject the fixture's google account is linked under. */
  googleSubject: string;
  /** The earlier-created linked account: the "registration" account. */
  registrationAccountRowId: string;
  laterAccountRowId: string;
}

interface Observed {
  status: number;
  /** `body.code` of an error response (both better-auth's APIError and /v1's AppError put it there). */
  code: string | undefined;
  wwwAuthenticate: string | undefined;
  body: unknown;
}

type Transport = "bearer" | "cookie";

/**
 * DPoP device binding, and the registration-account unlink guard, on
 * better-auth's own /api/auth/* surface for a request that carries only a
 * bearer token (no Cookie header), which is how the mobile app calls it.
 *
 * Contract: every request carries a proof; a session bound to a device key
 * rejects a proof from another key, a missing proof, a malformed one and a
 * replayed one; and the sign-in method an account was created with cannot be
 * unlinked. better-auth-dpop.plugin.ts and
 * better-auth-registration-account-guard.plugin.ts are before-hooks, and
 * better-auth hands every before-hook the ORIGINAL request, applying the
 * session cookie bearer() builds from Authorization only to the endpoint once
 * all hooks have run. The hooks resolve the session through getSessionForHook
 * (better-auth-hook-session.ts) for that reason; this suite pins that they do,
 * for bearer-only requests exactly as for cookie ones.
 *
 * It runs against the real factory, a real Postgres and the real DPoP replay
 * repository, mounted the way src/app.ts mounts /api/auth
 * (rejectDisabledAuthRoutes -> toNodeHandler(auth), ahead of express.json()).
 * Left out of that mount: the rate limiter, cors, helmet and pino-http (none
 * touch Authorization, Cookie or DPoP). Left out of the factory: deviceAuth and
 * authAuditSink (the DPoP and guard hooks do not depend on them). The
 * controls show the same session, key and proofs are enforced over a cookie,
 * on /v1 and by the verifier itself, and the replay table records a proof only
 * when the verifier actually ran.
 *
 * Fixture: a customer with two linked social accounts and a device_biometric
 * session bound to key A. The session is minted by better-auth's own
 * internalAdapter.createSession, called inside a STUB endpoint (registered at
 * /device/login/verify and dispatched through better-auth's dispatchAuthEndpoint
 * with a key-A proof on the request). That runs the product's real
 * session.create.before database hook, which verifies the proof, binds
 * dpopJkt (tryBindDpopAtCreation) and picks authenticationLevel from the
 * path. The real device enrol/login ceremony (challenge, attestation, device
 * JWS) is NOT exercised, and nothing about the session is set by SQL. The only
 * non-default column values are the two accounts' createdAt, passed to
 * linkAccount so "earliest" is unambiguous.
 */
describe.skipIf(databaseUrl === undefined)(
  "better-auth /api/auth: DPoP and unlink guard for bearer-only requests, real stack",
  () => {
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    const replayRepository = new PrismaDpopReplayRepository(database);
    const accountRepository = new PrismaAccountRepository(database);

    const createdUserIds: string[] = [];
    const createdLocalAccountIds: string[] = [];
    const jktsToClean = new Set<string>();

    let auth: ReturnType<typeof createBetterAuth>;
    let app: express.Express;
    let keyB: TestKey;
    let sessionCookieName = "";
    let bound: Fixture;
    let appPostCutover: express.Express;
    let appNoDpop: express.Express;

    beforeAll(async () => {
      auth = createBetterAuth({
        database: authPool,
        baseURL: BASE_URL,
        secret: SECRET,
        secureCookies: false,
        trustedOrigins: [BASE_URL],
        dpop: { baseUrl: BASE_URL, replayRepository },
        // sign-in/social with an ID token, for the "already carries a live
        // bearer" case: the provider's signature check is stubbed, every claim
        // is read from the token as usual.
        google: { clientId: "test-google-client", clientSecret: "test-google-secret", verifyIdToken: async () => true } as never,
      });
      const authContext = await auth.$context;
      sessionCookieName = authContext.authCookies.sessionToken.name;

      app = express();
      app.use(requestContext);
      app.all("/api/auth/*splat", rejectDisabledAuthRoutes, toNodeHandler(auth));
      app.use(express.json({ limit: "1mb", type: "application/json" }));
      // The /v1 enforcement path, used as a control: same session resolver,
      // same replay repository, same baseUrl.
      const requireAuthentication = createRequireAuthentication(
        new BetterAuthSessionResolver(auth, authPool),
        accountRepository,
        undefined,
        { baseUrl: BASE_URL, replayRepository },
      );
      app.get("/v1/test/protected", requireAuthentication, (_request, response) => {
        response.json({ ok: true });
      });
      // The real /v1 unlink route, wired as in src/app.ts. The fixtures'
      // sessions are device-biometric sessions created moments ago, so the
      // real fresh-authentication middleware lets them through.
      app.use(
        "/v1/auth/login-methods",
        createLoginMethodsRouter(
          requireAuthentication,
          createRequireFreshAuthentication(new PrismaCustomerSessionRepository(database)),
          new UnlinkLoginMethodService(new BetterAuthLoginMethodUnlinker(auth)),
        ),
      );
      app.use(errorHandler);

      // The same stack with the Phase 1 cutover an hour in the past, so a
      // session created now is "post-cutover", and a stack with no DPoP hook at all.
      appPostCutover = express().all(
        "/api/auth/*splat",
        toNodeHandler(
          createBetterAuth({
            database: authPool,
            baseURL: BASE_URL,
            secret: SECRET,
            secureCookies: false,
            trustedOrigins: [BASE_URL],
            dpop: { baseUrl: BASE_URL, replayRepository, phase1CutoverAt: new Date(Date.now() - HOUR) },
          }),
        ),
      );
      appNoDpop = express().all(
        "/api/auth/*splat",
        toNodeHandler(
          createBetterAuth({
            database: authPool,
            baseURL: BASE_URL,
            secret: SECRET,
            secureCookies: false,
            trustedOrigins: [BASE_URL],
          }),
        ),
      );

      keyB = await newKey();
      bound = await createFixture("bound");
    }, 30_000);

    afterAll(async () => {
      for (const jkt of jktsToClean) {
        await authPool.query("DELETE FROM auth.dpop_replays WHERE jkt = $1", [jkt]);
      }
      // account.accounts -> auth_user is ON DELETE RESTRICT, so it goes first;
      // deleting the auth_user then cascades to its sessions and accounts.
      await database.account.deleteMany({ where: { id: { in: createdLocalAccountIds } } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1::text[])', [createdUserIds]);
      await Promise.all([database.$disconnect(), authPool.end()]);
    });

    async function newKey(): Promise<TestKey> {
      const pair = await generateKeyPair("ES256", { extractable: true });
      const publicJwk = await exportJWK(pair.publicKey);
      const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
      jktsToClean.add(jkt);
      return { privateKey: pair.privateKey, publicJwk, jkt };
    }

    /**
     * A proof shaped like the mobile app's (src/lib/dpop.ts): typ dpop+jwt,
     * ES256 with a raw r||s signature, the public jwk in the header, htm
     * upper-case, htu scheme+host+path without query, and an ath over the
     * bearer string exactly as sent.
     */
    async function signProof(
      key: TestKey,
      input: { method: string; path: string; bearer?: string },
    ): Promise<{ header: string; jti: string }> {
      const jti = randomBytes(16).toString("base64url");
      const header = await new SignJWT({
        htm: input.method.toUpperCase(),
        htu: `${BASE_URL}${input.path}`,
        iat: Math.floor(Date.now() / 1000),
        jti,
        ...(input.bearer === undefined
          ? {}
          : { ath: createHash("sha256").update(input.bearer, "ascii").digest("base64url") }),
      })
        .setProtectedHeader({
          alg: "ES256",
          typ: "dpop+jwt",
          jwk: key.publicJwk as unknown as Record<string, unknown>,
        })
        .sign(key.privateKey);
      return { header, jti };
    }

    /** A proof for a request made over `transport`: only bearer requests carry an ath. */
    function proofFor(
      fixture: Fixture,
      key: TestKey,
      transport: Transport,
      method: string,
      path: string,
    ): Promise<{ header: string; jti: string }> {
      return signProof(key, {
        method,
        path,
        ...(transport === "bearer" ? { bearer: fixture.bearer } : {}),
      });
    }

    /** How many times the verifier recorded this (jkt, jti): zero means it never ran. */
    async function recordedProofs(jkt: string, jti: string): Promise<number> {
      const result = await authPool.query<{ count: string }>(
        "SELECT count(*) AS count FROM auth.dpop_replays WHERE jkt = $1 AND jti = $2",
        [jkt, jti],
      );
      return Number(result.rows[0]?.count);
    }

    /**
     * One HTTP request through the Express app. "bearer" sends Authorization
     * only (no Cookie header at all, no Origin: what the mobile app sends);
     * "cookie" sends the same session as better-auth's cookie, with the Origin
     * its CSRF check wants.
     */
    async function send(input: {
      fixture: Fixture;
      transport: Transport;
      method: "GET" | "POST";
      path: string;
      dpop?: string;
      body?: object;
      /** Add an Origin header to a bearer request (cookie requests always carry one). */
      origin?: boolean;
      /** Also send this fixture's session cookie next to the bearer (two credentials in one request). */
      alsoCookieOf?: Fixture;
      /** Send through another stack than the default one. */
      via?: express.Express;
    }): Promise<Observed> {
      const agent = request(input.via ?? app);
      const pending = input.method === "GET" ? agent.get(input.path) : agent.post(input.path);
      if (input.transport === "bearer") {
        pending.set("Authorization", `Bearer ${input.fixture.bearer}`);
        if (input.origin === true || input.alsoCookieOf !== undefined) pending.set("Origin", BASE_URL);
        if (input.alsoCookieOf !== undefined) pending.set("Cookie", input.alsoCookieOf.cookie);
      } else {
        pending.set("Cookie", input.fixture.cookie).set("Origin", BASE_URL);
      }
      if (input.dpop !== undefined) pending.set("DPoP", input.dpop);
      if (input.body !== undefined) pending.send(input.body);
      const response = await pending;
      const body = response.body as { code?: unknown } | null;
      const wwwAuthenticate = response.headers["www-authenticate"];
      return {
        status: response.status,
        code: typeof body?.code === "string" ? body.code : undefined,
        wwwAuthenticate: typeof wwwAuthenticate === "string" ? wwwAuthenticate : undefined,
        body: response.body,
      };
    }

    /** A bearer-style GET with an arbitrary Authorization value (no Cookie), for tokens that are not a fixture's signed bearer. */
    async function fetchWithAuthorization(
      authorization: string,
      path: string,
      dpop?: string,
      via?: express.Express,
    ): Promise<Observed> {
      const pending = request(via ?? app).get(path).set("Authorization", authorization);
      if (dpop !== undefined) pending.set("DPoP", dpop);
      const response = await pending;
      const body = response.body as { code?: unknown } | null;
      const wwwAuthenticate = response.headers["www-authenticate"];
      return {
        status: response.status,
        code: typeof body?.code === "string" ? body.code : undefined,
        wwwAuthenticate: typeof wwwAuthenticate === "string" ? wwwAuthenticate : undefined,
        body: response.body,
      };
    }

    /** An unsigned Google ID token for the fixture's linked google account (the provider's signature check is stubbed in this suite). */
    function googleIdToken(fixture: Fixture): string {
      return [
        { alg: "none", typ: "JWT" },
        {
          iss: "https://accounts.google.com",
          aud: "test-google-client",
          sub: fixture.googleSubject,
          email: fixture.email,
          email_verified: true,
          name: "Bearer DPoP sign-in",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        },
      ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .concat("signature")
        .join(".");
    }

    /** sign-in/social with no bearer and no proof: the session it creates is not bound to any key. */
    async function signInWithoutProof(fixture: Fixture): Promise<{ bearer: string; token: string }> {
      const response = await request(app)
        .post("/api/auth/sign-in/social")
        .send({ provider: "google", idToken: { token: googleIdToken(fixture) } });
      expect(response.status).toBe(200);
      const bearer = response.headers["set-auth-token"];
      expect(typeof bearer).toBe("string");
      return { bearer: bearer as string, token: (response.body as { token: string }).token };
    }

    function expectDpopRejection(observed: Observed, code: string): void {
      expect(observed).toMatchObject({ status: 401, code, wwwAuthenticate: WWW_AUTHENTICATE });
    }

    /** See "Fixture" in the describe block's comment above: two linked accounts and a key-A-bound session. */
    async function createFixture(label: string): Promise<Fixture> {
      const suffix = randomUUID();
      const authContext = await auth.$context;
      const user = await authContext.internalAdapter.createUser(
        {
          name: `Bearer DPoP ${label}`,
          email: `bearer-dpop-${label}-${suffix}@example.test`,
          emailVerified: true,
        },
        { method: "internal" },
      );
      createdUserIds.push(user.id);
      const localAccountId = `acct_${suffix}`;
      await database.account.create({
        data: { id: localAccountId, betterAuthUserId: user.id, status: "active" },
      });
      createdLocalAccountIds.push(localAccountId);

      // Distinct, explicit createdAt: "earliest" must not depend on a tie.
      const registration = await authContext.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "google",
        accountId: `google-${suffix}`,
        issuer: "https://accounts.google.com",
        createdAt: new Date(Date.now() - 2 * HOUR),
      } as never);
      const later = await authContext.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "apple",
        accountId: `apple-${suffix}`,
        issuer: "https://appleid.apple.com",
        createdAt: new Date(Date.now() - HOUR),
      } as never);

      const keyA = await newKey();
      const verifyPath = "/api/auth/device/login/verify";
      const creationProof = await signProof(keyA, { method: "POST", path: verifyPath });
      const headers = new Headers({ dpop: creationProof.header });
      const mintSession = createAuthEndpoint("/device/login/verify", { method: "POST" }, async (ctx) =>
        ctx.context.internalAdapter.createSession(user.id, false),
      );
      const session = (await dispatchAuthEndpoint(mintSession, {
        path: "/device/login/verify",
        method: "POST",
        headers,
        request: new Request(`${BASE_URL}${verifyPath}`, { method: "POST", headers }),
        asResponse: false,
        context: authContext,
      } as never)) as { id: string; token: string };

      const stored = await authPool.query<{ dpopJkt: string | null; authenticationLevel: string }>(
        'SELECT "dpopJkt", "authenticationLevel" FROM "auth_session" WHERE "id" = $1',
        [session.id],
      );
      expect(stored.rows[0]).toEqual({ dpopJkt: keyA.jkt, authenticationLevel: "device_biometric" });

      return {
        userId: user.id,
        email: user.email,
        googleSubject: `google-${suffix}`,
        sessionId: session.id,
        // bearer()'s own signing: serializeSignedCookie("", token, secret) minus the "=".
        // bearer()'s own signing is serializeSignedCookie("", token, secret) minus
        // the "="; that is the percent-encoded spelling, and the app sends it decoded.
        bearer: decodeURIComponent((await serializeSignedCookie("", session.token, SECRET)).replace("=", "")),
        bearerEncoded: (await serializeSignedCookie("", session.token, SECRET)).replace("=", ""),
        rawToken: session.token,
        cookie: (await serializeSignedCookie(sessionCookieName, session.token, SECRET)).split(";")[0] ?? "",
        keyA,
        registrationAccountRowId: registration.id,
        laterAccountRowId: later.id,
      };
    }

    async function accountRowExists(rowId: string): Promise<boolean> {
      const result = await authPool.query('SELECT 1 FROM "auth_account" WHERE "id" = $1', [rowId]);
      return (result.rowCount ?? 0) > 0;
    }

    async function sessionRowExists(sessionId: string): Promise<boolean> {
      const result = await authPool.query('SELECT 1 FROM "auth_session" WHERE "id" = $1', [sessionId]);
      return (result.rowCount ?? 0) > 0;
    }

    describe("controls: the same session and proofs ARE enforced when something enforces them", () => {
      const GET_SESSION = "/api/auth/get-session";

      it("CONTROL cookie: get-session with the correct key-A proof is accepted, and the verifier records it", async () => {
        const p = await proofFor(bound, bound.keyA, "cookie", "GET", GET_SESSION);

        const observed = await send({ fixture: bound, transport: "cookie", method: "GET", path: GET_SESSION, dpop: p.header });

        expect(observed.status).toBe(200);
        expect(observed.body).toMatchObject({ session: { id: bound.sessionId, dpopJkt: bound.keyA.jkt } });
        expect(await recordedProofs(bound.keyA.jkt, p.jti)).toBe(1);
      });

      it("CONTROL cookie: get-session with a valid proof from key B is 401 DPOP_KEY_MISMATCH", async () => {
        const p = await proofFor(bound, keyB, "cookie", "GET", GET_SESSION);

        const observed = await send({ fixture: bound, transport: "cookie", method: "GET", path: GET_SESSION, dpop: p.header });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
      });

      it("CONTROL cookie: get-session with no DPoP header is 401 DPOP_PROOF_MISSING", async () => {
        const observed = await send({ fixture: bound, transport: "cookie", method: "GET", path: GET_SESSION });

        expectDpopRejection(observed, "DPOP_PROOF_MISSING");
      });

      it("CONTROL cookie: replaying the same proof is 401 DPOP_REPLAY the second time", async () => {
        const p = await proofFor(bound, bound.keyA, "cookie", "GET", GET_SESSION);
        const replayed = { fixture: bound, transport: "cookie", method: "GET", path: GET_SESSION, dpop: p.header } as const;

        const first = await send(replayed);
        const second = await send(replayed);

        expect(first.status).toBe(200);
        expectDpopRejection(second, "DPOP_REPLAY");
      });

      it("CONTROL cookie: the hook covers other /api/auth routes too (list-accounts with key B is 401)", async () => {
        const path = "/api/auth/list-accounts";
        const p = await proofFor(bound, keyB, "cookie", "GET", path);

        const observed = await send({ fixture: bound, transport: "cookie", method: "GET", path, dpop: p.header });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
      });

      it("CONTROL /v1 (requireAuthentication): the same session, bearer and proofs are enforced", async () => {
        const path = "/v1/test/protected";
        const good = await proofFor(bound, bound.keyA, "bearer", "GET", path);
        const wrongKey = await proofFor(bound, keyB, "bearer", "GET", path);
        const get = (dpop?: string) =>
          send({ fixture: bound, transport: "bearer", method: "GET", path, ...(dpop === undefined ? {} : { dpop }) });

        expect(await get(good.header)).toMatchObject({ status: 200, body: { ok: true } });
        expectDpopRejection(await get(wrongKey.header), "DPOP_KEY_MISMATCH");
        expectDpopRejection(await get(), "DPOP_PROOF_MISSING");
        expectDpopRejection(await get(good.header), "DPOP_REPLAY");
      });

      it("CONTROL verifier: decideDpopForSession, which the hook would call, accepts and rejects these exact proofs", async () => {
        const url = `${BASE_URL}${GET_SESSION}`;
        const decide = (header: string | undefined) =>
          decideDpopForSession({
            header,
            method: "GET",
            url,
            bearerToken: bound.bearer,
            boundJkt: bound.keyA.jkt,
            sessionCreatedAt: new Date(),
            phase1CutoverAt: undefined,
            recordProof: (jkt, jti, expiresAt) => replayRepository.recordProof(jkt, jti, expiresAt),
          });
        const good = await proofFor(bound, bound.keyA, "bearer", "GET", GET_SESSION);
        const wrongKey = await proofFor(bound, keyB, "bearer", "GET", GET_SESSION);

        await expect(decide(good.header)).resolves.toEqual({ action: "pass" });
        await expect(decide(wrongKey.header)).rejects.toMatchObject({ code: "DPOP_KEY_MISMATCH" });
        await expect(decide(undefined)).rejects.toMatchObject({ code: "DPOP_PROOF_MISSING" });
        await expect(decide(good.header)).rejects.toMatchObject({ code: "DPOP_REPLAY" });
      });
    });

    describe("bearer-only /api/auth/* (Authorization header, no Cookie), as the mobile app calls it", () => {
      const GET_SESSION = "/api/auth/get-session";

      it("get-session with the correct key-A proof is accepted, and the verifier records the proof", async () => {
        const p = await proofFor(bound, bound.keyA, "bearer", "GET", GET_SESSION);

        const observed = await send({ fixture: bound, transport: "bearer", method: "GET", path: GET_SESSION, dpop: p.header });

        expect(observed.status).toBe(200);
        expect(observed.body).toMatchObject({ session: { id: bound.sessionId, dpopJkt: bound.keyA.jkt } });
        // The cookie control above leaves exactly this row: it is how we know
        // the verifier ran rather than the request merely being let through.
        expect(await recordedProofs(bound.keyA.jkt, p.jti)).toBe(1);
      });

      it("the percent-encoded spelling of the same signed token authenticates too, and is enforced the same way", async () => {
        const encoded = bound.bearerEncoded;
        expect(encoded).not.toBe(bound.bearer);
        const good = await signProof(bound.keyA, { method: "GET", path: GET_SESSION, bearer: encoded });
        const wrongKey = await signProof(keyB, { method: "GET", path: GET_SESSION, bearer: encoded });

        const accepted = await fetchWithAuthorization(`Bearer ${encoded}`, GET_SESSION, good.header);
        const rejected = await fetchWithAuthorization(`Bearer ${encoded}`, GET_SESSION, wrongKey.header);

        expect(accepted.status).toBe(200);
        expect(await recordedProofs(bound.keyA.jkt, good.jti)).toBe(1);
        expectDpopRejection(rejected, "DPOP_KEY_MISMATCH");
      });

      it("get-session with a valid proof from a DIFFERENT key B is 401 DPOP_KEY_MISMATCH", async () => {
        const p = await proofFor(bound, keyB, "bearer", "GET", GET_SESSION);

        const observed = await send({ fixture: bound, transport: "bearer", method: "GET", path: GET_SESSION, dpop: p.header });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
        // Rejected before it was recorded.
        expect(await recordedProofs(keyB.jkt, p.jti)).toBe(0);
      });

      it("an Origin header does not change that: still 401 DPOP_KEY_MISMATCH", async () => {
        const p = await proofFor(bound, keyB, "bearer", "GET", GET_SESSION);

        const observed = await send({
          fixture: bound,
          transport: "bearer",
          method: "GET",
          path: GET_SESSION,
          dpop: p.header,
          origin: true,
        });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
      });

      it("get-session with NO DPoP header on the bound session is 401 DPOP_PROOF_MISSING", async () => {
        const observed = await send({ fixture: bound, transport: "bearer", method: "GET", path: GET_SESSION });

        expectDpopRejection(observed, "DPOP_PROOF_MISSING");
      });

      it("replaying the exact same correct proof is 401 DPOP_REPLAY the second time", async () => {
        const p = await proofFor(bound, bound.keyA, "bearer", "GET", GET_SESSION);
        const replayed = { fixture: bound, transport: "bearer", method: "GET", path: GET_SESSION, dpop: p.header } as const;

        const first = await send(replayed);
        const second = await send(replayed);

        expect(first.status).toBe(200);
        expectDpopRejection(second, "DPOP_REPLAY");
        expect(await recordedProofs(bound.keyA.jkt, p.jti)).toBe(1);
      });

      it("a malformed DPoP header, and a proof whose ath is for another token, are 401 DPOP_PROOF_INVALID", async () => {
        const wrongAth = await signProof(bound.keyA, { method: "GET", path: GET_SESSION, bearer: "some-other-token" });

        const malformed = await send({ fixture: bound, transport: "bearer", method: "GET", path: GET_SESSION, dpop: "not-a-jwt" });
        const otherToken = await send({ fixture: bound, transport: "bearer", method: "GET", path: GET_SESSION, dpop: wrongAth.header });

        expectDpopRejection(malformed, "DPOP_PROOF_INVALID");
        expectDpopRejection(otherToken, "DPOP_PROOF_INVALID");
      });

      it("it covers more than get-session: list-accounts with key B is 401 DPOP_KEY_MISMATCH", async () => {
        const path = "/api/auth/list-accounts";
        const p = await proofFor(bound, keyB, "bearer", "GET", path);

        const observed = await send({ fixture: bound, transport: "bearer", method: "GET", path, dpop: p.header });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
      });

      it("a state-changing route too: sign-out with no DPoP header is 401 and the session survives", async () => {
        const victim = await createFixture("sign-out");
        expect(await sessionRowExists(victim.sessionId)).toBe(true);

        const observed = await send({ fixture: victim, transport: "bearer", method: "POST", path: "/api/auth/sign-out" });

        expectDpopRejection(observed, "DPOP_PROOF_MISSING");
        expect(await sessionRowExists(victim.sessionId)).toBe(true);
      });

      it("sign-out with the correct proof still works", async () => {
        const fixture = await createFixture("sign-out-ok");
        const path = "/api/auth/sign-out";
        const p = await proofFor(fixture, fixture.keyA, "bearer", "POST", path);

        const observed = await send({ fixture, transport: "bearer", method: "POST", path, dpop: p.header });

        expect(observed).toMatchObject({ status: 200, body: { success: true } });
        expect(await sessionRowExists(fixture.sessionId)).toBe(false);
      });
    });

    describe("a device session past its time limit, as the mobile app meets it", () => {
      it("get-session still answers 401 REAUTH_REQUIRED, which is how the app learns to log in on the device again", async () => {
        // The device-session-lifetime plugin turns an expired device session
        // into REAUTH_REQUIRED from the expired row it finds on the request
        // context. Resolving the session in the DPoP hook must not consume
        // that row: better-auth's own session lookup deletes an expired
        // session, so the answer would turn into an anonymous 200 null.
        const expired = await createFixture("expired-device-session");
        await authPool.query(
          `UPDATE "auth_session" SET "createdAt" = now() - interval '2 hours', "updatedAt" = now() - interval '2 hours' WHERE "id" = $1`,
          [expired.sessionId],
        );
        const path = "/api/auth/get-session";
        const p = await proofFor(expired, expired.keyA, "bearer", "GET", path);

        const observed = await send({ fixture: expired, transport: "bearer", method: "GET", path, dpop: p.header });

        expect(observed).toMatchObject({ status: 401, code: "REAUTH_REQUIRED" });
        expect(await sessionRowExists(expired.sessionId)).toBe(false);
      });

      it("a signed token for a session that no longer exists stays an anonymous 200 null, as without the hook", async () => {
        const gone = await createFixture("deleted-session");
        await authPool.query('DELETE FROM "auth_session" WHERE "id" = $1', [gone.sessionId]);
        const path = "/api/auth/get-session";
        const p = await proofFor(gone, gone.keyA, "bearer", "GET", path);

        const observed = await send({ fixture: gone, transport: "bearer", method: "GET", path, dpop: p.header });

        expect(observed).toMatchObject({ status: 200, body: null });
      });
    });

    describe("only the signed session token authenticates as a bearer", () => {
      it("the bare session token is not a bearer, even with a proof that fits it", async () => {
        // The unsigned token is what auth_session stores and what some
        // better-auth responses return in a `token` field. If bearer() signed
        // it itself, anything that learned it would authenticate without the
        // signature, and the DPoP hook (which only looks at signed tokens)
        // would not see the session at all.
        const path = "/api/auth/list-accounts";
        const p = await signProof(bound.keyA, { method: "GET", path, bearer: bound.rawToken });

        const observed = await fetchWithAuthorization(`Bearer ${bound.rawToken}`, path, p.header);

        expect(observed).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
        expect(await recordedProofs(bound.keyA.jkt, p.jti)).toBe(0);
      });

      it("the bare token does not get a session from get-session either (200 with a null body)", async () => {
        const path = "/api/auth/get-session";
        const p = await signProof(bound.keyA, { method: "GET", path, bearer: bound.rawToken });

        const observed = await fetchWithAuthorization(`Bearer ${bound.rawToken}`, path, p.header);

        expect(observed).toMatchObject({ status: 200, body: null });
      });

      it("a token that came back from list-sessions is the bare one, so it is no bearer", async () => {
        const listPath = "/api/auth/list-sessions";
        const p = await proofFor(bound, bound.keyA, "bearer", "GET", listPath);
        const listed = await send({ fixture: bound, transport: "bearer", method: "GET", path: listPath, dpop: p.header });
        expect(listed.status).toBe(200);
        const entry = (listed.body as Array<{ token?: string }>).find((candidate) => candidate.token === bound.rawToken);
        // Documents why the signed form matters: the bare token is in the response.
        expect(entry).toBeDefined();
        const listedToken = entry?.token ?? "";

        const path = "/api/auth/list-accounts";
        const q = await signProof(bound.keyA, { method: "GET", path, bearer: listedToken });
        const observed = await fetchWithAuthorization(`Bearer ${listedToken}`, path, q.header);

        expect(observed).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
      });
    });

    describe("two credentials in one request: the Authorization bearer wins, as it does for the endpoint", () => {
      it("a bearer for one session next to a cookie for another session, proved with the cookie session's key, is 401 DPOP_KEY_MISMATCH", async () => {
        // The endpoint acts on the bearer's session (bearer() replaces the
        // session cookie). Checking the cookie's session instead would let a
        // request bring its own valid cookie and key next to somebody else's
        // bearer and pass.
        const other = await createFixture("mixed-other");
        const path = "/api/auth/get-session";
        const p = await signProof(other.keyA, { method: "GET", path, bearer: bound.bearer });

        const observed = await send({
          fixture: bound,
          transport: "bearer",
          method: "GET",
          path,
          dpop: p.header,
          alsoCookieOf: other,
        });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
      });

      it("the same request proved with the BEARER session's own key is accepted and returns that session", async () => {
        const other = await createFixture("mixed-other-ok");
        const path = "/api/auth/get-session";
        const p = await signProof(bound.keyA, { method: "GET", path, bearer: bound.bearer });

        const observed = await send({
          fixture: bound,
          transport: "bearer",
          method: "GET",
          path,
          dpop: p.header,
          alsoCookieOf: other,
        });

        expect(observed.status).toBe(200);
        expect(observed.body).toMatchObject({ session: { id: bound.sessionId } });
        expect(await recordedProofs(bound.keyA.jkt, p.jti)).toBe(1);
      });

      it("a bearer that does not verify leaves the request's own cookie in charge, and that is enforced too", async () => {
        const path = "/api/auth/get-session";
        const tampered: Fixture = { ...bound, bearer: `${bound.bearer.slice(0, -4)}AAAA` };
        const wrongKey = await signProof(keyB, { method: "GET", path, bearer: tampered.bearer });

        const observed = await send({
          fixture: tampered,
          transport: "bearer",
          method: "GET",
          path,
          dpop: wrongKey.header,
          alsoCookieOf: bound,
        });

        // The tampered bearer is ignored by bearer(); the cookie session is the
        // endpoint's, and a proof from key B does not match its binding.
        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
      });
    });

    describe("a request that already carries a live bearer and then creates a session", () => {
      it("sign-in/social binds the new session to the proof's key, and the verifier ran for it", async () => {
        // The generic DPoP hook now sees the bearer's session and verifies the
        // proof first. Session creation must reuse that verification:
        // verifying the same (jkt, jti) again would lose to the first as a
        // replay and leave the new session unbound.
        const fixture = await createFixture("sign-in-with-bearer");
        const path = "/api/auth/sign-in/social";
        const p = await signProof(fixture.keyA, { method: "POST", path, bearer: fixture.bearer });

        const observed = await send({
          fixture,
          transport: "bearer",
          method: "POST",
          path,
          dpop: p.header,
          body: { provider: "google", idToken: { token: googleIdToken(fixture) } },
        });

        expect(observed.status).toBe(200);
        const newToken = (observed.body as { token?: string }).token;
        expect(typeof newToken).toBe("string");
        expect(newToken).not.toBe(fixture.rawToken);
        const stored = await authPool.query<{ dpopJkt: string | null }>(
          'SELECT "dpopJkt" FROM "auth_session" WHERE "token" = $1',
          [newToken],
        );
        expect(stored.rows[0]?.dpopJkt).toBe(fixture.keyA.jkt);
        expect(await recordedProofs(fixture.keyA.jkt, p.jti)).toBe(1);
      });

      it("sign-in/social with that live bearer and a proof from ANOTHER key is 401 DPOP_KEY_MISMATCH and creates no session", async () => {
        const fixture = await createFixture("sign-in-wrong-key");
        const path = "/api/auth/sign-in/social";
        const p = await signProof(keyB, { method: "POST", path, bearer: fixture.bearer });
        const sessionCount = async () =>
          Number((await authPool.query('SELECT count(*) AS count FROM "auth_session" WHERE "userId" = $1', [fixture.userId])).rows[0]?.count);
        const before = await sessionCount();

        const observed = await send({
          fixture,
          transport: "bearer",
          method: "POST",
          path,
          dpop: p.header,
          body: { provider: "google", idToken: { token: googleIdToken(fixture) } },
        });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
        expect(await sessionCount()).toBe(before);
      });
    });

    describe("a session that was created without a proof (not bound to a key yet)", () => {
      // Before the hook could see bearer sessions this branch never ran for the
      // mobile app. It is the same decision /v1 makes (decideDpopForSession).
      it("passes without a proof, as in Phase 1", async () => {
        const user = await createFixture("unbound-no-proof");
        const unbound = await signInWithoutProof(user);

        const observed = await fetchWithAuthorization(`Bearer ${unbound.bearer}`, "/api/auth/get-session");

        expect(observed.status).toBe(200);
        expect(observed.body).toMatchObject({ session: { token: unbound.token } });
      });

      it("before the cutover, a valid proof binds it to that key on first sight", async () => {
        const user = await createFixture("unbound-bind");
        const unbound = await signInWithoutProof(user);
        const key = await newKey();
        const path = "/api/auth/get-session";
        const p = await signProof(key, { method: "GET", path, bearer: unbound.bearer });

        const observed = await fetchWithAuthorization(`Bearer ${unbound.bearer}`, path, p.header);

        expect(observed.status).toBe(200);
        const stored = await authPool.query<{ dpopJkt: string | null }>(
          'SELECT "dpopJkt" FROM "auth_session" WHERE "token" = $1',
          [unbound.token],
        );
        expect(stored.rows[0]?.dpopJkt).toBe(key.jkt);
        expect(await recordedProofs(key.jkt, p.jti)).toBe(1);
      });

      it("after the cutover, a proof presented for it is 401 DPOP_KEY_MISMATCH", async () => {
        const user = await createFixture("unbound-post-cutover");
        const unbound = await signInWithoutProof(user);
        const key = await newKey();
        const path = "/api/auth/get-session";
        const p = await signProof(key, { method: "GET", path, bearer: unbound.bearer });

        const observed = await fetchWithAuthorization(`Bearer ${unbound.bearer}`, path, p.header, appPostCutover);

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
      });
    });

    describe("state-changing routes check the proof too", () => {
      it("update-user with a proof from another key is 401 DPOP_KEY_MISMATCH and changes nothing", async () => {
        const fixture = await createFixture("update-user");
        const path = "/api/auth/update-user";
        const p = await proofFor(fixture, keyB, "bearer", "POST", path);

        const observed = await send({ fixture, transport: "bearer", method: "POST", path, dpop: p.header, body: { name: "Renamed" } });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
        const stored = await authPool.query<{ name: string }>('SELECT "name" FROM "auth_user" WHERE "id" = $1', [fixture.userId]);
        expect(stored.rows[0]?.name).toBe("Bearer DPoP update-user");
      });

      it("revoke-sessions with a proof from another key is 401 DPOP_KEY_MISMATCH and the session survives", async () => {
        const fixture = await createFixture("revoke-sessions");
        const path = "/api/auth/revoke-sessions";
        const p = await proofFor(fixture, keyB, "bearer", "POST", path);

        const observed = await send({ fixture, transport: "bearer", method: "POST", path, dpop: p.header });

        expectDpopRejection(observed, "DPOP_KEY_MISMATCH");
        expect(await sessionRowExists(fixture.sessionId)).toBe(true);
      });
    });

    describe("registration-account guard on POST /api/auth/unlink-account", () => {
      const UNLINK = "/api/auth/unlink-account";

      // Each case gets its own user: an unlink that goes through really
      // deletes the account row, which would corrupt a shared fixture.
      async function unlink(
        transport: Transport,
        target: "registration" | "later",
      ): Promise<{ fixture: Fixture; observed: Observed; targetRowId: string; otherRowId: string }> {
        const fixture = await createFixture(`unlink-${transport}-${target}`);
        const targetRowId = target === "registration" ? fixture.registrationAccountRowId : fixture.laterAccountRowId;
        const otherRowId = target === "registration" ? fixture.laterAccountRowId : fixture.registrationAccountRowId;
        const p = await proofFor(fixture, fixture.keyA, transport, "POST", UNLINK);
        const observed = await send({
          fixture,
          transport,
          method: "POST",
          path: UNLINK,
          dpop: p.header,
          body: { accountId: targetRowId },
        });
        return { fixture, observed, targetRowId, otherRowId };
      }

      it("bearer: unlinking the EARLIEST (registration) account with a correct proof is 403 REGISTRATION_LOGIN_METHOD_LOCKED and the row stays", async () => {
        const { observed, targetRowId, otherRowId } = await unlink("bearer", "registration");

        expect(observed).toMatchObject({ status: 403, code: "REGISTRATION_LOGIN_METHOD_LOCKED" });
        expect(await accountRowExists(targetRowId)).toBe(true);
        expect(await accountRowExists(otherRowId)).toBe(true);
      });

      it("the guard does not depend on the DPoP hook: with no hook in the stack, bearer-only unlinking the registration account is still 403", async () => {
        const fixture = await createFixture("guard-only");

        const observed = await send({
          fixture,
          transport: "bearer",
          method: "POST",
          path: UNLINK,
          body: { accountId: fixture.registrationAccountRowId },
          via: appNoDpop,
        });

        expect(observed).toMatchObject({ status: 403, code: "REGISTRATION_LOGIN_METHOD_LOCKED" });
        expect(await accountRowExists(fixture.registrationAccountRowId)).toBe(true);
      });

      it("bearer, CONTROL: unlinking the LATER account with a correct proof succeeds", async () => {
        const { observed, targetRowId, otherRowId } = await unlink("bearer", "later");

        expect(observed).toMatchObject({ status: 200, body: { status: true } });
        expect(await accountRowExists(targetRowId)).toBe(false);
        expect(await accountRowExists(otherRowId)).toBe(true);
      });

      it("cookie, CONTROL: the same unlink of the registration account is refused", async () => {
        const { observed, targetRowId } = await unlink("cookie", "registration");

        expect(observed).toMatchObject({ status: 403, code: "REGISTRATION_LOGIN_METHOD_LOCKED" });
        expect(await accountRowExists(targetRowId)).toBe(true);
      });

      it("cookie, CONTROL: unlinking the later account over a cookie succeeds", async () => {
        const { observed, targetRowId } = await unlink("cookie", "later");

        expect(observed).toMatchObject({ status: 200, body: { status: true } });
        expect(await accountRowExists(targetRowId)).toBe(false);
      });

      it("the /v1 route's mechanism, BetterAuthLoginMethodUnlinker given the app's bearer-only headers, refuses the registration account", async () => {
        const fixture = await createFixture("unlinker");
        const unlinker = new BetterAuthLoginMethodUnlinker(auth);

        await expect(unlinker.unlink("google", { authorization: `Bearer ${fixture.bearer}` })).rejects.toBeInstanceOf(
          RegistrationLoginMethodLockedError,
        );
        expect(await accountRowExists(fixture.registrationAccountRowId)).toBe(true);
      });

      it("the same unlinker with the headers carrying the session as a cookie refuses too", async () => {
        const fixture = await createFixture("unlinker-cookie");
        const unlinker = new BetterAuthLoginMethodUnlinker(auth);

        await expect(unlinker.unlink("google", { cookie: fixture.cookie })).rejects.toBeInstanceOf(
          RegistrationLoginMethodLockedError,
        );
        expect(await accountRowExists(fixture.registrationAccountRowId)).toBe(true);
      });

      it("the real /v1 route POST /v1/auth/login-methods/google/unlink, bearer: 409 authentication.registration_login_method_locked", async () => {
        const fixture = await createFixture("v1-unlink-bearer");
        const path = "/v1/auth/login-methods/google/unlink";
        const p = await proofFor(fixture, fixture.keyA, "bearer", "POST", path);

        const observed = await send({ fixture, transport: "bearer", method: "POST", path, dpop: p.header });

        expect(observed).toMatchObject({ status: 409, code: "authentication.registration_login_method_locked" });
        expect(await accountRowExists(fixture.registrationAccountRowId)).toBe(true);
      });

      it("the real /v1 route, cookie: the same request is refused the same way", async () => {
        const fixture = await createFixture("v1-unlink-cookie");
        const path = "/v1/auth/login-methods/google/unlink";
        const p = await proofFor(fixture, fixture.keyA, "cookie", "POST", path);

        const observed = await send({ fixture, transport: "cookie", method: "POST", path, dpop: p.header });

        expect(observed).toMatchObject({ status: 409, code: "authentication.registration_login_method_locked" });
        expect(await accountRowExists(fixture.registrationAccountRowId)).toBe(true);
      });
    });
  },
);
