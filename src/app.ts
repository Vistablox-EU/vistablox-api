import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

import type { DatabaseProbe } from "./infrastructure/database/database-probe.js";
import type { EmailSender } from "./infrastructure/email/smtp-email-sender.js";
import type { AccountRepository } from "./modules/account/repository/account.repository.js";
import { createRequireAuthentication } from "./modules/auth/api/require-authentication.js";
import { rejectDisabledAuthRoutes } from "./modules/auth/api/reject-disabled-auth.js";
import { createRequireFreshAuthentication } from "./modules/auth/api/require-fresh-authentication.js";
import {
  createRequireAdminOperations,
  createRequireAppraisalPartner,
  createRequireLegalPartner,
  createRequireStaffIdentity,
  createRequireStaffWebAuthn,
} from "./modules/auth/api/require-staff-role.js";
import { createStaffWebAuthnRouter } from "./modules/auth/api/staff-webauthn.router.js";
import {
  createInternalStaffInvitationRouter,
  createPublicStaffInvitationRouter,
} from "./modules/auth/api/staff-invitation.router.js";
import { createStaffAccountLifecycleRouter } from "./modules/auth/api/staff-account-lifecycle.router.js";
import {
  AcceptStaffInvitationService,
  IssueStaffInvitationService,
} from "./modules/auth/application/staff-invitation.service.js";
import type { StaffIdentityProvider } from "./modules/auth/application/staff-identity-provider.js";
import type { StaffInvitationRepository } from "./modules/auth/repository/staff-invitation.repository.js";
import {
  GrantStaffRoleService,
  ListStaffAccountsService,
  OffboardStaffAccountService,
  RecoverStaffAccountService,
  RevokeStaffRoleService,
} from "./modules/auth/application/staff-account-lifecycle.service.js";
import type { StaffAccountAdministrator } from "./modules/auth/application/staff-account-administrator.js";
import type { StaffAccountLifecycleRepository } from "./modules/auth/repository/staff-account-lifecycle.repository.js";
import { createAccountRecoveryRouter } from "./modules/auth/api/account-recovery.router.js";
import { createAccountRecoveryCodeRouter } from "./modules/auth/api/account-recovery-code.router.js";
import {
  CompleteAccountRecoveryService,
  CreateRecoveryDiditSessionService,
  DecideAccountRecoveryCaseService,
  GetAccountRecoveryCaseService,
  OpenAccountRecoveryCaseService,
  RecordPrimaryRecoveryReviewService,
} from "./modules/auth/application/account-recovery.service.js";
import {
  RedeemAccountRecoveryCodeService,
  RotateAccountRecoveryCodeService,
} from "./modules/auth/application/account-recovery-code.service.js";
import type { CustomerAccountAdministrator } from "./modules/auth/application/customer-account-administrator.js";
import type { AccountRecoveryCodeRepository } from "./modules/auth/repository/account-recovery-code.repository.js";
import type { AccountRecoveryRepository } from "./modules/auth/repository/account-recovery.repository.js";
import { createAccountClosureRouter } from "./modules/auth/api/account-closure.router.js";
import { createAccountClosureOperationsRouter } from "./modules/auth/api/account-closure-operations.router.js";
import {
  CancelAccountClosureService,
  DecideAccountClosureRequestService,
  ListPendingAccountClosureRequestsService,
  RequestAccountClosureService,
} from "./modules/auth/application/account-closure.service.js";
import type { AccountClosureRepository } from "./modules/auth/repository/account-closure.repository.js";
import { StaffWebAuthnService } from "./modules/auth/application/staff-webauthn.service.js";
import type { StaffWebAuthnCeremony } from "./modules/auth/application/staff-webauthn.ceremony.js";
import type { StaffWebAuthnRepository } from "./modules/auth/repository/staff-webauthn.repository.js";
import type { SessionResolver } from "./modules/auth/application/session-resolver.js";
import { createCustomerSessionRouter } from "./modules/auth/api/customer-session.router.js";
import {
  ListOwnSessionsService,
  RevokeAllOwnSessionsService,
  RevokeOwnSessionService,
} from "./modules/auth/application/customer-session.service.js";
import type { CustomerSessionRepository } from "./modules/auth/repository/customer-session.repository.js";
import type { SessionRevoker } from "./modules/auth/application/session-revoker.js";
import { createTotpRouter } from "./modules/auth/api/totp.router.js";
import { EnrollTotpService, VerifyTotpService } from "./modules/auth/application/totp.service.js";
import type { TotpProvider } from "./modules/auth/infrastructure/otplib-totp.provider.js";
import type { TotpRepository } from "./modules/auth/repository/totp.repository.js";
import { createHealthRouter } from "./modules/health/health.router.js";
import {
  createInvestorOfferingRouter,
  createOfferingRouter,
} from "./modules/offering/api/offering.router.js";
import { createOfferingOperationsRouter } from "./modules/offering/api/offering-operations.router.js";
import { GetInvestorOfferingService } from "./modules/offering/application/get-investor-offering.service.js";
import { DownloadDisclosureDocumentService } from "./modules/offering/application/download-disclosure-document.service.js";
import { CreateReservationService } from "./modules/offering/application/create-reservation.service.js";
import { ClassifyMaterialityService } from "./modules/offering/application/classify-materiality.service.js";
import { PublishDisclosurePackService } from "./modules/offering/application/publish-disclosure-pack.service.js";
import { FinalizeOfferingService } from "./modules/offering/application/finalize-offering.service.js";
import { ReconfirmReservationService } from "./modules/offering/application/reconfirm-reservation.service.js";
import type { CoinbaseCdpClient } from "./modules/offering/application/coinbase-cdp-client.js";
import type { DisclosureDocumentStore } from "./modules/offering/application/disclosure-document-store.js";
import type { DisclosureDocumentRepository } from "./modules/offering/repository/disclosure-document.repository.js";
import type { ReservationRepository } from "./modules/offering/repository/reservation.repository.js";
import type { FinalizeOfferingRepository } from "./modules/offering/repository/finalize-offering.repository.js";
import type { MaterialityRepository } from "./modules/offering/repository/materiality.repository.js";
import type { DisclosurePackRepository } from "./modules/offering/repository/disclosure-pack.repository.js";
import { ListPublicOfferingsService } from "./modules/offering/application/list-public-offerings.service.js";
import type { OfferingRepository } from "./modules/offering/repository/offering.repository.js";
import { createOriginationRouter } from "./modules/origination/api/origination.router.js";
import { createOriginationOperationsRouter } from "./modules/origination/api/origination-operations.router.js";
import {
  createAppraisalFirmRouter,
  createLegalPracticeRouter,
} from "./modules/origination/api/partner-organization.router.js";
import {
  createAppraisalPartnerCaseRouter,
  createLegalPartnerCaseRouter,
} from "./modules/origination/api/partner-case.router.js";
import { createRequirePartnerCaseAssignment } from "./modules/origination/api/require-partner-case-assignment.js";
import {
  CreateAppraisalFirmService,
  CreateLegalPracticeService,
  ListAppraisalFirmsService,
  ListLegalPracticesService,
  UpdateAppraisalFirmStatusService,
  UpdateLegalPracticeStatusService,
} from "./modules/origination/application/partner-organization.service.js";
import type { PartnerOrganizationRepository } from "./modules/origination/repository/partner-organization.repository.js";
import { CreateDraftIntakeService } from "./modules/origination/application/create-draft-intake.service.js";
import {
  GetOwnCaseService,
  ListOwnCasesService,
} from "./modules/origination/application/read-own-cases.service.js";
import { SubmitInitialCaseService } from "./modules/origination/application/submit-initial-case.service.js";
import {
  AssignPartnerOrganizationService,
  CloseCaseService,
  GetCaseForOperationsService,
  ListCasesForOperationsService,
  PublishInformationRequestService,
  RecordFounderDecisionService,
} from "./modules/origination/application/operations-case.service.js";
import {
  GetCaseForPartnerService,
  ListCasesForPartnerService,
  RecordAppraisalService,
  RecordLegalStructuringService,
} from "./modules/origination/application/partner-case.service.js";
import {
  ListOwnInformationRequestsService,
  RespondToInformationRequestService,
} from "./modules/origination/application/respond-to-information-request.service.js";
import {
  ListCaseMessagesForOperationsService,
  ListOwnCaseMessagesService,
  PostCaseMessageForOperationsService,
  PostOwnCaseMessageService,
} from "./modules/origination/application/case-message.service.js";
import type { OriginationRepository } from "./modules/origination/repository/origination.repository.js";
import { createKycOperationsRouter } from "./modules/identity/api/kyc-operations.router.js";
import type { DiditClient } from "./modules/identity/application/didit-client.js";
import type {
  GetKycAccountForOperationsService,
  GetKycStatusService,
  ReceiveDiditWebhookService,
  StartKycSessionService,
  StartProofOfAddressSessionService,
} from "./modules/identity/application/kyc.service.js";
import type { DiditWebhookVerifier } from "./modules/identity/infrastructure/didit-webhook-verifier.js";
import { createDiditWebhookRouter, createKycRouter } from "./modules/identity/api/kyc.router.js";
import type { KycEligibilityReader } from "./modules/identity/repository/kyc-eligibility-reader.js";
import { createProfileRouter } from "./modules/profile/api/profile.router.js";
import { GetProfileService } from "./modules/profile/application/get-profile.service.js";
import type { ProtectedDisplayProfileProvider } from "./modules/profile/application/protected-display-profile.js";
import { UpdateAccountPreferencesService } from "./modules/profile/application/update-account-preferences.service.js";
import type { AccountPreferencesRepository } from "./modules/profile/repository/account-preferences.repository.js";
import type { ProfileRepository } from "./modules/profile/repository/profile.repository.js";
import { createLoginMethodsRouter } from "./modules/auth/api/login-methods.router.js";
import { UnlinkLoginMethodService } from "./modules/auth/application/unlink-login-method.service.js";
import type { LoginMethodUnlinker } from "./modules/auth/application/login-method-unlinker.js";
import { createWalletRouter } from "./modules/wallet/api/wallet.router.js";
import { RegisterWalletService } from "./modules/wallet/application/register-wallet.service.js";
import { GetWalletBalanceService, type WalletChainReader } from "./modules/wallet/application/get-wallet-balance.service.js";
import type { WalletRepository } from "./modules/wallet/repository/wallet.repository.js";
import type { PivTokenHoldingsReader } from "./modules/settlement/repository/settlement.repository.js";
import { createInvestorActivityRouter } from "./modules/investor-activity/api/investor-activity.router.js";
import {
  ListInvestorCurrentPositionsService,
  ListInvestorReservationsService,
} from "./modules/investor-activity/application/list-investor-activity.service.js";
import type { InvestorActivityRepository } from "./modules/investor-activity/repository/investor-activity.repository.js";
import { errorHandler } from "./shared/http/error-handler.js";
import { notFoundHandler } from "./shared/http/not-found.js";
import { requestContext } from "./shared/http/request-context.js";
import {
  BASELINE_RATE_LIMIT,
  TIGHTENED_RATE_LIMIT,
  createRateLimiter,
} from "./shared/http/rate-limit.js";
import type { RateLimitStore } from "./infrastructure/rate-limit/rate-limit-store.js";

