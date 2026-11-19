import { createHash, generateKeyPairSync } from "node:crypto";

import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AndroidAttestationInvalidError,
  PlayIntegrityDecodeError,
  verifyPlayIntegrityToken,
} from "../src/modules/auth/application/customer/android-attestation-verifier.js";
import { computeDeviceBinding } from "../src/modules/auth/domain/device-binding.js";
import { logAttestationRejection } from "../src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.js";
import {
  ACCESS_TOKEN_EXPIRY_MARGIN_MS,
  base64DigestToHex,
  GooglePlayIntegrityDecoder,
  PLAY_INTEGRITY_REQUEST_TIMEOUT_MS,
} from "../src/modules/auth/infrastructure/customer/google-play-integrity.decoder.js";

// Google's Play Integrity API returns certificateSha256Digest as base64,
// while verifyPlayIntegrityToken compares against ANDROID_ATTESTATION_CERT_DIGESTS
// (hex) -- the same allowlist key-attestation uses. Without this
// conversion the comparison can never match, so the digest allowlist
// silently rejects every real Play Integrity verdict whenever the policy
// isn't "disabled".
describe("base64DigestToHex", () => {
  it("converts a base64-encoded SHA-256 digest to lowercase hex", () => {
    const digestBytes = createHash("sha256").update("a-cert").digest();
    const base64 = digestBytes.toString("base64");

    const hex = base64DigestToHex(base64);

    expect(hex).toBe(digestBytes.toString("hex"));
    expect(hex).toHaveLength(64);
  });

  it("also accepts the base64url variant", () => {
    const digestBytes = createHash("sha256").update("another-cert").digest();
    const base64url = digestBytes.toString("base64url");

    const hex = base64DigestToHex(base64url);

    expect(hex).toBe(digestBytes.toString("hex"));
  });
});

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROJECT_NUMBER = "123456789";
const DECODE_URL = `https://playintegrity.googleapis.com/v1/${PROJECT_NUMBER}:decodeIntegrityToken`;

// Distinct, recognisable values: the logging tests prove none of them is
// ever written to a log line.
const INTEGRITY_TOKEN = "integrity-token-SECRET-1";
const ACCESS_TOKEN = "ya29.access-token-SECRET-2";
const CHALLENGE = "challenge-NONCE-3";
const RESPONSE_BODY_SECRET = "google-response-body-SECRET-4";
const BIO_JKT = "bio-jkt";

const { privateKey: SERVICE_ACCOUNT_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SERVICE_ACCOUNT_JSON_BASE64 = Buffer.from(
  JSON.stringify({
    client_email: "decoder@vistablox-test.iam.gserviceaccount.com",
    private_key: SERVICE_ACCOUNT_PRIVATE_KEY,
  }),
).toString("base64");
const PRIVATE_KEY_BODY_FRAGMENT = SERVICE_ACCOUNT_PRIVATE_KEY.split("\n")[1]!;

const CERT_DIGEST_BYTES = createHash("sha256").update("the-app-signing-cert").digest();
const CERT_DIGEST_HEX = CERT_DIGEST_BYTES.toString("hex");

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// `null` states no lifetime at all (passing undefined would pick the default).
function oauthOk(expiresIn: number | null = 3599): Handler {
  return () =>
    json(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", ...(expiresIn === null ? {} : { expires_in: expiresIn }) });
}

function verdictFor(requestHash: string | undefined): unknown {
  return {
    tokenPayloadExternal: {
      requestDetails: { requestHash },
      appIntegrity: {
        appRecognitionVerdict: "PLAY_RECOGNIZED",
        certificateSha256Digest: [CERT_DIGEST_BYTES.toString("base64")],
      },
      deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
    },
  };
}

function decodeOk(requestHash: string | undefined = computeDeviceBinding(CHALLENGE, BIO_JKT)): Handler {
  return () => json(200, verdictFor(requestHash));
}

// What a real fetch does with a signal: reject with the signal's reason once
// it aborts, and never settle otherwise.
function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal as AbortSignal;
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// Headers arrive, the body never finishes: a real fetch errors the body
// stream when the signal aborts.
function bodyHangsUntilAborted(_url: string, init: RequestInit): Response {
  const signal = init.signal as AbortSignal;
  const body = new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200 });
}

