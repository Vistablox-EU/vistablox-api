import "dotenv/config";

import { toNodeHandler } from "better-auth/node";
import type { JWKS } from "oidc-provider";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { createClient } from "redis";

import { createApp } from "./app.js";
import { loadEnvironment } from "./config/environment.js";
import { PrismaDatabaseProbe } from "./infrastructure/database/database-probe.js";
import { createPrismaClient } from "./infrastructure/database/prisma.js";
import { RedisProtectedProfileCache } from "./infrastructure/cache/redis-protected-profile-cache.js";
import { RedisRateLimitStore } from "./infrastructure/rate-limit/redis-rate-limit-store.js";
import { SmtpEmailSender } from "./infrastructure/email/smtp-email-sender.js";
import { createLogger } from "./infrastructure/logging/logger.js";
import { AccountProvisioner } from "./modules/account/application/account-provisioner.js";
import { PrismaAccountRepository } from "./modules/account/repository/prisma-account.repository.js";
import { createBetterAuth } from "./modules/auth/infrastructure/better-auth.factory.js";
import { createAppleClientSecret } from "./modules/auth/infrastructure/apple-client-secret.js";
import { BetterAuthStaffIdentityProvider } from "./modules/auth/infrastructure/better-auth-staff-identity.provider.js";
import { BetterAuthStaffAccountAdministrator } from "./modules/auth/infrastructure/better-auth-staff-account-administrator.js";
import { BetterAuthSessionResolver } from "./modules/auth/infrastructure/better-auth-session.resolver.js";
import { SimpleWebAuthnCeremony } from "./modules/auth/infrastructure/simple-webauthn.ceremony.js";
import { PrismaStaffWebAuthnRepository } from "./modules/auth/repository/prisma-staff-webauthn.repository.js";
import { PrismaStaffInvitationRepository } from "./modules/auth/repository/prisma-staff-invitation.repository.js";
import { PrismaAuthAuditSink } from "./modules/auth/repository/prisma-auth-audit-sink.js";
import { PrismaStaffAccountLifecycleRepository } from "./modules/auth/repository/prisma-staff-account-lifecycle.repository.js";
import { BetterAuthCustomerAccountAdministrator } from "./modules/auth/infrastructure/better-auth-customer-account-administrator.js";
import { PrismaAccountRecoveryRepository } from "./modules/auth/repository/prisma-account-recovery.repository.js";
import { PrismaAccountRecoveryCodeRepository } from "./modules/auth/repository/prisma-account-recovery-code.repository.js";
import { PrismaTotpRepository } from "./modules/auth/repository/prisma-totp.repository.js";
import { OtplibTotpProvider } from "./modules/auth/infrastructure/otplib-totp.provider.js";
import { PrismaSessionMirror } from "./modules/auth/infrastructure/prisma-session-mirror.js";
import { PrismaCustomerSessionRepository } from "./modules/auth/repository/prisma-customer-session.repository.js";
import { BetterAuthSessionRevoker } from "./modules/auth/infrastructure/better-auth-session-revoker.js";
import { PostgresOidcGrantRepository } from "./modules/auth/infrastructure/postgres-oidc-grant.repository.js";
import { createOidcProvider } from "./modules/auth/infrastructure/oidc-provider.factory.js";
import { OidcBearerSessionResolver } from "./modules/auth/infrastructure/oidc-bearer-session.resolver.js";
import { CompositeSessionResolver } from "./modules/auth/application/composite-session.resolver.js";
import { PrismaOfferingRepository } from "./modules/offering/repository/prisma-offering.repository.js";
import { HttpCoinbaseCdpClient } from "./modules/offering/infrastructure/http-coinbase-cdp.client.js";
import { PrismaOriginationRepository } from "./modules/origination/repository/prisma-origination.repository.js";
import { HttpDiditClient } from "./modules/identity/infrastructure/didit.client.js";
import { DiditWebhookVerifier } from "./modules/identity/infrastructure/didit-webhook-verifier.js";
import { PrismaKycRepository } from "./modules/identity/repository/prisma-kyc.repository.js";
import {
  DiditProtectedDisplayProfileProvider,
  UnavailableProtectedDisplayProfileProvider,
} from "./infrastructure/profile/didit-protected-display-profile.provider.js";
import { PrismaInvestorProfileRepository } from "./modules/investor-profile/repository/prisma-investor-profile.repository.js";
import {
  MinioDisclosureDocumentStore,
  UnavailableDisclosureDocumentStore,
} from "./infrastructure/storage/minio-disclosure-document.store.js";

