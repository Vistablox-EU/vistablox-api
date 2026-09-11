import { webcrypto } from "node:crypto";

import "reflect-metadata";
import * as asn1js from "asn1js";
import { Extension, X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";
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
  DevicePairingNotImplementedError,
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
}

interface FakeChallengeEntry {
  purpose: string;
  dpopJkt: string;
  deviceId: string | undefined;
  expiresAt: Date;
  consumed: boolean;
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
    now: Date;
  }): Promise<{ deviceId: string | undefined } | null> {
    this.consumeCallCount++;
    const entry = this.issued.get(input.challenge);
    if (
      entry === undefined ||
      entry.purpose !== input.purpose ||
      entry.consumed ||
      entry.expiresAt <= input.now
    ) {
      return null;
    }
    entry.consumed = true;
    return { deviceId: entry.deviceId };
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
  const packageInfos = new asn1js.Set({ value: [] });
  const signatureDigests = new asn1js.Set({
    value: [new asn1js.OctetString({ valueHex: Buffer.from(certDigestHex, "hex") })],
  });
  return new asn1js.Sequence({ value: [packageInfos, signatureDigests] }).toBER(false);
}

function buildKeyDescription(challenge: string): ArrayBuffer {
  const teeEnforced = new asn1js.Sequence({
    value: [
      taggedNode(504, new asn1js.Integer({ value: 0b10 })), // fingerprint only
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

/** One valid Android key-attestation chain, bound to `challenge`. */
async function buildAndroidAttestationChain(
  challenge: string,
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
  });

  const leafKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const leafCert = await X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test Leaf",
    issuer: rootCert.subject,
    notBefore: new Date("2020-01-01"),
    notAfter: new Date("2035-01-01"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: leafKeys.publicKey,
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
}): Promise<{ jws: string; bioJkt: string; publicJwk: JWK }> {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await exportJWK(publicKey);
  const bioJkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const jws = await new SignJWT({
    purpose: options.purpose ?? "enrol-device",
    challenge: options.challenge,
    iat: options.iat ?? Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({ alg: "ES256", typ: JWS_TYP, kid: bioJkt, jwk: publicJwk as Record<string, unknown> })
    .sign(privateKey);
  return { jws, bioJkt, publicJwk };
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
    const chain = await buildAndroidAttestationChain(challenge);
    const { jws, bioJkt } = await buildEnrolJws({ challenge });

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
    ).rejects.toBeInstanceOf(DevicePairingNotImplementedError);
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
    const { jws } = await buildEnrolJws({ challenge });
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
    const { jws } = await buildEnrolJws({ challenge });
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
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
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
    const chain = await buildAndroidAttestationChain(challenge);
    const { jws } = await buildEnrolJws({ challenge });

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