interface Stub {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
  oauthCalls: () => number;
  decodeCalls: () => number;
}

function stubGoogle(handlers: { oauth?: Handler; decode?: Handler } = {}): Stub {
  const calls: Stub["calls"] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const handler = url === TOKEN_URL ? (handlers.oauth ?? oauthOk()) : (handlers.decode ?? decodeOk());
    return handler(url, init ?? {});
  });
  return {
    fetch: fetchStub as unknown as typeof fetch,
    calls,
    oauthCalls: () => calls.filter((call) => call.url === TOKEN_URL).length,
    decodeCalls: () => calls.filter((call) => call.url === DECODE_URL).length,
  };
}

function decoderFor(stub: Stub, extra: { timeoutMs?: number; now?: () => number } = {}): GooglePlayIntegrityDecoder {
  return new GooglePlayIntegrityDecoder(SERVICE_ACCOUNT_JSON_BASE64, PROJECT_NUMBER, {
    fetch: stub.fetch,
    ...extra,
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GooglePlayIntegrityDecoder: success path", () => {
  it("exchanges a service-account assertion, calls decodeIntegrityToken with the bearer token and maps the verdict", async () => {
    const stub = stubGoogle();
    const decoder = decoderFor(stub);

    const verdict = await decoder.decode(INTEGRITY_TOKEN);

    expect(verdict).toEqual({
      requestHash: computeDeviceBinding(CHALLENGE, BIO_JKT),
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      deviceRecognitionVerdicts: ["MEETS_DEVICE_INTEGRITY"],
      certificateSha256Digests: [CERT_DIGEST_HEX],
    });

    expect(stub.calls.map((call) => call.url)).toEqual([TOKEN_URL, DECODE_URL]);
    const [oauthCall, decodeCall] = stub.calls;
    expect(oauthCall!.init.method).toBe("POST");
    const form = oauthCall!.init.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(decodeJwt(form.get("assertion")!)).toMatchObject({
      iss: "decoder@vistablox-test.iam.gserviceaccount.com",
      aud: TOKEN_URL,
      scope: "https://www.googleapis.com/auth/playintegrity",
    });
    expect(decodeCall!.init.method).toBe("POST");
    expect(decodeCall!.init.headers).toEqual({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(decodeCall!.init.body as string)).toEqual({ integrity_token: INTEGRITY_TOKEN });
  });

  it("keeps the defaults for a verdict payload that carries no fields", async () => {
    const decoder = decoderFor(stubGoogle({ decode: () => json(200, { tokenPayloadExternal: {} }) }));

    await expect(decoder.decode(INTEGRITY_TOKEN)).resolves.toEqual({
      requestHash: undefined,
      appRecognitionVerdict: "UNKNOWN",
      deviceRecognitionVerdicts: [],
      certificateSha256Digests: [],
    });
  });

  it("gives both Google calls a timeout signal that has not fired yet", async () => {
    const stub = stubGoogle();

    await decoderFor(stub).decode(INTEGRITY_TOKEN);

    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) {
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.signal!.aborted).toBe(false);
    }
  });

  it("has a default per-call budget in the low seconds", () => {
    expect(PLAY_INTEGRITY_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
    expect(PLAY_INTEGRITY_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("uses the global fetch, looked up per call, when none is injected", async () => {
    const stub = stubGoogle();
    vi.stubGlobal("fetch", stub.fetch);

    await new GooglePlayIntegrityDecoder(SERVICE_ACCOUNT_JSON_BASE64, PROJECT_NUMBER).decode(INTEGRITY_TOKEN);

    expect(stub.calls.map((call) => call.url)).toEqual([TOKEN_URL, DECODE_URL]);
  });
});

describe("GooglePlayIntegrityDecoder: bounded calls", () => {
  it("times out a decode call that never answers, classified as a timeout at the decode stage", async () => {
    const decoder = decoderFor(stubGoogle({ decode: hangUntilAborted }), { timeoutMs: 50 });
    const startedAt = performance.now();

    const error = await caught(decoder.decode(INTEGRITY_TOKEN));

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(PlayIntegrityDecodeError);
    expect(error).toMatchObject({ failureClass: "timeout", stage: "decode", status: undefined });
  });

  it("times out a token exchange that never answers, and never reaches the decode call", async () => {
    const stub = stubGoogle({ oauth: hangUntilAborted });
    const startedAt = performance.now();

    const error = await caught(decoderFor(stub, { timeoutMs: 50 }).decode(INTEGRITY_TOKEN));

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(error).toMatchObject({ failureClass: "timeout", stage: "oauth_token" });
    expect(stub.decodeCalls()).toBe(0);
  });

  it("times out when the headers arrive but the body never finishes", async () => {
    const decoder = decoderFor(stubGoogle({ decode: bodyHangsUntilAborted }), { timeoutMs: 50 });
    const startedAt = performance.now();

    const error = await caught(decoder.decode(INTEGRITY_TOKEN));

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(error).toMatchObject({ failureClass: "timeout", stage: "decode" });
  });

  it("classifies a failed request as a network error and keeps the underlying error as the cause", async () => {
    const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    const decoder = decoderFor(
      stubGoogle({
        decode: () => {
          throw refused;
        },
      }),
    );

    const error = await caught(decoder.decode(INTEGRITY_TOKEN));

    expect(error).toBeInstanceOf(PlayIntegrityDecodeError);
    expect(error).toMatchObject({ failureClass: "network", stage: "decode", status: undefined });
    expect((error as Error).cause).toBe(refused);
  });

  it("classifies a connection cut during the body as a network error, not a timeout", async () => {
    const decoder = decoderFor(
      stubGoogle({
        decode: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("terminated"));
              },
            }),
            { status: 200 },
          ),
      }),
    );

    await expect(decoder.decode(INTEGRITY_TOKEN)).rejects.toMatchObject({
      failureClass: "network",
      stage: "decode",
    });
  });
});