const environment = loadEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
const database = createPrismaClient(environment.DATABASE_URL);
const authDatabase = new Pool({ connectionString: environment.DATABASE_URL });
const jobQueue = new PgBoss(environment.DATABASE_URL);
jobQueue.on("error", (error) => {
  logger.error({ err: error }, "pg-boss error");
});
await jobQueue.start();
// Mirrors worker.ts: createQueue is ON CONFLICT DO NOTHING, so this is safe
// to run here even if the worker process hasn't started yet on a fresh
// deploy — a send() would otherwise fail against a queue that doesn't exist.
await jobQueue.createQueue("case_timers.pre_offering_open_handoff");
await jobQueue.createQueue("case_timers.offering_reconfirmation_window_opened");
await jobQueue.createQueue("case_timers.post_ipo_structuring_handoff");
// Only when Didit is configured — same "all six configured together or
// none" contract environment.ts's own refine enforces (see diditKyc
// below), so this single check is equivalent to checking all six.
if (environment.DIDIT_API_KEY !== undefined) {
  await jobQueue.createQueue("provider_events.didit_webhook");
}
const offeringRepository = new PrismaOfferingRepository(database, jobQueue);
const originationRepository = new PrismaOriginationRepository(database, jobQueue);
const accountRepository = new PrismaAccountRepository(database);
const staffWebAuthnRepository = new PrismaStaffWebAuthnRepository(database);
const staffInvitationRepository = new PrismaStaffInvitationRepository(database);
const staffAccountLifecycleRepository = new PrismaStaffAccountLifecycleRepository(database);
const authAuditSink = new PrismaAuthAuditSink(database);
const authBaseUrl = new URL(environment.BETTER_AUTH_URL);
const accountProvisioner = new AccountProvisioner(accountRepository);
const profileCacheClient =
  environment.PROFILE_CACHE_URL === undefined
    ? undefined
    : createClient({
        url: environment.PROFILE_CACHE_URL,
        socket: { connectTimeout: 3_000, reconnectStrategy: false },
      });
profileCacheClient?.on("error", (error) => {
  logger.warn({ err: error }, "protected profile cache connection error");
});
if (profileCacheClient !== undefined) {
  try {
    await profileCacheClient.connect();
  } catch (error) {
    logger.warn(
      { err: error },
      "protected profile cache unavailable; investor names will be omitted",
    );
  }
}
const protectedProfileCache =
  profileCacheClient?.isReady === true
    ? new RedisProtectedProfileCache(profileCacheClient)
    : undefined;
const rateLimitCacheClient =
  environment.RATE_LIMIT_CACHE_URL === undefined
    ? undefined
    : createClient({
        url: environment.RATE_LIMIT_CACHE_URL,
        socket: { connectTimeout: 3_000, reconnectStrategy: false },
      });
rateLimitCacheClient?.on("error", (error) => {
  logger.warn({ err: error }, "rate limit cache connection error");
});
if (rateLimitCacheClient !== undefined) {
  try {
    await rateLimitCacheClient.connect();
  } catch (error) {
    logger.warn({ err: error }, "rate limit cache unavailable; rate limiting is disabled");
  }
}
const rateLimitStore =
  rateLimitCacheClient?.isReady === true
    ? new RedisRateLimitStore(rateLimitCacheClient)
    : undefined;
const emailSender = new SmtpEmailSender({
  host: environment.SMTP_HOST,
  port: environment.SMTP_PORT,
  secure: environment.SMTP_SECURE,
  user: environment.SMTP_USER,
  password: environment.SMTP_PASSWORD,
  from: environment.SMTP_FROM,
});
// The Expo dev client always connects through the `exp://` scheme rather than
// the app's own custom scheme (already covered by AUTH_TRUSTED_ORIGINS), so
// these wildcards are only needed — and only safe — outside production.
const appTrustedOrigins =
  environment.NODE_ENV === "production"
    ? environment.AUTH_TRUSTED_ORIGINS
    : [...environment.AUTH_TRUSTED_ORIGINS, "exp://", "exp://**", "exp://192.168.*.*:*/**"];
