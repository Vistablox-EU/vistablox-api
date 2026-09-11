import { webcrypto } from "node:crypto";

import "reflect-metadata";
import * as asn1js from "asn1js";
import {
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
  cryptoProvider,
} from "@peculiar/x509";
import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import {
  AndroidAttestationInvalidError,
  type AndroidAttestationRevocationList,
  type PlayIntegrityVerdictDecoder,
} from "../src/modules/auth/application/android-attestation-verifier.js";
import {
  DeviceAlreadyEnrolledError,
  DeviceChallengeExpiredError,
  DeviceChallengeReplayedError,
  MobilePlatformUnsupportedError,
} from "../src/modules/auth/application/device-auth-errors.js";
import { DeviceChallengePurposeMismatchError } from "../src/modules/auth/application/device-auth-jws-verifier.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import type { Device, DeviceRepository } from "../src/modules/auth/repository/device.repository.js";
import type { DeviceChallengeRepository } from "../src/modules/auth/repository/device-challenge.repository.js";

cryptoProvider.set(webcrypto);

const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
const CERT_DIGEST_HEX = "aa".repeat(32);
const JWS_TYP = "vistablox-device-auth+jwt";

class FakeDeviceRepository implements DeviceRepository {
  public devices: Device[] = [];
  public createCallCount = 0;

  public async create(input: {
    accountId: string;
    betterAuthUserId: string;
    dpopJkt: string;
    bioJkt: string;
    biometricPublicJwk: Record<string, unknown>;
    platform: string;
    model: string | undefined;
    osVersion: string | undefined;
    appVersion: string | undefined;
    attestationMetadata: Record<string, unknown>;
  }): Promise<Device> {
    this.createCallCount++;
    const device: Device = {
      deviceId: `device_${this.devices.length + 1}`,
      accountId: input.accountId,
      betterAuthUserId: input.betterAuthUserId,
      dpopJkt: input.dpopJkt,
      bioJkt: input.bioJkt,
      biometricPublicJwk: input.biometricPublicJwk,
      platform: input.platform,
      status: "active",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    };
    this.devices.push(device);
    return device;
  }

  public async findByDeviceId(deviceId: string): Promise<Device | null> {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null;
  }

  public async findByDpopJkt(dpopJkt: string): Promise<Device | null> {
    return this.devices.find((d) => d.dpopJkt === dpopJkt) ?? null;
  }

  public async findActiveDeviceForAccount(accountId: string): Promise<Device | null> {
    return this.devices.find((d) => d.accountId === accountId && d.status === "active") ?? null;
  }

  public async touchLastSeen(deviceId: string, at: Date): Promise<void> {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (device !== undefined) device.lastSeenAt = at;
  }

  public async delete(deviceId: string): Promise<void> {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
  }
}

interface FakeChallengeEntry {
  purpose: string;
  dpopJkt: string;
  deviceId: string | undefined;
  expiresAt: Date;
  consumed: boolean;
  consumedAt?: Date;
}

class FakeChallengeRepository implements DeviceChallengeRepository {
  public issued = new Map<string, FakeChallengeEntry>();
  public consumeCallCount = 0;

  public async issue(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    expiresAt: Date;
  }): Promise<void> {
    this.issued.set(input.challenge, {
      purpose: input.purpose,
      dpopJkt: input.dpopJkt,
      deviceId: input.deviceId,
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }

  public async consume(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    now: Date;
  }): Promise<boolean> {
    this.consumeCallCount++;
    const entry = this.issued.get(input.challenge);
    if (
      entry === undefined ||
      entry.purpose !== input.purpose ||
      entry.dpopJkt !== input.dpopJkt ||
      entry.deviceId !== input.deviceId ||
      entry.consumed ||
      entry.expiresAt <= input.now
    ) {
      return false;
    }
    entry.consumed = true;
    entry.consumedAt = input.now;
    return true;
  }

  public async wasConsumedSince(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    since: Date;
  }): Promise<boolean> {
    const entry = this.issued.get(input.challenge);
    return (
      entry !== undefined &&
      entry.purpose === input.purpose &&
      entry.dpopJkt === input.dpopJkt &&
      entry.deviceId === input.deviceId &&
      entry.consumedAt !== undefined &&
      entry.consumedAt.getTime() >= input.since.getTime()
    );
  }

  public async pruneExpired(): Promise<number> {
    return 0;
  }
}