describe("GooglePlayIntegrityDecoder: Google answers with an error", () => {
  it("classifies a 500 from the decode call as an http_status failure and keeps Google's body out of the error", async () => {
    const decoder = decoderFor(stubGoogle({ decode: () => new Response(RESPONSE_BODY_SECRET, { status: 500 }) }));

    const error = await caught(decoder.decode(INTEGRITY_TOKEN));

    expect(error).toBeInstanceOf(PlayIntegrityDecodeError);
    expect(error).toMatchObject({ failureClass: "http_status", stage: "decode", status: 500 });
    expect((error as Error).message).not.toContain(RESPONSE_BODY_SECRET);
    expect((error as Error).message).toContain("500");
  });

  it("classifies a 401 from the decode call as an http_status failure", async () => {
    const decoder = decoderFor(stubGoogle({ decode: () => json(401, { error: { status: "UNAUTHENTICATED" } }) }));

    await expect(decoder.decode(INTEGRITY_TOKEN)).rejects.toMatchObject({
      failureClass: "http_status",
      stage: "decode",
      status: 401,
    });
  });

  it("classifies a 400 from the decode call as an invalid integrity token", async () => {
    const decoder = decoderFor(stubGoogle({ decode: () => json(400, { error: { status: "INVALID_ARGUMENT" } }) }));

    await expect(decoder.decode(INTEGRITY_TOKEN)).rejects.toMatchObject({
      failureClass: "token_invalid",
      stage: "decode",
      status: 400,
    });
  });

  it("classifies a refused token exchange as an http_status failure at the oauth_token stage, 400 included", async () => {
    for (const status of [400, 401, 500]) {
      const decoder = decoderFor(stubGoogle({ oauth: () => json(status, { error: "invalid_grant" }) }));

      await expect(decoder.decode(INTEGRITY_TOKEN)).rejects.toMatchObject({
        failureClass: "http_status",
        stage: "oauth_token",
        status,
      });
    }
  });

  it("classifies a 2xx answer that is not JSON as a malformed response", async () => {
    const decoder = decoderFor(stubGoogle({ decode: () => new Response("<html>sorry</html>", { status: 200 }) }));

    const error = await caught(decoder.decode(INTEGRITY_TOKEN));

    expect(error).toMatchObject({ failureClass: "malformed_response", stage: "decode" });
  });

  it("classifies a decode answer without a verdict payload as a malformed response", async () => {
    for (const body of [{}, [], "text", null, { tokenPayloadExternal: "nope" }]) {
      const decoder = decoderFor(stubGoogle({ decode: () => json(200, body) }));

      await expect(decoder.decode(INTEGRITY_TOKEN)).rejects.toMatchObject({
        failureClass: "malformed_response",
        stage: "decode",
      });
    }
  });

  it("classifies a decode answer whose digest list is not a list as a malformed response", async () => {
    const decoder = decoderFor(
      stubGoogle({
        decode: () =>
          json(200, { tokenPayloadExternal: { appIntegrity: { certificateSha256Digest: "not-a-list" } } }),
      }),
    );

    await expect(decoder.decode(INTEGRITY_TOKEN)).rejects.toMatchObject({
      failureClass: "malformed_response",
      stage: "decode",
    });
  });

  it("classifies a token exchange without an access token as a malformed response and never calls decode", async () => {
    const stub = stubGoogle({ oauth: () => json(200, { token_type: "Bearer" }) });

    await expect(decoderFor(stub).decode(INTEGRITY_TOKEN)).rejects.toMatchObject({
      failureClass: "malformed_response",
      stage: "oauth_token",
    });
    expect(stub.decodeCalls()).toBe(0);
  });
});

