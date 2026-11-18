import { type Express, type RequestHandler } from "express";
import type { Logger } from "pino";
import type { DatabaseProbe } from "../infrastructure/database/database-probe.js";
import type { EmailSender } from "../infrastructure/email/smtp-email-sender.js";
import type { AccountRepository } from "../modules/account/repository/account.repository.js";
import { type DpopEnforcementOptions } from "../modules/auth/api/shared/require-authentication.js";
import { IssueStaffInvitationService } from "../modules/auth/application/staff/staff-invitation.service.js";
import type { StaffIdentityProvider } from "../modules/auth/application/staff/staff-identity-provider.js";
import type { StaffInvitationRepository } from "../modules/auth/repository/staff/staff-invitation.repository.js";
import { RecoverStaffAccountService } from "../modules/auth/application/staff/staff-account-lifecycle.service.js";
import type { StaffAccountAdministrator } from "../modules/auth/application/staff/staff-account-administrator.js";
import type { StaffAccountLifecycleRepository } from "../modules/auth/repository/staff/staff-account-lifecycle.repository.js";
import type { CustomerAccountAdministrator } from "../modules/auth/application/shared/customer-account-administrator.js";
import type { AccountRecoveryRepository } from "../modules/auth/repository/staff/account-recovery.repository.js";
import type { AccountClosureRepository } from "../modules/auth/repository/shared/account-closure.repository.js";
import type { StaffWebAuthnCeremony } from "../modules/auth/application/staff/staff-webauthn.ceremony.js";
import type { StaffWebAuthnRepository } from "../modules/auth/repository/staff/staff-webauthn.repository.js";
import type { SessionResolver } from "../modules/auth/application/shared/session-resolver.js";
import { type AppConfig } from "../modules/auth/api/customer/device-auth.router.js";
import type { IssueDeviceChallengeService } from "../modules/auth/application/customer/device-challenge-issuance.service.js";
import type { AuthorizeSigningRequestService } from "../modules/auth/application/customer/authorize-signing-request.service.js";
import type { SigningRequestRepository } from "../modules/auth/repository/customer/signing-request.repository.js";
import type { DeviceRepository } from "../modules/auth/repository/customer/device.repository.js";
import type { VistaBloxAuth } from "../modules/auth/infrastructure/shared/better-auth.factory.js";
import { type DeviceReplacementConfig } from "../modules/auth/application/customer/device-replacement.service.js";
import type { DeviceReplacementRepository } from "../modules/auth/repository/customer/device-replacement.repository.js";
import type { CustomerSessionRepository } from "../modules/auth/repository/customer/customer-session.repository.js";
import type { SessionRevoker } from "../modules/auth/application/customer/session-revoker.js";
import type { OnrampLateEvidenceReviewRepository } from "../modules/offering/repository/onramp-late-evidence.repository.js";
import type { CoinbaseCdpClient } from "../modules/offering/application/coinbase-cdp-client.js";
import type { DisclosureDocumentStore, WritableDisclosureDocumentStore } from "../modules/offering/application/disclosure-document-store.js";
import type { OfferingDocumentRepository } from "../modules/offering/repository/offering-document.repository.js";
import type { OfferingPresentationRepository } from "../modules/offering/repository/offering-presentation.repository.js";
import type { MalwareScanner } from "../infrastructure/antivirus/clamav-scanner.js";
import type { DisclosureDocumentRepository } from "../modules/offering/repository/disclosure-document.repository.js";
import type { ReservationRepository } from "../modules/offering/repository/reservation.repository.js";
import type { FinalizeOfferingRepository } from "../modules/offering/repository/finalize-offering.repository.js";
import type { MaterialityRepository } from "../modules/offering/repository/materiality.repository.js";
import type { DisclosurePackRepository } from "../modules/offering/repository/disclosure-pack.repository.js";
import type { OfferingRepository } from "../modules/offering/repository/offering.repository.js";
import type { PartnerOrganizationRepository } from "../modules/intake/repository/partner-organization.repository.js";
import type { UploadCaseDocumentService } from "../modules/intake/application/upload-case-document.service.js";
import type { GetCaseDocumentService } from "../modules/intake/application/get-case-document.service.js";
import type { IntakeRepository } from "../modules/intake/repository/intake.repository.js";
import type { DiditClient } from "../modules/identity/application/didit-client.js";
import type { GetKycAccountForOperationsService, GetKycStatusService, ReceiveDiditWebhookService, StartKycSessionService, StartProofOfAddressSessionService } from "../modules/identity/application/kyc.service.js";
import type { GetKycDisplayProfileService } from "../modules/identity/application/kyc-display-profile.service.js";
import type { DiditWebhookVerifier } from "../modules/identity/infrastructure/didit-webhook-verifier.js";
import type { ReceiveCoinbaseOnrampWebhookService } from "../modules/offering/application/coinbase-onramp-webhook.service.js";
import type { CoinbaseOnrampWebhookVerifier } from "../modules/offering/infrastructure/coinbase-onramp-webhook-verifier.js";
import type { KycEligibilityReader } from "../modules/identity/repository/kyc-eligibility-reader.js";
import type { ProtectedDisplayProfileProvider } from "../modules/profile/application/protected-display-profile.js";
import type { AccountPreferencesRepository } from "../modules/profile/repository/account-preferences.repository.js";
import type { ProfileRepository } from "../modules/profile/repository/profile.repository.js";
import type { LoginMethodUnlinker } from "../modules/auth/application/customer/login-method-unlinker.js";
import { type WalletChainReader } from "../modules/wallet/application/get-wallet-balance.service.js";
import { type WalletTransferChainReader } from "../modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../modules/wallet/repository/wallet.repository.js";
import type { PivTokenHoldingsReader } from "../modules/settlement/repository/settlement.repository.js";
import type { InvestorActivityRepository } from "../modules/investor-activity/repository/investor-activity.repository.js";
import type { RateLimitStore } from "../infrastructure/rate-limit/rate-limit-store.js";
import type { IdempotencyStore } from "../infrastructure/idempotency/idempotency-store.js";

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
  // POST /webhooks/coinbase-onramp: mounted only when server.ts has both a
  // Coinbase CDP client and COINBASE_ONRAMP_WEBHOOK_SECRET.
  coinbaseOnrampWebhook?: {
    verifier: CoinbaseOnrampWebhookVerifier;
    receiveWebhook: ReceiveCoinbaseOnrampWebhookService;
  };
  passkeyAssociations?: {
    appleTeamId?: string;
    appleBundleId: string;
    androidPackageName: string;
    androidCertificateFingerprints?: string[];
  };
  // WebAuthn Related Origins: web origins other than the rpId's own host
  // (the admin console), published at /.well-known/webauthn. Staff-only;
  // derived by resolveWebAuthnSettings.
  webauthnRelatedOrigins?: string[];
  rateLimitStore?: RateLimitStore;
  idempotencyStore?: IdempotencyStore;
  // Express's `trust proxy`, from TRUST_PROXY (validated, and compiled by
  // Express itself, in environment.ts). Unset trusts no proxy: req.ip is the connecting address
  // and X-Forwarded-For is ignored, which is the safe default but, behind a
  // reverse proxy, makes every caller share the proxy's IP rate-limit bucket.
  trustProxy?: number | string[];
  /** Never true unless a human has done the live Coinbase EUR/Base verification AD-255 leaves open — see docs/investor-offering.md. Defaults false. */
  reservationFundingRailEnabled?: boolean;
  protectedApi?: {
    accounts: AccountRepository;
    sessions: SessionResolver;
    // Device binding (DPoP): used by requireAuthentication below; it's a
    // property of the session, not of which resolver found it. Undefined leaves DPoP
    // fully off -- bound sessions can't exist without the plugin/hook side
    // ever setting dpopJkt, so there's nothing for this to enforce.
    dpop?: DpopEnforcementOptions;
    intakeRepository: IntakeRepository;
    documentUpload?: UploadCaseDocumentService;
    documentDownload?: GetCaseDocumentService;
    // Unconditional, like intakeRepository above: the manual
    // reminder/force-expire operations routes need it to send the
    // applicant-response-reminder email SendApplicantResponseRemindersService
    // already sends on its own schedule (case-timer.service.ts). server.ts
    // always constructs one regardless of feature flags, so this is required
    // rather than optional.
    emailSender: EmailSender;
    staffWebAuthnRepository: StaffWebAuthnRepository;
    staffWebAuthnCeremony: StaffWebAuthnCeremony;
    kyc?: {
      getStatus: GetKycStatusService;
      startSession: StartKycSessionService;
      startProofOfAddressSession: StartProofOfAddressSessionService | undefined;
      getAccountForOperations: GetKycAccountForOperationsService;
      getDisplayProfile?: GetKycDisplayProfileService;
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
    // Requires customerSessions: replacing a pending claim needs the
    // fresh-authentication probe built from its repository (createApp throws
    // otherwise).
    wallet?: {
      repository: WalletRepository;
      kycEligibilityReader: KycEligibilityReader;
      // undefined until VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS is set --
      // see register-wallet.service.ts for why this is independent of the
      // rest of the chain-settlement config.
      walletRegistryContractAddress: string | undefined;
      walletRegistrationReconciler?: import("../modules/wallet/application/reconcile-wallet-registration.service.js").ReconcileWalletRegistrationService;
      // Both required together to read on-chain balances (dormant unless
      // the CHAIN_* env group is configured, same all-or-none gate the
      // write-side ChainClients in worker.ts already uses). Investor
      // wallets are self-custodied (AD-240): this can only ever read a
      // balance the investor's wallet already holds, never sign or move
      // anything.
      balances?: {
        pivTokenHoldingsReader: PivTokenHoldingsReader;
        chainReader: WalletChainReader & WalletTransferChainReader;
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
      /** Staff disclosure-document upload/list/download; only when document storage is configured. */
      documents?: {
        repository: OfferingDocumentRepository;
        store: WritableDisclosureDocumentStore;
        scanner: MalwareScanner;
      };
      /** Staff featured-flag and media management (PATCH /:offering_id/presentation). */
      presentation?: OfferingPresentationRepository;
    };
    /** Staff list of late onramp funding evidence, and the mark-reviewed action (AD-288, issue #168). */
    onrampLateEvidence?: {
      repository: OnrampLateEvidenceReviewRepository;
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
      singleReviewerMode: boolean;
      skipDiditInStaging: boolean;
      // Sent synchronously from the request, mirroring RecoverStaffAccountService's
      // and IssueStaffInvitationService's precedent for staff-initiated admin
      // actions — unlike the customer-facing reminder jobs in worker.ts, a staff
      // reviewer is directly waiting on the result here. Every call site wraps
      // this in try/catch as best-effort; only the administrator's own
      // passkey recovery email delivery is a hard failure.
      emailSender: EmailSender;
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
    customerSessions?: {
      repository: CustomerSessionRepository;
      revoker: SessionRevoker;
      /**
       * D3: when a device's DPoP key is revoked, cancels its pending/signed
       * signing requests (plan section 3.10). Optional so the mount compiles
       * even before the signing subsystem is wired.
       */
      cancelPendingSigningRequestsForDevice?: (dpopJkt: string) => Promise<number>;
    };
    // Device-key auth, step 1: single-device enrolment/login only (see
    // docs/plans/device-bound-auth-backend.md). `auth` is the same
    // VistaBloxAuth instance createBetterAuth returned with a `deviceAuth`
    // option set -- E2/L2 forward to its enrolVerify/loginVerify plugin
    // endpoints via auth.api.*, not a second HTTP hop.
    deviceAuth?: {
      auth: VistaBloxAuth;
      issueChallenge: IssueDeviceChallengeService;
      baseUrl: string;
      appConfig: AppConfig;
      signingRequests?: {
        requests: SigningRequestRepository;
        devices: Pick<DeviceRepository, "findByDpopJkt">;
        authorizes: AuthorizeSigningRequestService;
      };
    };
    deviceReplacement?: {
      repository: DeviceReplacementRepository;
      emailSender: EmailSender;
      config: DeviceReplacementConfig;
    };
  };
}

export type ProtectedApiDependencies = NonNullable<AppDependencies["protectedApi"]>;