const trustedOrigins = environment.APPLE_OAUTH_ENABLED
  ? [...new Set([...appTrustedOrigins, "https://appleid.apple.com"])]
  : appTrustedOrigins;
const auth = createBetterAuth({
  database: authDatabase,
  baseURL: environment.BETTER_AUTH_URL,
  secret: environment.BETTER_AUTH_SECRET,
  secureCookies: environment.NODE_ENV === "production",
  trustedOrigins,
  webauthn: {
    rpId: environment.WEBAUTHN_RP_ID ?? authBaseUrl.hostname,
    origins: [
      environment.WEBAUTHN_ORIGIN ?? authBaseUrl.origin,
      ...(environment.PASSKEY_ANDROID_ORIGINS ?? []),
    ],
  },
  ...(!environment.GOOGLE_OAUTH_ENABLED ||
  environment.GOOGLE_CLIENT_ID === undefined ||
  environment.GOOGLE_CLIENT_SECRET === undefined
    ? {}
    : {
        google: {
          clientId: environment.GOOGLE_CLIENT_ID,
          clientSecret: environment.GOOGLE_CLIENT_SECRET,
        },
      }),
  ...(!environment.APPLE_OAUTH_ENABLED ||
  environment.APPLE_CLIENT_ID === undefined ||
  environment.APPLE_TEAM_ID === undefined ||
  environment.APPLE_KEY_ID === undefined ||
  environment.APPLE_PRIVATE_KEY === undefined
    ? {}
    : {
        apple: {
          clientId: environment.APPLE_CLIENT_ID,
          createClientSecret: () =>
            createAppleClientSecret({
              clientId: environment.APPLE_CLIENT_ID as string,
              teamId: environment.APPLE_TEAM_ID as string,
              keyId: environment.APPLE_KEY_ID as string,
              privateKey: environment.APPLE_PRIVATE_KEY as string,
            }),
        },
      }),
  onUserCreated: (user) => accountProvisioner.onUserCreated(user),
  onUserUpdated: (user) => accountProvisioner.onUserUpdated(user),
  onLoginMethodUsed: (method) => accountProvisioner.onLoginMethodUsed(method),
  authAuditSink,
  sessionMirror: new PrismaSessionMirror(database, environment.BETTER_AUTH_SECRET),
  onBackgroundError: (error) => {
    logger.error({ err: error }, "background authentication task failed");
  },
});
const staffProvisioningAuth = createBetterAuth({
  database: authDatabase,
  baseURL: environment.BETTER_AUTH_URL,
  secret: environment.BETTER_AUTH_SECRET,
  secureCookies: environment.NODE_ENV === "production",
  trustedOrigins,
  webauthn: {
    rpId: environment.WEBAUTHN_RP_ID ?? authBaseUrl.hostname,
    origins: [environment.WEBAUTHN_ORIGIN ?? authBaseUrl.origin],
  },
  allowPopulationInput: true,
  onUserCreated: (user) => accountProvisioner.onUserCreated(user),
  onUserUpdated: (user) => accountProvisioner.onUserUpdated(user),
});
const diditClient =
  environment.DIDIT_API_KEY === undefined
    ? undefined
    : new HttpDiditClient({
        baseUrl: environment.DIDIT_API_BASE_URL,
        apiKey: environment.DIDIT_API_KEY,
        timeoutMs: 4_000,
      });
const diditKyc =
  diditClient !== undefined &&
  environment.DIDIT_WORKFLOW_ID !== undefined &&
  environment.DIDIT_CALLBACK_URL !== undefined &&
  environment.DIDIT_WEBHOOK_SECRET !== undefined &&
  environment.DIDIT_APPLICATION_ID !== undefined &&
  environment.DIDIT_ENVIRONMENT !== undefined
    ? {
        repository: new PrismaKycRepository(database, jobQueue),
        didit: diditClient,
        webhookVerifier: new DiditWebhookVerifier(environment.DIDIT_WEBHOOK_SECRET),
        workflowId: environment.DIDIT_WORKFLOW_ID,
        callbackUrl: environment.DIDIT_CALLBACK_URL,
        ...(environment.DIDIT_POA_WORKFLOW_ID === undefined
          ? {}
          : { proofOfAddressWorkflowId: environment.DIDIT_POA_WORKFLOW_ID }),
        ...(protectedProfileCache === undefined
          ? {}
          : {
              invalidateDisplayProfile: async (accountId: string) => {
                try {
                  await protectedProfileCache.delete(accountId);
                } catch (error) {
                  logger.warn(
                    { err: error, account_id: accountId },
                    "protected display profile cache invalidation failed",
                  );
                }
              },
            }),
      }
    : undefined;
