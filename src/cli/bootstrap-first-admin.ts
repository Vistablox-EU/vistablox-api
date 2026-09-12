/**
 * One-time bootstrap of the first admin_operations staff member.
 *
 *   npm run staff:bootstrap-first-admin -- --email <email> --display-name <name>
 *   npm run staff:bootstrap-first-admin -- --check
 *
 * Run from a shell inside the API container (Coolify terminal), where the
 * container's own environment is read through the normal loadEnvironment().
 * There is deliberately no HTTP equivalent: a "first admin" web endpoint
 * would let whoever reached it first become admin, and would reopen every
 * time the staff roster became empty. Only someone with shell access to the
 * running API container can do this.
 *
 * Exit codes: 0 done, 1 refused (an admin already exists) or failed,
 * 2 bad arguments.
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  loadEnvironment,
  resolveStaffInvitationAcceptUrl,
  resolveWebAuthnSettings,
} from "../config/environment.js";
import { createPrismaClient } from "../infrastructure/database/prisma.js";
import { SmtpEmailSender } from "../infrastructure/email/smtp-email-sender.js";
import { BootstrapFirstAdminService } from "../modules/auth/application/staff-bootstrap.service.js";
import { BetterAuthStaffIdentityProvider } from "../modules/auth/infrastructure/better-auth-staff-identity.provider.js";
import { createBetterAuth } from "../modules/auth/infrastructure/better-auth.factory.js";
import { PrismaStaffBootstrapRepository } from "../modules/auth/repository/prisma-staff-bootstrap.repository.js";
import { AppError } from "../shared/errors/app-error.js";
import {
  BOOTSTRAP_FIRST_ADMIN_USAGE,
  parseBootstrapFirstAdminArguments,
} from "./bootstrap-first-admin-arguments.js";

const EXIT_REFUSED_OR_FAILED = 1;
const EXIT_USAGE = 2;

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<number> {
  const parsed = parseBootstrapFirstAdminArguments(process.argv.slice(2));
  if (!parsed.ok) {
    printError(`Error: ${parsed.error}\n`);
    printError(BOOTSTRAP_FIRST_ADMIN_USAGE);
    return EXIT_USAGE;
  }
  if (parsed.value.mode === "help") {
    print(BOOTSTRAP_FIRST_ADMIN_USAGE);
    return 0;
  }

  const environment = loadEnvironment();
  const database = createPrismaClient(environment.DATABASE_URL);
  const authDatabase = new Pool({ connectionString: environment.DATABASE_URL });
  try {
    // Only used for the "is this email already a Better Auth identity"
    // lookup; the identity itself is created later, on acceptance, by the
    // API's unchanged AcceptStaffInvitationService.
    const staffProvisioningAuth = createBetterAuth({
      database: authDatabase,
      baseURL: environment.BETTER_AUTH_URL,
      secret: environment.BETTER_AUTH_SECRET,
      secureCookies: environment.NODE_ENV === "production",
      trustedOrigins: environment.AUTH_TRUSTED_ORIGINS,
      webauthn: resolveWebAuthnSettings(environment).passkey,
      allowPopulationInput: true,
    });
    const emailSender = new SmtpEmailSender({
      host: environment.SMTP_HOST,
      port: environment.SMTP_PORT,
      secure: environment.SMTP_SECURE,
      user: environment.SMTP_USER,
      password: environment.SMTP_PASSWORD,
      from: environment.SMTP_FROM,
    });
    const service = new BootstrapFirstAdminService(
      new PrismaStaffBootstrapRepository(database),
      new BetterAuthStaffIdentityProvider(staffProvisioningAuth),
      (email) => emailSender.sendStaffInvitationEmail(email),
      resolveStaffInvitationAcceptUrl(environment),
    );

    if (parsed.value.mode === "check") {
      const counts = await service.check();
      print("First-admin bootstrap check (read-only, nothing changed):");
      print(`  active staff accounts:                   ${counts.activeStaffAccounts}`);
      print(`  active admin_operations holders:         ${counts.activeAdminOperationsHolders}`);
      print(`  pending unexpired bootstrap invitations: ${counts.pendingBootstrapInvitations}`);
      print(
        counts.activeAdminOperationsHolders > 0
          ? "Bootstrap would be REFUSED: an admin already exists. Invite staff from the admin console."
          : "Bootstrap is available.",
      );
      return 0;
    }

    const traceId = `cli_bootstrap_${randomUUID()}`;
    const result = await service.issue({
      email: parsed.value.email,
      displayName: parsed.value.displayName,
      traceId,
    });
    if (result.outcome === "refused_admin_exists") {
      printError(
        "Refused: an active staff account already holds admin_operations. Nothing was changed.\n" +
          "Invite further staff from the admin console instead.",
      );
      return EXIT_REFUSED_OR_FAILED;
    }

    print("First-admin bootstrap invitation issued.");
    print(`  invitation_id: ${result.invitationId}`);
    print("  role:          admin_operations");
    print(`  expires_at:    ${result.expiresAt.toISOString()}`);
    print(`  trace_id:      ${traceId}`);
    if (result.replacedPendingBootstrapInvitations > 0) {
      print(
        `Revoked ${result.replacedPendingBootstrapInvitations} earlier, still-pending bootstrap ` +
          "invitation(s); their links no longer work.",
      );
    }
    print(
      result.emailDelivery.delivered
        ? `Invitation email sent to ${result.email}.`
        : `Invitation email could NOT be sent (${result.emailDelivery.errorCode}); use the URL below.`,
    );
    print();
    print("Accept URL. Shown once, never stored or logged; treat it like a password:");
    print(result.invitationUrl);
    print();
    print(
      "Open it on the admin console origin, accept, then register a passkey. " +
        "The link is single-use and expires in 72 hours.",
    );
    return 0;
  } catch (error) {
    // AppError details are fixed strings; nothing here ever carries the
    // token, which only exists after the invitation commits.
    if (error instanceof AppError) {
      printError(`Failed: ${error.code}: ${error.detail}`);
    } else {
      printError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return EXIT_REFUSED_OR_FAILED;
  } finally {
    await Promise.allSettled([database.$disconnect(), authDatabase.end()]);
  }
}

process.exit(await main());