export interface AppDependencies {
  databaseProbe: DatabaseProbe;
  offeringRepository: OfferingRepository;
  logger: Logger;
  // Browser-enforced, so distinct from auth's own AUTH_TRUSTED_ORIGINS check
  // (which rejects untrusted requests server-side) -- without this, a
  // browser blocks every cross-origin fetch, credentialed or not, before
  // the response ever reaches application code, regardless of what auth
  // itself would have allowed. Same source list as AUTH_TRUSTED_ORIGINS by
  // design (one list of trusted frontends, not two to keep in sync); a
  // non-http(s) entry like a mobile custom scheme is harmless here since a
  // browser's Origin header can never match one.
  corsOrigins: string[];
  authHandler?: RequestHandler;
  passkeyAssociations?: {
    appleTeamId?: string;
    appleBundleId: string;
    androidPackageName: string;
    androidCertificateFingerprints?: string[];
  };
  rateLimitStore?: RateLimitStore;
  /** Never true unless a human has done the live Coinbase EUR/Base verification AD-255 leaves open — see docs/investor-offering.md. Defaults false. */
  reservationFundingRailEnabled?: boolean;
  protectedApi?: {
    accounts: AccountRepository;
    sessions: SessionResolver;
    oauthBootstrapSessions?: SessionResolver;
    originationRepository: OriginationRepository;
    staffWebAuthnRepository: StaffWebAuthnRepository;
    staffWebAuthnCeremony: StaffWebAuthnCeremony;
    kyc?: {
      getStatus: GetKycStatusService;
      startSession: StartKycSessionService;
      startProofOfAddressSession: StartProofOfAddressSessionService | undefined;
      getAccountForOperations: GetKycAccountForOperationsService;
      // POST /webhooks/didit itself is unauthenticated (HMAC-signature
      // verified, not session-gated) -- grouped here anyway rather than as
      // its own top-level AppDependencies field, so the ~10 existing test
      // files that build a minimal AppDependencies with no KYC surface at
      // all don't also need to supply these.
      webhookVerifier: DiditWebhookVerifier;
      receiveWebhook: ReceiveDiditWebhookService;
    };
    profile?: {
      repository: ProfileRepository;
      displayProfiles: ProtectedDisplayProfileProvider;
      preferencesRepository: AccountPreferencesRepository;
    };
    loginMethods?: {
      unlinker: LoginMethodUnlinker;
    };
    wallet?: {
      repository: WalletRepository;
      kycEligibilityReader: KycEligibilityReader;
      // Both required together to read on-chain balances (dormant unless
      // the CHAIN_* env group is configured, same all-or-none gate the
      // write-side ChainClients in worker.ts already uses). Investor
      // wallets are self-custodied (AD-240): this can only ever read a
      // balance the investor's wallet already holds, never sign or move
      // anything.
      balances?: {
        pivTokenHoldingsReader: PivTokenHoldingsReader;
        chainReader: WalletChainReader;
      };
    };
    investorActivity?: {
      repository: InvestorActivityRepository;
    };
    disclosureDocuments?: {
      repository: DisclosureDocumentRepository;
      store: DisclosureDocumentStore;
    };
    reservations?: {
      repository: ReservationRepository;
      coinbase: CoinbaseCdpClient;
      blockchain: string;
      buildRedirectUrl: (reservationId: string) => string;
    };
    offeringOperations?: {
      repository: FinalizeOfferingRepository & MaterialityRepository & DisclosurePackRepository;
    };
    staffAccountLifecycle?: {
      repository: StaffAccountLifecycleRepository;
      administrator: StaffAccountAdministrator;
      recoveryRedirectUrl: string;
    };
    partnerOrganizations?: {
      repository: PartnerOrganizationRepository;
    };
    accountRecovery?: {
      repository: AccountRecoveryRepository;
      administrator: CustomerAccountAdministrator;
      didit: DiditClient;
      workflowId: string;
      callbackUrl: string;
      recoveryRedirectUrl: string;
      // Sent synchronously from the request, mirroring RecoverStaffAccountService's
      // and IssueStaffInvitationService's precedent for staff-initiated admin
      // actions — unlike the customer-facing reminder jobs in worker.ts, a staff
      // reviewer is directly waiting on the result here. Every call site wraps
      // this in try/catch as best-effort; only the administrator's own
      // passkey recovery email delivery is a hard failure.
      emailSender: EmailSender;
    };
    accountRecoveryCodes?: {
      repository: AccountRecoveryCodeRepository;
      administrator: CustomerAccountAdministrator;
      hashKey: string;
    };
    accountClosure?: {
      repository: AccountClosureRepository;
      administrator: CustomerAccountAdministrator;
    };
    staffInvitations?: {
      repository: StaffInvitationRepository;
      identities: StaffIdentityProvider;
      sendEmail: (input: {
        to: string;
        displayName: string;
        invitationUrl: string;
        expiresAt: Date;
      }) => Promise<void>;
      acceptUrl: string;
    };
    totp?: {
      repository: TotpRepository;
      provider: TotpProvider;
      backupCodeHashKey: string;
    };
    customerSessions?: {
      repository: CustomerSessionRepository;
      revoker: SessionRevoker;
    };
  };
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const listPublicOfferings = new ListPublicOfferingsService(dependencies.offeringRepository);
  const baselineRateLimiter =
    dependencies.rateLimitStore === undefined
      ? undefined
      : createRateLimiter(dependencies.rateLimitStore, BASELINE_RATE_LIMIT);
  const tightenedRateLimiter =
    dependencies.rateLimitStore === undefined
      ? undefined
      : createRateLimiter(dependencies.rateLimitStore, TIGHTENED_RATE_LIMIT);

  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(
    pinoHttp<Request, Response>({
      logger: dependencies.logger,
      genReqId: (_request, response) => String(response.locals.traceId),
      customAttributeKeys: { reqId: "trace_id" },
    }),
  );
  app.use((request, response, next) => {
    response.locals.logger = request.log;
    next();
  });
  app.use(cors({ origin: dependencies.corsOrigins, credentials: true }));
  app.use(helmet());
  if (dependencies.passkeyAssociations?.appleTeamId !== undefined) {
    app.get("/.well-known/apple-app-site-association", (_request, response) => {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.json({
        webcredentials: {
          apps: [
            `${dependencies.passkeyAssociations?.appleTeamId}.${dependencies.passkeyAssociations?.appleBundleId}`,
          ],
        },
      });
    });
  }
  if (dependencies.passkeyAssociations?.androidCertificateFingerprints !== undefined) {
    app.get("/.well-known/assetlinks.json", (_request, response) => {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.json([
        {
          relation: [
            "delegate_permission/common.handle_all_urls",
            "delegate_permission/common.get_login_creds",
          ],
          target: {
            namespace: "android_app",
            package_name: dependencies.passkeyAssociations?.androidPackageName,
            sha256_cert_fingerprints:
              dependencies.passkeyAssociations?.androidCertificateFingerprints,
          },
        },
      ]);
    });
  }
  if (dependencies.authHandler !== undefined) {
    app.all(
      "/api/auth/*splat",
      rejectDisabledAuthRoutes,
      ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
      dependencies.authHandler,
    );
  }
  app.use(express.json({ limit: "1mb", type: "application/json" }));