const notRevoked: AndroidAttestationRevocationList = { isRevoked: async () => false };

function taggedNode(tagNumber: number, inner: object) {
  return new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [inner as never] });
}

function buildAttestationApplicationId(certDigestHex: string): ArrayBuffer {
  const packageInfo = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: Buffer.from("com.vistablox.app", "utf8") }),
      new asn1js.Integer({ value: 1 }),
    ],
  });
  const packageInfos = new asn1js.Set({ value: [packageInfo] });
  const signatureDigests = new asn1js.Set({
    value: [new asn1js.OctetString({ valueHex: Buffer.from(certDigestHex, "hex") })],
  });
  return new asn1js.Sequence({ value: [packageInfos, signatureDigests] }).toBER(false);
}

function buildRootOfTrust(): asn1js.Sequence {
  return new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: new ArrayBuffer(32) }),
      new asn1js.Boolean({ value: true }), // deviceLocked
      new asn1js.Enumerated({ value: 0 }), // verifiedBootState: Verified
      new asn1js.OctetString({ valueHex: new ArrayBuffer(32) }),
    ],
  });
}

/** A fully well-formed KeyDescription -- every check this PR's security review added. */
function buildKeyDescription(challenge: string): ArrayBuffer {
  const teeEnforced = new asn1js.Sequence({
    value: [
      taggedNode(1, new asn1js.Set({ value: [new asn1js.Integer({ value: 2 })] })), // purpose: SIGN
      taggedNode(2, new asn1js.Integer({ value: 3 })), // algorithm: EC
      taggedNode(5, new asn1js.Set({ value: [new asn1js.Integer({ value: 4 })] })), // digest: SHA-256
      taggedNode(10, new asn1js.Integer({ value: 1 })), // ecCurve: P-256
      taggedNode(504, new asn1js.Integer({ value: 0b10 })), // userAuthType: fingerprint only
      taggedNode(509, new asn1js.Boolean({ value: true })), // unlockedDeviceRequired
      taggedNode(702, new asn1js.Integer({ value: 0 })), // origin: GENERATED
      taggedNode(704, buildRootOfTrust()),
      taggedNode(
        709,
        new asn1js.OctetString({ valueHex: buildAttestationApplicationId(CERT_DIGEST_HEX) }),
      ),
    ],
  });
  const softwareEnforced = new asn1js.Sequence({ value: [] });
  return new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 300 }),
      new asn1js.Enumerated({ value: 1 }),
      new asn1js.Integer({ value: 300 }),
      new asn1js.Enumerated({ value: 1 }),
      new asn1js.OctetString({ valueHex: Buffer.from(challenge, "ascii") }),
      new asn1js.OctetString({ valueHex: new ArrayBuffer(0) }),
      softwareEnforced,
      teeEnforced,
    ],
  }).toBER(false);
}

/**
 * One valid Android key-attestation chain, bound to `challenge` and to
 * `leafPublicKey` -- the same key the enrolment JWS embeds, since the
 * verifier now requires the attested key to match the JWS's own bio_jkt.
 */
async function buildAndroidAttestationChain(
  challenge: string,
  leafPublicKey: webcrypto.CryptoKey,
): Promise<{ rootBase64: string; leafBase64: string }> {
  const rootKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rootCert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test Root",
    notBefore: new Date("2020-01-01"),
    notAfter: new Date("2035-01-01"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: rootKeys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true),
    ],
  });

  const leafCert = await X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test Leaf",
    issuer: rootCert.subject,
    notBefore: new Date("2020-01-01"),
    notAfter: new Date("2035-01-01"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: leafPublicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new Extension(KEY_DESCRIPTION_OID, false, buildKeyDescription(challenge))],
  });

  return {
    rootBase64: Buffer.from(rootCert.rawData).toString("base64"),
    leafBase64: Buffer.from(leafCert.rawData).toString("base64"),
  };
}