describe("GooglePlayIntegrityDecoder: access-token cache", () => {
  it("exchanges the access token once for consecutive decodes", async () => {
    const stub = stubGoogle();
    const decoder = decoderFor(stub);

    await decoder.decode("token-1");
    await decoder.decode("token-2");
    await decoder.decode("token-3");

    expect(stub.oauthCalls()).toBe(1);
    expect(stub.decodeCalls()).toBe(3);
  });

  it("exchanges again once the stated lifetime, less the safety margin, has passed", async () => {
    let clock = 10_000_000;
    const stub = stubGoogle({ oauth: oauthOk(3600) });
    const decoder = decoderFor(stub, { now: () => clock });
    const usableUntil = clock + 3600 * 1000 - ACCESS_TOKEN_EXPIRY_MARGIN_MS;

    await decoder.decode("token-1");
    clock = usableUntil - 1;
    await decoder.decode("token-2");
    expect(stub.oauthCalls()).toBe(1);

    clock = usableUntil;
    await decoder.decode("token-3");
    expect(stub.oauthCalls()).toBe(2);
  });

  it("does not cache a token whose stated lifetime does not outlast the margin", async () => {
    const stub = stubGoogle({ oauth: oauthOk(30) });
    const decoder = decoderFor(stub);

    await decoder.decode("token-1");
    await decoder.decode("token-2");

    expect(stub.oauthCalls()).toBe(2);
  });

  it("does not cache a token when the response states no lifetime", async () => {
    const stub = stubGoogle({ oauth: oauthOk(null) });
    const decoder = decoderFor(stub);

    await decoder.decode("token-1");
    await decoder.decode("token-2");

    expect(stub.oauthCalls()).toBe(2);
  });

  it("shares one exchange between decodes that start while it is in flight", async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const stub = stubGoogle({ oauth: () => pending });
    const decoder = decoderFor(stub);

    const all = Promise.all([decoder.decode("token-1"), decoder.decode("token-2"), decoder.decode("token-3")]);
    await vi.waitFor(() => expect(stub.oauthCalls()).toBe(1));
    answer(json(200, { access_token: ACCESS_TOKEN, expires_in: 3599 }));
    await all;

    expect(stub.oauthCalls()).toBe(1);
    expect(stub.decodeCalls()).toBe(3);
  });

  it("does not cache a failed exchange: the next decode tries again", async () => {
    let failNext = true;
    const stub = stubGoogle({
      oauth: () => {
        if (failNext) {
          failNext = false;
          return json(500, {});
        }
        return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599 });
      },
    });
    const decoder = decoderFor(stub);

    await expect(decoder.decode("token-1")).rejects.toMatchObject({ failureClass: "http_status", stage: "oauth_token" });
    await expect(decoder.decode("token-2")).resolves.toBeDefined();

    expect(stub.oauthCalls()).toBe(2);
  });

  it("does not cache an exchange that timed out: the next decode tries again", async () => {
    let hang = true;
    const stub = stubGoogle({
      oauth: (url, init) => {
        if (hang) {
          hang = false;
          return hangUntilAborted(url, init);
        }
        return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599 });
      },
    });
    const decoder = decoderFor(stub, { timeoutMs: 50 });

    await expect(decoder.decode("token-1")).rejects.toMatchObject({ failureClass: "timeout", stage: "oauth_token" });
    await expect(decoder.decode("token-2")).resolves.toBeDefined();
  });

  it("drops the cached token when Google answers 401 to the decode call, so the next decode exchanges a new one", async () => {
    let decodeStatus = 401;
    const stub = stubGoogle({
      decode: () => (decodeStatus === 401 ? json(401, {}) : json(200, verdictFor("hash"))),
    });
    const decoder = decoderFor(stub);

    await expect(decoder.decode("token-1")).rejects.toMatchObject({ failureClass: "http_status", status: 401 });
    decodeStatus = 200;
    await decoder.decode("token-2");

    expect(stub.oauthCalls()).toBe(2);
  });

  it("keeps the cached token through a Google 500 on the decode call", async () => {
    let decodeStatus = 500;
    const stub = stubGoogle({
      decode: () => (decodeStatus === 500 ? json(500, {}) : json(200, verdictFor("hash"))),
    });
    const decoder = decoderFor(stub);

    await expect(decoder.decode("token-1")).rejects.toMatchObject({ failureClass: "http_status", status: 500 });
    decodeStatus = 200;
    await decoder.decode("token-2");

    expect(stub.oauthCalls()).toBe(1);
  });
});