// Reuses the same baseline Didit workflow as ordinary KYC (AD-062's didit-kyc.md
// follow-on work): a fresh recovery verification only needs to re-prove a live
// human with a valid ID, not a separate provider configuration.
const customerAccountAdministrator = new BetterAuthCustomerAccountAdministrator(
  auth,
  emailSender,
);
const accountRecovery =
  diditKyc === undefined
    ? undefined
    : {
        repository: new PrismaAccountRecoveryRepository(database),
        administrator: customerAccountAdministrator,
        didit: diditKyc.didit,
        workflowId: diditKyc.workflowId,
        callbackUrl: diditKyc.callbackUrl,
        recoveryRedirectUrl:
          environment.ACCOUNT_RECOVERY_REDIRECT_URL ?? "com.vistablox.app://recover-account",
        emailSender,
      };
const onrampRedirectUrl = environment.COINBASE_ONRAMP_REDIRECT_URL;
const coinbaseCdpClient =
  environment.COINBASE_CDP_API_KEY_ID === undefined ||
  environment.COINBASE_CDP_API_KEY_SECRET === undefined ||
  environment.COINBASE_ONRAMP_REDIRECT_URL === undefined
    ? undefined
    : new HttpCoinbaseCdpClient({
        baseUrl: environment.COINBASE_CDP_API_BASE_URL,
        payHostedUrl: environment.COINBASE_CDP_PAY_HOSTED_URL,
        apiKeyId: environment.COINBASE_CDP_API_KEY_ID,
        apiKeySecret: environment.COINBASE_CDP_API_KEY_SECRET,
        timeoutMs: 8_000,
      });
// Necessary but not sufficient on its own: RESERVATION_FUNDING_RAIL_ENABLED
// is the human "I've verified this live" switch, but it can never actually
// open the rail without a configured Coinbase client to serve it — an
// operator who sets one without the other should not get a confusing
// half-enabled state (readiness reporting available with no route to act on
// it, or vice versa).
const reservationFundingRailEnabled =
  environment.RESERVATION_FUNDING_RAIL_ENABLED && coinbaseCdpClient !== undefined;
const betterAuthSessionResolver = new BetterAuthSessionResolver(auth);
const oidcProvider = createOidcProvider({
  baseUrl: environment.BETTER_AUTH_URL,
  pool: authDatabase,
  cookieSecret: environment.BETTER_AUTH_SECRET,
  jwks: environment.OIDC_JWKS as JWKS,
  nativeRedirectUris: environment.OIDC_NATIVE_REDIRECT_URIS,
  secureCookies: environment.NODE_ENV === "production",
});
const sessions = new CompositeSessionResolver([
  new OidcBearerSessionResolver(oidcProvider),
  betterAuthSessionResolver,
]);
const displayProfiles =
  protectedProfileCache !== undefined && diditClient !== undefined
    ? new DiditProtectedDisplayProfileProvider(
        protectedProfileCache,
        diditClient,
        undefined,
        (error, operation) => {
          logger.warn(
            { err: error, operation },
            "protected display profile refresh failed",
          );
        },
      )
    : new UnavailableProtectedDisplayProfileProvider();
const disclosureDocumentStore =
  environment.MINIO_ENDPOINT !== undefined &&
  environment.MINIO_ACCESS_KEY !== undefined &&
  environment.MINIO_SECRET_KEY !== undefined &&
  environment.MINIO_DOCUMENT_BUCKET !== undefined
    ? new MinioDisclosureDocumentStore({
        endPoint: environment.MINIO_ENDPOINT,
        port: environment.MINIO_PORT,
        useSSL: environment.MINIO_USE_SSL,
        accessKey: environment.MINIO_ACCESS_KEY,
        secretKey: environment.MINIO_SECRET_KEY,
        bucket: environment.MINIO_DOCUMENT_BUCKET,
      })
    : new UnavailableDisclosureDocumentStore();
