import "dotenv/config";

import { toNodeHandler } from "better-auth/node";
import { Pool } from "pg";

import { createApp } from "./app.js";
import { loadEnvironment } from "./config/environment.js";
import { PrismaDatabaseProbe } from "./infrastructure/database/database-probe.js";
import { createPrismaClient } from "./infrastructure/database/prisma.js";
import { SmtpEmailSender } from "./infrastructure/email/smtp-email-sender.js";
import { createLogger } from "./infrastructure/logging/logger.js";
import { AccountProvisioner } from "./modules/account/application/account-provisioner.js";
import { PrismaAccountRepository } from "./modules/account/repository/prisma-account.repository.js";
import { createBetterAuth } from "./modules/auth/infrastructure/better-auth.factory.js";
import { BetterAuthStaffIdentityProvider } from "./modules/auth/infrastructure/better-auth-staff-identity.provider.js";
import { BetterAuthStaffAccountAdministrator } from "./modules/auth/infrastructure/better-auth-staff-account-administrator.js";
import { BetterAuthSessionResolver } from "./modules/auth/infrastructure/better-auth-session.resolver.js";
import { SimpleWebAuthnCeremony } from "./modules/auth/infrastructure/simple-webauthn.ceremony.js";
import { PrismaStaffWebAuthnRepository } from "./modules/auth/repository/prisma-staff-webauthn.repository.js";
import { PrismaStaffInvitationRepository } from "./modules/auth/repository/prisma-staff-invitation.repository.js";
import { PrismaAuthAuditSink } from "./modules/auth/repository/prisma-auth-audit-sink.js";
import { PrismaStaffAccountLifecycleRepository } from "./modules/auth/repository/prisma-staff-account-lifecycle.repository.js";
import { PrismaOfferingRepository } from "./modules/offering/repository/prisma-offering.repository.js";
import { PrismaOriginationRepository } from "./modules/origination/repository/prisma-origination.repository.js";

const environment = loadEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
const database = createPrismaClient(environment.DATABASE_URL);
const authDatabase = new Pool({ connectionString: environment.DATABASE_URL });
const accountRepository = new PrismaAccountRepository(database);
const staffWebAuthnRepository = new PrismaStaffWebAuthnRepository(database);
const staffInvitationRepository = new PrismaStaffInvitationRepository(database);
const staffAccountLifecycleRepository = new PrismaStaffAccountLifecycleRepository(database);
const authAuditSink = new PrismaAuthAuditSink(database);
const authBaseUrl = new URL(environment.BETTER_AUTH_URL);
const accountProvisioner = new AccountProvisioner(accountRepository);
const emailSender = new SmtpEmailSender({
  host: environment.SMTP_HOST,
  port: environment.SMTP_PORT,
  secure: environment.SMTP_SECURE,
  user: environment.SMTP_USER,
  password: environment.SMTP_PASSWORD,
  from: environment.SMTP_FROM,
});
const auth = createBetterAuth({
  database: authDatabase,
  baseURL: environment.BETTER_AUTH_URL,
  secret: environment.BETTER_AUTH_SECRET,
  secureCookies: environment.NODE_ENV === "production",
  trustedOrigins: environment.AUTH_TRUSTED_ORIGINS,
  ...(environment.GOOGLE_CLIENT_ID === undefined ||
  environment.GOOGLE_CLIENT_SECRET === undefined
    ? {}
    : {
        google: {
          clientId: environment.GOOGLE_CLIENT_ID,
          clientSecret: environment.GOOGLE_CLIENT_SECRET,
        },
      }),
  onUserCreated: (user) => accountProvisioner.onUserCreated(user),
  onUserUpdated: (user) => accountProvisioner.onUserUpdated(user),
  sendVerificationEmail: (email) => emailSender.sendVerificationEmail(email),
  sendPasswordResetEmail: (email) => emailSender.sendPasswordResetEmail(email),
  authAuditSink,
  onBackgroundError: (error) => {
    logger.error({ err: error }, "background authentication task failed");
  },
});
const staffProvisioningAuth = createBetterAuth({
  database: authDatabase,
  baseURL: environment.BETTER_AUTH_URL,
  secret: environment.BETTER_AUTH_SECRET,
  secureCookies: environment.NODE_ENV === "production",
  trustedOrigins: environment.AUTH_TRUSTED_ORIGINS,
  allowPopulationInput: true,
  disableAutoSignIn: true,
  onUserCreated: (user) => accountProvisioner.onUserCreated(user),
  onUserUpdated: (user) => accountProvisioner.onUserUpdated(user),
});
const app = createApp({
  databaseProbe: new PrismaDatabaseProbe(database),
  offeringRepository: new PrismaOfferingRepository(database),
  logger,
  authHandler: toNodeHandler(auth),
  protectedApi: {
    accounts: accountRepository,
    sessions: new BetterAuthSessionResolver(auth),
    originationRepository: new PrismaOriginationRepository(database),
    staffWebAuthnRepository,
    staffWebAuthnCeremony: new SimpleWebAuthnCeremony({
      rpName: environment.WEBAUTHN_RP_NAME,
      rpId: environment.WEBAUTHN_RP_ID ?? authBaseUrl.hostname,
      expectedOrigin: environment.WEBAUTHN_ORIGIN ?? authBaseUrl.origin,
    }),
    staffAccountLifecycle: {
      repository: staffAccountLifecycleRepository,
      administrator: new BetterAuthStaffAccountAdministrator(auth),
      recoveryRedirectUrl:
        environment.STAFF_RECOVERY_REDIRECT_URL ??
        new URL("/staff/reset-password", authBaseUrl).toString(),
    },
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
    await Promise.all([database.$disconnect(), authDatabase.end()]);
    if (error !== undefined) {
      logger.error({ err: error }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