async function buildEnrolJws(options: {
  challenge: string;
  purpose?: string;
  iat?: number;
  dpopJkt?: string;
  publicKey?: webcrypto.CryptoKey;
  privateKey?: webcrypto.CryptoKey;
}): Promise<{ jws: string; bioJkt: string; publicJwk: JWK; publicKey: webcrypto.CryptoKey }> {
  let privateKey: webcrypto.CryptoKey;
  let publicKey: webcrypto.CryptoKey;
  if (options.privateKey !== undefined && options.publicKey !== undefined) {
    privateKey = options.privateKey;
    publicKey = options.publicKey;
  } else {
    const generated = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    privateKey = generated.privateKey;
    publicKey = generated.publicKey;
  }
  const publicJwk = await exportJWK(publicKey);
  const bioJkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const purpose = options.purpose ?? "enrol-device";
  const payload: Record<string, unknown> = {
    purpose,
    challenge: options.challenge,
    iat: options.iat ?? Math.floor(Date.now() / 1000),
  };
  if (purpose === "enrol-device") {
    payload.dpop_jkt = options.dpopJkt ?? "dpop-jkt-1";
  }
  const jws = await new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: JWS_TYP, kid: bioJkt, jwk: publicJwk as Record<string, unknown> })
    .sign(privateKey);
  return { jws, bioJkt, publicJwk, publicKey };
}

function androidConfig(
  overrides: Partial<{
    policy: "disabled" | "relaxed" | "strict";
    playIntegrityDecoder: PlayIntegrityVerdictDecoder | undefined;
    pinnedRootCertificates: string[];
    certDigestAllowlist: string[];
  }> = {},
) {
  return {
    policy: overrides.policy ?? "disabled",
    pinnedRootCertificates: overrides.pinnedRootCertificates ?? [],
    certDigestAllowlist: overrides.certDigestAllowlist ?? [CERT_DIGEST_HEX],
    revocationList: notRevoked,
    playIntegrityDecoder: overrides.playIntegrityDecoder,
  };
}

