import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import helmet from "helmet";
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
import {
  AcceptStaffInvitationService,
  IssueStaffInvitationService,
} from "./modules/auth/application/staff-invitation.service.js";
import type { StaffIdentityProvider } from "./modules/auth/application/staff-identity-provider.js";
import type { StaffInvitationRepository } from "./modules/auth/repository/staff-invitation.repository.js";
import { StaffWebAuthnService } from "./modules/auth/application/staff-webauthn.service.js";
import type { StaffWebAuthnCeremony } from "./modules/auth/application/staff-webauthn.ceremony.js";
import type { StaffWebAuthnRepository } from "./modules/auth/repository/staff-webauthn.repository.js";
import type { SessionResolver } from "./modules/auth/application/session-resolver.js";
import { createHealthRouter } from "./modules/health/health.router.js";
import { createOfferingRouter } from "./modules/offering/api/offering.router.js";
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
import { errorHandler } from "./shared/http/error-handler.js";
import { notFoundHandler } from "./shared/http/not-found.js";
import { requestContext } from "./shared/http/request-context.js";

export interface AppDependencies {
  databaseProbe: DatabaseProbe;
  offeringRepository: OfferingRepository;
  logger: Logger;
  authHandler?: RequestHandler;
  protectedApi?: {
    accounts: AccountRepository;
    sessions: SessionResolver;
    originationRepository: OriginationRepository;
    staffWebAuthnRepository: StaffWebAuthnRepository;
    staffWebAuthnCeremony: StaffWebAuthnCeremony;
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
  };
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const listPublicOfferings = new ListPublicOfferingsService(dependencies.offeringRepository);

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
    app.all("/api/auth/*splat", dependencies.authHandler);
  }
  app.use(express.json({ limit: "1mb", type: "application/json" }));

  app.use("/health", createHealthRouter(dependencies.databaseProbe));
  app.use("/v1/offerings", createOfferingRouter(listPublicOfferings));
  if (dependencies.protectedApi !== undefined) {
    const requireAuthentication = createRequireAuthentication(
      dependencies.protectedApi.sessions,
      dependencies.protectedApi.accounts,
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
    app.use(
      "/internal/v1/auth/webauthn",
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