  app.use("/health", createHealthRouter(dependencies.databaseProbe));
  app.use(
    "/v1/offerings",
    ...(baselineRateLimiter === undefined ? [] : [baselineRateLimiter]),
    createOfferingRouter(listPublicOfferings),
  );
  if (dependencies.protectedApi !== undefined) {
    const requireAuthentication = createRequireAuthentication(
      dependencies.protectedApi.sessions,
      dependencies.protectedApi.accounts,
      baselineRateLimiter,
    );
    const requireOAuthBootstrapAuthentication = createRequireAuthentication(
      dependencies.protectedApi.oauthBootstrapSessions ?? dependencies.protectedApi.sessions,
      dependencies.protectedApi.accounts,
      baselineRateLimiter,
    );
    const requireAdminOperations = createRequireAdminOperations(
      dependencies.protectedApi.accounts,
    );
    const requireLegalPartner = createRequireLegalPartner(dependencies.protectedApi.accounts);
    const requireAppraisalPartner = createRequireAppraisalPartner(dependencies.protectedApi.accounts);
    const requireStaffIdentity = createRequireStaffIdentity(
      dependencies.protectedApi.accounts,
    );
    const requireStaffWebAuthn = createRequireStaffWebAuthn(
      dependencies.protectedApi.staffWebAuthnRepository,
    );
    const originationRepository = dependencies.protectedApi.originationRepository;
    const requireLegalPartnerCaseAssignment = createRequirePartnerCaseAssignment(
      "legal_partner",
      dependencies.protectedApi.accounts,
      originationRepository,
    );
    const requireAppraisalPartnerCaseAssignment = createRequirePartnerCaseAssignment(
      "appraisal_partner",
      dependencies.protectedApi.accounts,
      originationRepository,
    );
    const staffWebAuthnService = new StaffWebAuthnService(
      dependencies.protectedApi.staffWebAuthnRepository,
      dependencies.protectedApi.staffWebAuthnCeremony,
    );
    app.use(
      "/v1/offerings",
      createInvestorOfferingRouter(
        requireAuthentication,
        new GetInvestorOfferingService(
          dependencies.offeringRepository,
          undefined,
          dependencies.reservationFundingRailEnabled ?? false,
        ),
        dependencies.protectedApi.disclosureDocuments === undefined
          ? undefined
          : new DownloadDisclosureDocumentService(
              dependencies.protectedApi.disclosureDocuments.repository,
              dependencies.protectedApi.disclosureDocuments.store,
            ),
        dependencies.protectedApi.reservations === undefined
          ? undefined
          : new CreateReservationService(
              dependencies.offeringRepository,
              dependencies.protectedApi.reservations.repository,
              dependencies.protectedApi.reservations.coinbase,
              {
                blockchain: dependencies.protectedApi.reservations.blockchain,
                buildRedirectUrl: dependencies.protectedApi.reservations.buildRedirectUrl,
                fundingRailAvailable: dependencies.reservationFundingRailEnabled ?? false,
              },
            ),
        dependencies.protectedApi.offeringOperations === undefined
          ? undefined
          : new ReconfirmReservationService(dependencies.protectedApi.offeringOperations.repository),
        dependencies.protectedApi.customerSessions === undefined
          ? undefined
          : createRequireFreshAuthentication(
              dependencies.protectedApi.customerSessions.repository,
            ),
      ),
    );
    if (dependencies.protectedApi.offeringOperations !== undefined) {
      app.use(
        "/internal/v1/offerings",
        createOfferingOperationsRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          new FinalizeOfferingService(dependencies.protectedApi.offeringOperations.repository),
          new ClassifyMaterialityService(dependencies.protectedApi.offeringOperations.repository),
          new PublishDisclosurePackService(dependencies.protectedApi.offeringOperations.repository),
        ),
      );
    }
    if (dependencies.protectedApi.profile !== undefined) {
      const profile = dependencies.protectedApi.profile;
      app.use(
        "/v1/investor-profile",
        createProfileRouter(
          requireAuthentication,
          new GetProfileService(profile.repository, profile.displayProfiles),
          new UpdateAccountPreferencesService(profile.preferencesRepository),
        ),
      );
    }
    if (dependencies.protectedApi.loginMethods !== undefined) {
      const loginMethods = dependencies.protectedApi.loginMethods;
      app.use(
        "/v1/auth/login-methods",
        createLoginMethodsRouter(
          requireAuthentication,
          new UnlinkLoginMethodService(loginMethods.unlinker),
        ),
      );
    }
    if (dependencies.protectedApi.wallet !== undefined) {
      const wallet = dependencies.protectedApi.wallet;
      app.use(
        "/v1/investor-profile/wallet",
        createWalletRouter(
          requireAuthentication,
          new RegisterWalletService(wallet.repository, wallet.kycEligibilityReader),
          wallet.balances === undefined
            ? undefined
            : new GetWalletBalanceService(
                wallet.repository,
                wallet.balances.pivTokenHoldingsReader,
                wallet.balances.chainReader,
              ),
        ),
      );
    }
    if (dependencies.protectedApi.investorActivity !== undefined) {
      const investorActivity = dependencies.protectedApi.investorActivity;
      app.use(
        "/v1/investor-profile",
        createInvestorActivityRouter(
          requireAuthentication,
          new ListInvestorReservationsService(investorActivity.repository),
          new ListInvestorCurrentPositionsService(investorActivity.repository),
        ),
      );
    }
    if (dependencies.protectedApi.totp !== undefined) {
      const totp = dependencies.protectedApi.totp;
      app.use(
        "/v1/auth/totp",
        ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
        createTotpRouter(
          requireAuthentication,
          new EnrollTotpService(totp.repository, totp.provider, totp.backupCodeHashKey),
          new VerifyTotpService(totp.repository, totp.provider, totp.backupCodeHashKey),
          dependencies.protectedApi.customerSessions === undefined
            ? undefined
            : createRequireFreshAuthentication(
                dependencies.protectedApi.customerSessions.repository,
              ),
        ),
      );
    }
    if (dependencies.protectedApi.customerSessions !== undefined) {
      const customerSessions = dependencies.protectedApi.customerSessions;
      if (dependencies.protectedApi.accountRecoveryCodes !== undefined) {
        const recoveryCodes = dependencies.protectedApi.accountRecoveryCodes;
        app.use(
          "/v1/auth/recovery-code",
          ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
          createAccountRecoveryCodeRouter(
            requireAuthentication,
            requireOAuthBootstrapAuthentication,
            createRequireFreshAuthentication(customerSessions.repository),
            new RotateAccountRecoveryCodeService(
              recoveryCodes.repository,
              recoveryCodes.hashKey,
            ),
            new RedeemAccountRecoveryCodeService(
              recoveryCodes.repository,
              recoveryCodes.administrator,
              recoveryCodes.hashKey,
            ),
          ),
        );
      }
      app.use(
        "/v1/auth/sessions",
        createCustomerSessionRouter(
          requireAuthentication,
          new ListOwnSessionsService(customerSessions.repository),
          new RevokeOwnSessionService(customerSessions.repository, customerSessions.revoker),
          new RevokeAllOwnSessionsService(customerSessions.revoker),
        ),
      );
    }
    if (dependencies.protectedApi.kyc !== undefined) {
      const kyc = dependencies.protectedApi.kyc;
      app.use(
        "/v1/kyc",
        createKycRouter(
          requireAuthentication,
          kyc.getStatus,
          kyc.startSession,
          kyc.startProofOfAddressSession,
        ),
      );
      app.use(
        "/internal/v1/kyc-accounts",
        createKycOperationsRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          kyc.getAccountForOperations,
        ),
      );
      // Reversal (undoing the KYC microservice split): mounted directly
      // here now, unauthenticated like every other Didit-facing surface --
      // this used to live only in src/kyc-app.ts.
      app.use(
        "/webhooks/didit",
        createDiditWebhookRouter(kyc.webhookVerifier, kyc.receiveWebhook),
      );
    }
    if (dependencies.protectedApi.staffInvitations !== undefined) {
      const invitations = dependencies.protectedApi.staffInvitations;
      const issueInvitation = new IssueStaffInvitationService(
        invitations.repository,
        invitations.identities,
        invitations.sendEmail,
        invitations.acceptUrl,
      );
      const acceptInvitation = new AcceptStaffInvitationService(
        invitations.repository,
        invitations.identities,
      );
      app.use(
        "/v1/auth/staff-invitations",
        ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
        createPublicStaffInvitationRouter(acceptInvitation),
      );
      app.use(
        "/internal/v1/auth/staff-invitations",
        createInternalStaffInvitationRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          issueInvitation,
        ),
      );
    }
    if (dependencies.protectedApi.staffAccountLifecycle !== undefined) {
      const lifecycle = dependencies.protectedApi.staffAccountLifecycle;
      app.use(
        "/internal/v1/auth/staff-accounts",
        createStaffAccountLifecycleRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          new RecoverStaffAccountService(
            lifecycle.repository,
            lifecycle.administrator,
            lifecycle.recoveryRedirectUrl,
          ),
          new OffboardStaffAccountService(
            lifecycle.repository,
            lifecycle.administrator,
          ),
          new ListStaffAccountsService(lifecycle.repository),
          new GrantStaffRoleService(lifecycle.repository),
          new RevokeStaffRoleService(lifecycle.repository),
        ),
      );
    }
    if (dependencies.protectedApi.accountRecovery !== undefined) {
      const recovery = dependencies.protectedApi.accountRecovery;
      app.use(
        "/internal/v1/account-recovery-cases",
        createAccountRecoveryRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          new OpenAccountRecoveryCaseService(
            recovery.repository,
            recovery.administrator,
            recovery.emailSender,
          ),
          new CreateRecoveryDiditSessionService(recovery.repository, recovery.didit, {
            workflowId: recovery.workflowId,
            callbackUrl: recovery.callbackUrl,
          }),
          new GetAccountRecoveryCaseService(recovery.repository, recovery.didit),
          new RecordPrimaryRecoveryReviewService(recovery.repository),
          new DecideAccountRecoveryCaseService(recovery.repository, recovery.emailSender),
          new CompleteAccountRecoveryService(
            recovery.repository,
            recovery.administrator,
            recovery.emailSender,
            recovery.recoveryRedirectUrl,
          ),
        ),
      );
    }
    if (dependencies.protectedApi.accountClosure !== undefined) {
      const closure = dependencies.protectedApi.accountClosure;
      app.use(
        "/v1/auth/account-closure",
        createAccountClosureRouter(
          requireAuthentication,
          new RequestAccountClosureService(closure.repository),
          new CancelAccountClosureService(closure.repository),
        ),
      );
      app.use(
        "/internal/v1/account-closure-requests",
        createAccountClosureOperationsRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          new ListPendingAccountClosureRequestsService(closure.repository),
          new DecideAccountClosureRequestService(closure.repository, closure.administrator),
        ),
      );
    }
    app.use(
      "/internal/v1/auth/webauthn",
      ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
      createStaffWebAuthnRouter(
        requireAuthentication,
        requireStaffIdentity,
        staffWebAuthnService,
      ),
    );
    app.use(
      "/v1/origination-cases",
      createOriginationRouter(
        requireAuthentication,
        new CreateDraftIntakeService(originationRepository),
        new ListOwnCasesService(originationRepository),
        new GetOwnCaseService(originationRepository),
        new SubmitInitialCaseService(originationRepository),
        new ListOwnInformationRequestsService(originationRepository),
        new RespondToInformationRequestService(originationRepository),
        new ListOwnCaseMessagesService(originationRepository),
        new PostOwnCaseMessageService(originationRepository),
      ),
    );
    const partnerOrganizationRepository = dependencies.protectedApi.partnerOrganizations?.repository;
    app.use(
      "/internal/v1/origination-cases",
      createOriginationOperationsRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new ListCasesForOperationsService(originationRepository),
        new GetCaseForOperationsService(originationRepository),
        new PublishInformationRequestService(originationRepository),
        new RecordFounderDecisionService(originationRepository),
        new CloseCaseService(originationRepository),
        new ListCaseMessagesForOperationsService(originationRepository),
        new PostCaseMessageForOperationsService(originationRepository),
        partnerOrganizationRepository === undefined
          ? undefined
          : new AssignPartnerOrganizationService(originationRepository, partnerOrganizationRepository),
      ),
    );
    if (partnerOrganizationRepository !== undefined) {
      app.use(
        "/internal/v1/legal-practices",
        createLegalPracticeRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          new CreateLegalPracticeService(partnerOrganizationRepository),
          new ListLegalPracticesService(partnerOrganizationRepository),
          new UpdateLegalPracticeStatusService(partnerOrganizationRepository),
        ),
      );
      app.use(
        "/internal/v1/appraisal-firms",
        createAppraisalFirmRouter(
          requireAuthentication,
          requireAdminOperations,
          requireStaffWebAuthn,
          new CreateAppraisalFirmService(partnerOrganizationRepository),
          new ListAppraisalFirmsService(partnerOrganizationRepository),
          new UpdateAppraisalFirmStatusService(partnerOrganizationRepository),
        ),
      );
    }
    // Unconditional, unlike the admin CRUD/assignment surface above: these
    // only need the always-present accounts/originationRepository, not the
    // optional partnerOrganizations.repository (legal-practice/appraisal-firm
    // existence isn't looked up here -- createRequirePartnerCaseAssignment
    // already resolved the caller's own organization by the time a handler
    // runs).
    const getCaseForPartner = new GetCaseForPartnerService(originationRepository);
    app.use(
      "/internal/v1/legal-partner/cases",
      createLegalPartnerCaseRouter(
        requireAuthentication,
        requireLegalPartner,
        requireStaffWebAuthn,
        requireLegalPartnerCaseAssignment,
        new ListCasesForPartnerService(
          "legal_partner",
          dependencies.protectedApi.accounts,
          originationRepository,
        ),
        getCaseForPartner,
        new RecordLegalStructuringService(originationRepository),
      ),
    );
    app.use(
      "/internal/v1/appraisal-partner/cases",
      createAppraisalPartnerCaseRouter(
        requireAuthentication,
        requireAppraisalPartner,
        requireStaffWebAuthn,
        requireAppraisalPartnerCaseAssignment,
        new ListCasesForPartnerService(
          "appraisal_partner",
          dependencies.protectedApi.accounts,
          originationRepository,
        ),
        getCaseForPartner,
        new RecordAppraisalService(originationRepository),
      ),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
