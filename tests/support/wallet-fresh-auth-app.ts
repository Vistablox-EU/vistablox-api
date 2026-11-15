import pino from "pino";
import { vi } from "vitest";

import { createApp, type AppDependencies } from "../../src/app.js";
import type { AccountRepository } from "../../src/modules/account/repository/account.repository.js";
import type {
  AuthenticatedIdentity,
  SessionResolver,
} from "../../src/modules/auth/application/shared/session-resolver.js";
import type { CustomerSessionRepository } from "../../src/modules/auth/repository/customer/customer-session.repository.js";
import type { KycEligibilityReader } from "../../src/modules/identity/repository/kyc-eligibility-reader.js";
import type { WalletRepository } from "../../src/modules/wallet/repository/wallet.repository.js";

export const REGISTRY_ADDRESS = "0x1234567890123456789012345678901234567890";

type ProtectedApi = NonNullable<AppDependencies["protectedApi"]>;

// createApp with the REAL requireAuthentication, the REAL fresh-authentication
// probe and the REAL wallet router, service and (caller's choice of) wallet
// repository. Only the edges are fakes: the session resolver says who the
// caller is and when that session was created, the customer-session repository
// is the probe's fallback lookup, and every module this file never reaches is
// an empty object (createApp only dereferences them when a request does).
export function buildWalletFreshAuthApp(options: {
  walletRepository: WalletRepository;
  accountId?: string;
  // What the session resolver reports. sessionCreatedAt defaults to one minute
  // ago, authenticationLevel to device_biometric: a fresh device session.
  identity?: Partial<AuthenticatedIdentity>;
  // The repository fallback the probe consults for a session outside the
  // window. Defaults to "no", which is what it always is for a customer.
  hasFreshAuthentication?: CustomerSessionRepository["hasFreshAuthentication"];
  // The resolver leaves authenticationLevel out, as it may.
  omitAuthenticationLevel?: boolean;
  omitCustomerSessions?: boolean;
  kycEligible?: boolean;
}) {
  const accountId = options.accountId ?? "acct_wallet_fa";
  const identity: AuthenticatedIdentity = {
    betterAuthUserId: "auth_wallet_fa",
    providerSessionId: "session_wallet_fa",
    population: "customer",
    dpopJkt: null,
    sessionCreatedAt: new Date(Date.now() - 60_000),
    authenticationLevel: "device_biometric",
    ...options.identity,
  };
  if (options.omitAuthenticationLevel === true) delete identity.authenticationLevel;
  const sessions: SessionResolver = { resolve: vi.fn().mockResolvedValue(identity) };
  const accounts = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId, status: "active" }),
  } as unknown as AccountRepository;
  const customerSessionRepository: CustomerSessionRepository = {
    listForAccount: vi.fn(),
    findOwnedProviderSessionId: vi.fn(),
    hasFreshAuthentication:
      options.hasFreshAuthentication ?? vi.fn().mockResolvedValue(false),
  };
  const kycEligibilityReader: KycEligibilityReader = {
    getEligibilitySnapshot: vi.fn().mockResolvedValue(
      options.kycEligible === false
        ? null
        : {
            accountId,
            diditReference: null,
            providerStatus: null,
            eligibilityState: "eligible",
            residenceCountryCode: "DE",
            taxResidenceCountryCode: "DE",
            proofOfAddressStatus: "current",
            proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
            lastVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
            renewalDueAt: new Date("2099-01-01T00:00:00.000Z"),
          },
    ),
  };
  const protectedApi = {
    accounts,
    sessions,
    intakeRepository: {} as never,
    emailSender: {} as never,
    staffWebAuthnRepository: {} as never,
    staffWebAuthnCeremony: {} as never,
    wallet: {
      repository: options.walletRepository,
      kycEligibilityReader,
      walletRegistryContractAddress: REGISTRY_ADDRESS,
    },
    ...(options.omitCustomerSessions === true
      ? {}
      : { customerSessions: { repository: customerSessionRepository, revoker: {} as never } }),
  } satisfies ProtectedApi;

  const build = () =>
    createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      protectedApi,
    });

  return { build, customerSessionRepository, sessions, identity };
}
