import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import helmet from "helmet";
import type Provider from "oidc-provider";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

import type { DatabaseProbe } from "./infrastructure/database/database-probe.js";
import type { AccountRepository } from "./modules/account/repository/account.repository.js";
import { createRequireAuthentication } from "./modules/auth/api/require-authentication.js";
import {
  createRequireAdminOperations,
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
  OffboardStaffAccountService,
  RecoverStaffAccountService,
} from "./modules/auth/application/staff-account-lifecycle.service.js";
import type { StaffAccountAdministrator } from "./modules/auth/application/staff-account-administrator.js";
import type { StaffAccountLifecycleRepository } from "./modules/auth/repository/staff-account-lifecycle.repository.js";
import { StaffWebAuthnService } from "./modules/auth/application/staff-webauthn.service.js";
import type { StaffWebAuthnCeremony } from "./modules/auth/application/staff-webauthn.ceremony.js";
import type { StaffWebAuthnRepository } from "./modules/auth/repository/staff-webauthn.repository.js";
import type { SessionResolver } from "./modules/auth/application/session-resolver.js";
import { createCustomerSessionRouter } from "./modules/auth/api/customer-session.router.js";
import {
  ListOwnSessionsService,
  RevokeOwnSessionService,
} from "./modules/auth/application/customer-session.service.js";
import type { CustomerSessionRepository } from "./modules/auth/repository/customer-session.repository.js";
import type { OidcGrantRepository } from "./modules/auth/repository/oidc-grant.repository.js";
import type { SessionRevoker } from "./modules/auth/application/session-revoker.js";
import { createOidcInteractionRouter } from "./modules/auth/api/oidc-interaction.router.js";
import { createTotpRouter } from "./modules/auth/api/totp.router.js";
import { EnrollTotpService, VerifyTotpService } from "./modules/auth/application/totp.service.js";
import type { TotpProvider } from "./modules/auth/infrastructure/otplib-totp.provider.js";
import type { TotpRepository } from "./modules/auth/repository/totp.repository.js";
import { createHealthRouter } from "./modules/health/health.router.js";
import {
  createInvestorOfferingRouter,
  createOfferingRouter,
} from "./modules/offering/api/offering.router.js";
import { GetInvestorOfferingService } from "./modules/offering/application/get-investor-offering.service.js";
import { DownloadDisclosureDocumentService } from "./modules/offering/application/download-disclosure-document.service.js";
import type { DisclosureDocumentStore } from "./modules/offering/application/disclosure-document-store.js";
import type { DisclosureDocumentRepository } from "./modules/offering/repository/disclosure-document.repository.js";
import { ListPublicOfferingsService } from "./modules/offering/application/list-public-offerings.service.js";
import type { OfferingRepository } from "./modules/offering/repository/offering.repository.js";
import { createOriginationRouter } from "./modules/origination/api/origination.router.js";
import { createOriginationOperationsRouter } from "./modules/origination/api/origination-operations.router.js";
import { CreateDraftIntakeService } from "./modules/origination/application/create-draft-intake.service.js";
import {
  GetOwnCaseService,
  ListOwnCasesService,
} from "./modules/origination/application/read-own-cases.service.js";
import { SubmitInitialCaseService } from "./modules/origination/application/submit-initial-case.service.js";
import {
  GetCaseForOperationsService,
  ListCasesForOperationsService,
  PublishInformationRequestService,
  RecordFounderDecisionService,
} from "./modules/origination/application/operations-case.service.js";
import {
  ListOwnInformationRequestsService,
  RespondToInformationRequestService,
} from "./modules/origination/application/respond-to-information-request.service.js";
import type { OriginationRepository } from "./modules/origination/repository/origination.repository.js";
import {
  GetKycStatusService,
  ProcessDiditWebhookService,
  StartProofOfAddressSessionService,
  StartKycSessionService,
} from "./modules/identity/application/kyc.service.js";
import type { DiditClient } from "./modules/identity/application/didit-client.js";
import {
  createDiditWebhookRouter,
  createKycRouter,
} from "./modules/identity/api/kyc.router.js";
import type { DiditWebhookVerifier } from "./modules/identity/infrastructure/didit-webhook-verifier.js";
import type { KycRepository } from "./modules/identity/repository/kyc.repository.js";
import { createInvestorProfileRouter } from "./modules/investor-profile/api/investor-profile.router.js";
import { GetInvestorProfileService } from "./modules/investor-profile/application/get-investor-profile.service.js";
import {
  ListInvestorCurrentPositionsService,
  ListInvestorReservationsService,
} from "./modules/investor-profile/application/list-investor-activity.service.js";
import type { ProtectedDisplayProfileProvider } from "./modules/investor-profile/application/protected-display-profile.js";
import type { InvestorProfileRepository } from "./modules/investor-profile/repository/investor-profile.repository.js";
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
  authHandler?: RequestHandler;
  rateLimitStore?: RateLimitStore;
  protectedApi?: {
    accounts: AccountRepository;
    sessions: SessionResolver;
    originationRepository: OriginationRepository;
    staffWebAuthnRepository: StaffWebAuthnRepository;
    staffWebAuthnCeremony: StaffWebAuthnCeremony;
    kyc?: {
      repository: KycRepository;
      didit: DiditClient;
      webhookVerifier: DiditWebhookVerifier;
      workflowId: string;
      callbackUrl: string;
      applicationId: string;
      environment: "sandbox" | "live";
      proofOfAddressWorkflowId?: string;
      invalidateDisplayProfile?: (accountId: string) => Promise<void>;
    };
    investorProfile?: {
      repository: InvestorProfileRepository;
      displayProfiles: ProtectedDisplayProfileProvider;
    };
    disclosureDocuments?: {
      repository: DisclosureDocumentRepository;
      store: DisclosureDocumentStore;
    };
    staffAccountLifecycle?: {
      repository: StaffAccountLifecycleRepository;
      administrator: StaffAccountAdministrator;
      recoveryRedirectUrl: string;
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
      oidcGrants?: OidcGrantRepository;
    };
    oidc?: {
      provider: Provider;
      betterAuthSessions: SessionResolver;
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
  app.use(helmet());
  if (dependencies.authHandler !== undefined) {
    app.all(
      "/api/auth/*splat",
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
    const requireAdminOperations = createRequireAdminOperations(
      dependencies.protectedApi.accounts,
    );
    const requireStaffIdentity = createRequireStaffIdentity(
      dependencies.protectedApi.accounts,
    );
    const requireStaffWebAuthn = createRequireStaffWebAuthn(
      dependencies.protectedApi.staffWebAuthnRepository,
    );
    const originationRepository = dependencies.protectedApi.originationRepository;
    const staffWebAuthnService = new StaffWebAuthnService(
      dependencies.protectedApi.staffWebAuthnRepository,
      dependencies.protectedApi.staffWebAuthnCeremony,
    );
    app.use(
      "/v1/offerings",
      createInvestorOfferingRouter(
        requireAuthentication,
        new GetInvestorOfferingService(dependencies.offeringRepository),
        dependencies.protectedApi.disclosureDocuments === undefined
          ? undefined
          : new DownloadDisclosureDocumentService(
              dependencies.protectedApi.disclosureDocuments.repository,
              dependencies.protectedApi.disclosureDocuments.store,
            ),
      ),
    );
    if (dependencies.protectedApi.investorProfile !== undefined) {
      const investorProfile = dependencies.protectedApi.investorProfile;
      app.use(
        "/v1/investor-profile",
        createInvestorProfileRouter(
          requireAuthentication,
          new GetInvestorProfileService(
            investorProfile.repository,
            investorProfile.displayProfiles,
          ),
          new ListInvestorReservationsService(investorProfile.repository),
          new ListInvestorCurrentPositionsService(investorProfile.repository),
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
        ),
      );
    }
    if (dependencies.protectedApi.customerSessions !== undefined) {
      const customerSessions = dependencies.protectedApi.customerSessions;
      app.use(
        "/v1/auth/sessions",
        createCustomerSessionRouter(
          requireAuthentication,
          new ListOwnSessionsService(customerSessions.repository, customerSessions.oidcGrants),
          new RevokeOwnSessionService(
            customerSessions.repository,
            customerSessions.revoker,
            customerSessions.oidcGrants,
          ),
        ),
      );
    }
    if (dependencies.protectedApi.oidc !== undefined) {
      const oidc = dependencies.protectedApi.oidc;
      app.use(
        "/oidc/interaction",
        createOidcInteractionRouter(oidc.provider, oidc.betterAuthSessions),
      );
      app.use("/oidc", oidc.provider.callback());
    }
    if (dependencies.protectedApi.kyc !== undefined) {
      const kyc = dependencies.protectedApi.kyc;
      app.use(
        "/v1/kyc",
        createKycRouter(
          requireAuthentication,
          new GetKycStatusService(kyc.repository),
          new StartKycSessionService(kyc.repository, kyc.didit, {
            workflowId: kyc.workflowId,
            callbackUrl: kyc.callbackUrl,
          }, undefined, kyc.invalidateDisplayProfile),
          kyc.proofOfAddressWorkflowId === undefined
            ? undefined
            : new StartProofOfAddressSessionService(
                kyc.repository,
                kyc.didit,
                {
                  workflowId: kyc.proofOfAddressWorkflowId,
                  callbackUrl: kyc.callbackUrl,
                },
              ),
        ),
      );
      app.use(
        "/webhooks/didit",
        createDiditWebhookRouter(
          kyc.webhookVerifier,
          new ProcessDiditWebhookService(kyc.repository, kyc.didit, {
            workflowId: kyc.workflowId,
            applicationId: kyc.applicationId,
            environment: kyc.environment,
            ...(kyc.proofOfAddressWorkflowId === undefined
              ? {}
              : { proofOfAddressWorkflowId: kyc.proofOfAddressWorkflowId }),
          }, kyc.invalidateDisplayProfile),
        ),
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
      ),
    );
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
      ),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