describe("EnrolDeviceService", () => {
  it("enrols a device end-to-end: consumes the challenge, verifies the JWS and attestation, creates the device row", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    const challenge = "enrol-challenge-1";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "dpop-jkt-1",
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { jws, bioJkt, publicKey } = await buildEnrolJws({ challenge, dpopJkt: "dpop-jkt-1" });
    const chain = await buildAndroidAttestationChain(challenge, publicKey);

    const service = new EnrolDeviceService(
      challenges,
      devices,
      androidConfig({ pinnedRootCertificates: [chain.rootBase64] }),
    );

    const device = await service.execute({
      accountId: "account-1",
      betterAuthUserId: "user-1",
      dpopJkt: "dpop-jkt-1",
      challenge,
      jws,
      attestation: {
        platform: "android",
        keyAttestationChain: [chain.leafBase64, chain.rootBase64],
        integrityToken: undefined,
        model: "Pixel 8",
        osVersion: "15",
        appVersion: "1.0.0",
      },
    });

    expect(device.bioJkt).toBe(bioJkt);
    expect(device.accountId).toBe("account-1");
    expect(device.dpopJkt).toBe("dpop-jkt-1");
    expect(devices.createCallCount).toBe(1);
    expect(challenges.consumeCallCount).toBe(1);
  });

  it("rejects enrolment when the account already has an active device, without consuming the challenge", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    devices.devices.push({
      deviceId: "device_existing",
      accountId: "account-1",
      betterAuthUserId: "user-1",
      dpopJkt: "existing-jkt",
      bioJkt: "existing-bio-jkt",
      biometricPublicJwk: {},
      platform: "android",
      status: "active",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    const challenge = "enrol-challenge-2";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "dpop-jkt-2",
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const service = new EnrolDeviceService(challenges, devices, androidConfig());

    await expect(
      service.execute({
        accountId: "account-1",
        betterAuthUserId: "user-1",
        dpopJkt: "dpop-jkt-2",
        challenge,
        jws: "irrelevant",
        attestation: {
          platform: "android",
          keyAttestationChain: [],
          integrityToken: undefined,
          model: undefined,
          osVersion: undefined,
          appVersion: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(DeviceAlreadyEnrolledError);
    expect(challenges.consumeCallCount).toBe(0);
  });

  it("rejects an expired/unknown/already-consumed challenge", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    const service = new EnrolDeviceService(challenges, devices, androidConfig());

    await expect(
      service.execute({
        accountId: "account-1",
        betterAuthUserId: "user-1",
        dpopJkt: "dpop-jkt-3",
        challenge: "never-issued",
        jws: "irrelevant",
        attestation: {
          platform: "android",
          keyAttestationChain: [],
          integrityToken: undefined,
          model: undefined,
          osVersion: undefined,
          appVersion: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(DeviceChallengeExpiredError);
  });

  it("rejects a JWS whose purpose doesn't match (challenge is still consumed)", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    const challenge = "enrol-challenge-4";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "dpop-jkt-4",
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { jws } = await buildEnrolJws({ challenge, purpose: "login" });
    const service = new EnrolDeviceService(challenges, devices, androidConfig());

    await expect(
      service.execute({
        accountId: "account-1",
        betterAuthUserId: "user-1",
        dpopJkt: "dpop-jkt-4",
        challenge,
        jws,
        attestation: {
          platform: "android",
          keyAttestationChain: [],
          integrityToken: undefined,
          model: undefined,
          osVersion: undefined,
          appVersion: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(DeviceChallengePurposeMismatchError);
    expect(challenges.consumeCallCount).toBe(1);
  });

  it("rejects when this DPoP key is already enrolled as a device", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    devices.devices.push({
      deviceId: "device_existing",
      accountId: "account-other",
      betterAuthUserId: "user-other",
      dpopJkt: "reused-dpop-jkt",
      bioJkt: "bio",
      biometricPublicJwk: {},
      platform: "android",
      status: "revoked",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    const challenge = "enrol-challenge-5";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "reused-dpop-jkt",
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { jws } = await buildEnrolJws({ challenge, dpopJkt: "reused-dpop-jkt" });
    const service = new EnrolDeviceService(challenges, devices, androidConfig());

    await expect(
      service.execute({
        accountId: "account-1",
        betterAuthUserId: "user-1",
        dpopJkt: "reused-dpop-jkt",
        challenge,
        jws,
        attestation: {
          platform: "android",
          keyAttestationChain: [],
          integrityToken: undefined,
          model: undefined,
          osVersion: undefined,
          appVersion: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(DeviceAlreadyEnrolledError);
  });

  it("rejects an unsupported platform", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    const challenge = "enrol-challenge-6";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "dpop-jkt-6",
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { jws } = await buildEnrolJws({ challenge, dpopJkt: "dpop-jkt-6" });
    const service = new EnrolDeviceService(challenges, devices, androidConfig());

    await expect(
      service.execute({
        accountId: "account-1",
        betterAuthUserId: "user-1",
        dpopJkt: "dpop-jkt-6",
        challenge,
        jws,
        attestation: {
          platform: "ios",
          keyAttestationChain: [],
          integrityToken: undefined,
          model: undefined,
          osVersion: undefined,
          appVersion: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(MobilePlatformUnsupportedError);
  });

  it("rejects when Play Integrity policy requires a decoder but none is configured", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    const challenge = "enrol-challenge-7";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "dpop-jkt-7",
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { jws, publicKey } = await buildEnrolJws({ challenge, dpopJkt: "dpop-jkt-7" });
    const chain = await buildAndroidAttestationChain(challenge, publicKey);

    const service = new EnrolDeviceService(
      challenges,
      devices,
      androidConfig({ policy: "relaxed", pinnedRootCertificates: [chain.rootBase64] }),
    );

    await expect(
      service.execute({
        accountId: "account-1",
        betterAuthUserId: "user-1",
        dpopJkt: "dpop-jkt-7",
        challenge,
        jws,
        attestation: {
          platform: "android",
          keyAttestationChain: [chain.leafBase64, chain.rootBase64],
          integrityToken: "some-token",
          model: undefined,
          osVersion: undefined,
          appVersion: undefined,
        },
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });
});

// Compensation for a failed enrolment: execute() (Prisma) and the
// internalAdapter session-creation call the caller makes right after it
// succeeds (better-auth's own pg Pool) use different DB clients, so
// there's no single transaction spanning both. If session creation fails
// after the device row already exists, the caller (better-auth-device-auth
// .plugin.ts's enrolVerify) must call rollback() before rethrowing, or the
// device is left behind, active, blocking every retry via the
// one-active-device-per-account constraint -- confirmed live on staging: a
// real enrolment crashed exactly this way before rollback() existed.
describe("EnrolDeviceService.rollback", () => {
  it("deletes the device row via the repository", async () => {
    const devices = new FakeDeviceRepository();
    devices.devices.push({
      deviceId: "device_orphaned",
      accountId: "account-1",
      betterAuthUserId: "user-1",
      dpopJkt: "dpop-jkt-1",
      bioJkt: "bio-jkt-1",
      biometricPublicJwk: {},
      platform: "android",
      status: "active",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    const service = new EnrolDeviceService(new FakeChallengeRepository(), devices, androidConfig());

    await service.rollback("device_orphaned");

    expect(devices.devices.find((d) => d.deviceId === "device_orphaned")).toBeUndefined();
  });
});

// DEVICE_CHALLENGE_REPLAYED vs DEVICE_CHALLENGE_EXPIRED on E2. The
// invariant (domain/device-challenge-replay.ts): EXPIRED only when no
// enrolment that consumed the challenge can still register a device.
describe("EnrolDeviceService: replayed vs expired challenges", () => {
  function enrolInput(challenge: string, dpopJkt: string, jws: string, chain: string[]) {
    return {
      accountId: "account-replay",
      betterAuthUserId: "user-1",
      dpopJkt,
      challenge,
      jws,
      attestation: {
        platform: "android",
        keyAttestationChain: chain,
        integrityToken: undefined,
        model: undefined,
        osVersion: undefined,
        appVersion: undefined,
      },
    };
  }

  it("answers REPLAYED to a replay while the first enrolment is still running, and the first still registers", async () => {
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    const challenge = "replay-in-flight";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "dpop-replay-1",
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const { jws, publicKey } = await buildEnrolJws({ challenge, dpopJkt: "dpop-replay-1" });
    const chain = await buildAndroidAttestationChain(challenge, publicKey);
    let reachAttestation!: () => void;
    const attestationReached = new Promise<void>((resolve) => {
      reachAttestation = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first enrolment pauses inside attestation (after consuming the
    // challenge, before inserting its device row).
    const pausingRevocationList: AndroidAttestationRevocationList = {
      isRevoked: async () => {
        reachAttestation();
        await released;
        return false;
      },
    };
    const service = new EnrolDeviceService(challenges, devices, {
      ...androidConfig({ pinnedRootCertificates: [chain.rootBase64] }),
      revocationList: pausingRevocationList,
    });
    const input = enrolInput(challenge, "dpop-replay-1", jws, [chain.leafBase64, chain.rootBase64]);

    const first = service.execute(input);
    await attestationReached;
    await expect(service.execute(input)).rejects.toBeInstanceOf(DeviceChallengeReplayedError);

    release();
    await expect(first).resolves.toMatchObject({ accountId: "account-replay" });
    expect(devices.createCallCount).toBe(1);
  });

  it("converges: a challenge whose enrolment registered nothing answers REPLAYED for 120 s, then EXPIRED", async () => {
    const t0 = Date.now();
    let now = t0;
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    await challenges.issue({
      challenge: "replay-converges",
      purpose: "enrol-device",
      dpopJkt: "dpop-replay-2",
      deviceId: undefined,
      expiresAt: new Date(t0 + 300_000),
    });
    // The first enrolment consumed the challenge at t0 and then failed.
    await challenges.consume({
      challenge: "replay-converges",
      purpose: "enrol-device",
      dpopJkt: "dpop-replay-2",
      deviceId: undefined,
      now: new Date(t0),
    });
    const service = new EnrolDeviceService(challenges, devices, androidConfig(), () => new Date(now));
    const replay = enrolInput("replay-converges", "dpop-replay-2", "not-reached", []);

    now = t0 + 120_000;
    await expect(service.execute(replay)).rejects.toBeInstanceOf(DeviceChallengeReplayedError);

    now = t0 + 120_001;
    await expect(service.execute(replay)).rejects.toBeInstanceOf(DeviceChallengeExpiredError);
    expect(devices.createCallCount).toBe(0);
  });

  it("after the window, a replay of a challenge whose enrolment did register answers 409, never EXPIRED", async () => {
    const t0 = Date.now();
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    await challenges.issue({
      challenge: "replay-registered",
      purpose: "enrol-device",
      dpopJkt: "dpop-replay-3",
      deviceId: undefined,
      expiresAt: new Date(t0 + 300_000),
    });
    await challenges.consume({
      challenge: "replay-registered",
      purpose: "enrol-device",
      dpopJkt: "dpop-replay-3",
      deviceId: undefined,
      now: new Date(t0),
    });
    await devices.create({
      accountId: "account-replay",
      betterAuthUserId: "user-1",
      dpopJkt: "dpop-replay-3",
      bioJkt: "bio",
      biometricPublicJwk: {},
      platform: "android",
      model: undefined,
      osVersion: undefined,
      appVersion: undefined,
      attestationMetadata: {},
    });
    const service = new EnrolDeviceService(challenges, devices, androidConfig(), () => new Date(t0 + 600_000));

    await expect(
      service.execute(enrolInput("replay-registered", "dpop-replay-3", "not-reached", [])),
    ).rejects.toBeInstanceOf(DeviceAlreadyEnrolledError);
  });

  it("registers nothing when it reaches its device insert 60 s or more after consuming its challenge", async () => {
    let now = Date.now();
    const challenges = new FakeChallengeRepository();
    const devices = new FakeDeviceRepository();
    const challenge = "replay-deadline";
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt: "dpop-replay-4",
      deviceId: undefined,
      expiresAt: new Date(now + 300_000),
    });
    const { jws, publicKey } = await buildEnrolJws({ challenge, dpopJkt: "dpop-replay-4" });
    const chain = await buildAndroidAttestationChain(challenge, publicKey);
    let advanced = false;
    // Attestation takes 60 s (the revocation list is slow).
    const slowRevocationList: AndroidAttestationRevocationList = {
      isRevoked: async () => {
        if (!advanced) {
          advanced = true;
          now += 60_000;
        }
        return false;
      },
    };
    const service = new EnrolDeviceService(
      challenges,
      devices,
      { ...androidConfig({ pinnedRootCertificates: [chain.rootBase64] }), revocationList: slowRevocationList },
      () => new Date(now),
    );

    await expect(
      service.execute(enrolInput(challenge, "dpop-replay-4", jws, [chain.leafBase64, chain.rootBase64])),
    ).rejects.toBeInstanceOf(DeviceChallengeExpiredError);
    expect(devices.createCallCount).toBe(0);
  });
});