// The decoder behind the real verifier: what enrolment actually runs.
describe("verifyPlayIntegrityToken with the Google decoder", () => {
  function verify(decoder: GooglePlayIntegrityDecoder): Promise<void> {
    return verifyPlayIntegrityToken({
      policy: "strict",
      token: INTEGRITY_TOKEN,
      challenge: CHALLENGE,
      bioJkt: BIO_JKT,
      certDigestAllowlist: [CERT_DIGEST_HEX],
      decoder,
    });
  }

  it("accepts a good verdict (the success path is unchanged)", async () => {
    await expect(verify(decoderFor(stubGoogle()))).resolves.toBeUndefined();
  });

  it("fails within the budget when Google never answers the decode call, as ATTESTATION_INVALID with the timeout as its cause", async () => {
    const decoder = decoderFor(stubGoogle({ decode: hangUntilAborted }), { timeoutMs: 50 });
    const startedAt = performance.now();

    const error = await caught(verify(decoder));

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(AndroidAttestationInvalidError);
    expect((error as AndroidAttestationInvalidError).code).toBe("ATTESTATION_INVALID");
    expect((error as Error).cause).toBeInstanceOf(PlayIntegrityDecodeError);
    expect((error as Error).cause).toMatchObject({ failureClass: "timeout", stage: "decode" });
  });

  it("fails within the budget when Google never answers the token exchange", async () => {
    const decoder = decoderFor(stubGoogle({ oauth: hangUntilAborted }), { timeoutMs: 50 });
    const startedAt = performance.now();

    const error = await caught(verify(decoder));

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(AndroidAttestationInvalidError);
    expect((error as Error).cause).toMatchObject({ failureClass: "timeout", stage: "oauth_token" });
  });

  it("keeps answering with the same error and message whatever the failure class", async () => {
    const decoders = [
      decoderFor(stubGoogle({ decode: () => json(500, {}) })),
      decoderFor(stubGoogle({ decode: () => json(401, {}) })),
      decoderFor(stubGoogle({ decode: () => json(400, {}) })),
      decoderFor(stubGoogle({ decode: () => new Response("nope", { status: 200 }) })),
    ];

    for (const decoder of decoders) {
      const error = await caught(verify(decoder));
      expect(error).toBeInstanceOf(AndroidAttestationInvalidError);
      expect((error as Error).message).toBe(
        "Android key attestation rejected: Play Integrity token could not be decoded",
      );
    }
  });
});