const app = createApp({
  databaseProbe: new PrismaDatabaseProbe(database),
  offeringRepository,
  logger,
  authHandler: toNodeHandler(auth),
  passkeyAssociations: {
    ...(environment.PASSKEY_APPLE_TEAM_ID === undefined
      ? {}
      : { appleTeamId: environment.PASSKEY_APPLE_TEAM_ID }),
    appleBundleId: "com.vistablox.app",
    androidPackageName: "com.vistablox.app",
    ...(environment.PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS === undefined
      ? {}
      : {
          androidCertificateFingerprints:
            environment.PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS,
        }),
  },
  ...(rateLimitStore === undefined ? {} : { rateLimitStore }),
  reservationFundingRailEnabled,
  protectedApi: {
    accounts: accountRepository,
    sessions,
    oauthBootstrapSessions: new BetterAuthSessionResolver(auth, {
      allowPendingOAuth: true,
    }),
    originationRepository,
    offeringOperations: { repository: offeringRepository },
    staffWebAuthnRepository,
    staffWebAuthnCeremony: new SimpleWebAuthnCeremony({
      rpName: environment.WEBAUTHN_RP_NAME,
      rpId: environment.WEBAUTHN_RP_ID ?? authBaseUrl.hostname,
      expectedOrigin: environment.WEBAUTHN_ORIGIN ?? authBaseUrl.origin,
    }),
    investorProfile: {
      repository: new PrismaInvestorProfileRepository(database),
      displayProfiles,
    },
    disclosureDocuments: {
      repository: offeringRepository,
      store: disclosureDocumentStore,
    },
    ...(coinbaseCdpClient === undefined || onrampRedirectUrl === undefined
      ? {}
      : {
          reservations: {
            repository: offeringRepository,
            coinbase: coinbaseCdpClient,
            blockchain: environment.COINBASE_ONRAMP_BLOCKCHAIN,
            buildRedirectUrl: (reservationId: string) =>
              `${onrampRedirectUrl}?reservation_id=${encodeURIComponent(reservationId)}`,
          },
        }),
    totp: {
      repository: new PrismaTotpRepository(database),
      provider: new OtplibTotpProvider(),
      backupCodeHashKey: environment.BETTER_AUTH_SECRET,
    },
    customerSessions: {
      repository: new PrismaCustomerSessionRepository(database),
      revoker: new BetterAuthSessionRevoker(auth),
      oidcGrants: new PostgresOidcGrantRepository(authDatabase),
      auditSink: authAuditSink,
    },
    accountRecoveryCodes: {
      repository: new PrismaAccountRecoveryCodeRepository(database),
      administrator: customerAccountAdministrator,
      hashKey: environment.BETTER_AUTH_SECRET,
    },
    oidc: {
      provider: oidcProvider,
      betterAuthSessions: betterAuthSessionResolver,
    },
    ...(diditKyc === undefined ? {} : { kyc: diditKyc }),
    staffAccountLifecycle: {
      repository: staffAccountLifecycleRepository,
      administrator: new BetterAuthStaffAccountAdministrator(auth, emailSender),
      recoveryRedirectUrl:
        environment.STAFF_RECOVERY_REDIRECT_URL ??
        new URL("/staff/recover-account", authBaseUrl).toString(),
    },
    ...(accountRecovery === undefined ? {} : { accountRecovery }),
    staffInvitations: {
      repository: staffInvitationRepository,
      identities: new BetterAuthStaffIdentityProvider(staffProvisioningAuth),
      sendEmail: (email) => emailSender.sendStaffInvitationEmail(email),
      acceptUrl:
        environment.STAFF_INVITATION_ACCEPT_URL ??
        new URL("/staff/accept-invitation", authBaseUrl).toString(),
    },
  },
});

const server = app.listen(environment.PORT, environment.HOST, () => {
  logger.info(
    { host: environment.HOST, port: environment.PORT },
    "VistaBlox API listening",
  );
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close(async (error) => {
    const shutdownTasks: Promise<unknown>[] = [
      database.$disconnect(),
      authDatabase.end(),
      jobQueue.stop(),
    ];
    if (profileCacheClient?.isOpen === true) {
      shutdownTasks.push(profileCacheClient.close());
    }
    if (rateLimitCacheClient?.isOpen === true) {
      shutdownTasks.push(rateLimitCacheClient.close());
    }
    await Promise.all(shutdownTasks);
    if (error !== undefined) {
      logger.error({ err: error }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