describe("the logged line for a Play Integrity decode failure", () => {
  const scenarios: Array<{
    name: string;
    handlers: { oauth?: Handler; decode?: Handler };
    timeoutMs?: number;
    expected: { failureClass: string; stage: string; status?: number };
  }> = [
    {
      name: "a timeout",
      handlers: { decode: hangUntilAborted },
      timeoutMs: 50,
      expected: { failureClass: "timeout", stage: "decode" },
    },
    {
      name: "a network error whose own message repeats the integrity token",
      handlers: {
        decode: () => {
          throw new TypeError(`fetch failed for ${INTEGRITY_TOKEN} with ${ACCESS_TOKEN}`);
        },
      },
      expected: { failureClass: "network", stage: "decode" },
    },
    {
      name: "a Google 500 whose body carries a secret",
      handlers: { decode: () => new Response(RESPONSE_BODY_SECRET, { status: 500 }) },
      expected: { failureClass: "http_status", stage: "decode", status: 500 },
    },
    {
      name: "a Google 401",
      handlers: { decode: () => new Response(`${RESPONSE_BODY_SECRET} ${ACCESS_TOKEN}`, { status: 401 }) },
      expected: { failureClass: "http_status", stage: "decode", status: 401 },
    },
    {
      name: "a refused token exchange",
      handlers: { oauth: () => new Response(`${RESPONSE_BODY_SECRET} ${PRIVATE_KEY_BODY_FRAGMENT}`, { status: 400 }) },
      expected: { failureClass: "http_status", stage: "oauth_token", status: 400 },
    },
    {
      name: "a malformed answer that repeats a secret",
      handlers: { decode: () => new Response(`not json ${RESPONSE_BODY_SECRET} ${INTEGRITY_TOKEN}`, { status: 200 }) },
      expected: { failureClass: "malformed_response", stage: "decode" },
    },
    {
      name: "an integrity token Google refuses",
      handlers: { decode: () => new Response(`${RESPONSE_BODY_SECRET}`, { status: 400 }) },
      expected: { failureClass: "token_invalid", stage: "decode", status: 400 },
    },
  ];

  it.each(scenarios)("names the failure class for $name and carries no token, nonce, key or response body", async (scenario) => {
    const decoder = decoderFor(stubGoogle(scenario.handlers), scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs });
    const error = await caught(
      verifyPlayIntegrityToken({
        policy: "strict",
        token: INTEGRITY_TOKEN,
        challenge: CHALLENGE,
        bioJkt: BIO_JKT,
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder,
      }),
    );
    const warn = vi.fn();

    logAttestationRejection({ context: { logger: { warn } }, path: "/device/enrol/verify" }, error);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, data] = warn.mock.calls[0]!;
    expect(message).toBe("device-auth attestation rejected");
    expect(data).toMatchObject({
      code: "ATTESTATION_INVALID",
      path: "/device/enrol/verify",
      playIntegrity: scenario.expected,
    });
    const everythingLogged = JSON.stringify(warn.mock.calls);
    for (const secret of [
      INTEGRITY_TOKEN,
      ACCESS_TOKEN,
      CHALLENGE,
      RESPONSE_BODY_SECRET,
      PRIVATE_KEY_BODY_FRAGMENT,
      "Bearer",
      "assertion",
    ]) {
      expect(everythingLogged).not.toContain(secret);
    }
  });
});
