-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "account";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "money";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "offering";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "origination";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "settlement";

-- CreateTable
CREATE TABLE "account"."accounts" (
    "account_id" TEXT NOT NULL,
    "better_auth_user_id" TEXT NOT NULL,
    "protected_contact_email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "account"."staff_role_assignments" (
    "assignment_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "legal_practice_id" TEXT,
    "appraisal_firm_id" TEXT,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "staff_role_assignments_pkey" PRIMARY KEY ("assignment_id")
);

-- CreateTable
CREATE TABLE "account"."login_methods" (
    "login_method_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "method_type" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linked_via_fresh_auth" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "login_methods_pkey" PRIMARY KEY ("login_method_id")
);

-- CreateTable
CREATE TABLE "account"."sessions" (
    "session_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "better_auth_user_id" TEXT NOT NULL,
    "better_auth_session_id" TEXT,
    "provider_grant_ref" TEXT,
    "auth_method_at_login" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_fresh_auth_at" TIMESTAMPTZ(6),
    "risk_state" TEXT NOT NULL DEFAULT 'normal',
    "device_label" TEXT,
    "user_agent_hash" TEXT,
    "initial_country_code" TEXT,
    "last_country_code" TEXT,
    "network_marker_hash" TEXT,
    "csrf_secret_hash" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" TEXT,
    "replaced_by_session_id" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "account"."account_recovery_cases" (
    "recovery_case_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fresh_didit_verification_ref" TEXT,
    "reviewed_by_primary" TEXT,
    "reviewed_by_secondary" TEXT,
    "cooldown_ends_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_recovery_cases_pkey" PRIMARY KEY ("recovery_case_id")
);

-- CreateTable
CREATE TABLE "identity"."kyc_eligibility" (
    "account_id" TEXT NOT NULL,
    "didit_reference" TEXT,
    "eligibility_state" TEXT NOT NULL DEFAULT 'not_started',
    "residence_country_code" TEXT,
    "tax_residence_country_code" TEXT,
    "proof_of_address_current_until" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "renewal_due_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_eligibility_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "identity"."kyc_eligibility_history" (
    "history_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "previous_state" TEXT NOT NULL,
    "new_state" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_eligibility_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateTable
CREATE TABLE "origination"."properties" (
    "property_id" TEXT NOT NULL,
    "property_type" TEXT NOT NULL DEFAULT 'residential',
    "country_code" TEXT NOT NULL,
    "city" TEXT,
    "address_line" TEXT,
    "land_registry_reference" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "owner_declared_value_eur" DECIMAL(15,2) NOT NULL,
    "has_existing_encumbrance" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("property_id")
);

-- CreateTable
CREATE TABLE "origination"."legal_practices" (
    "legal_practice_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "legal_practices_pkey" PRIMARY KEY ("legal_practice_id")
);

-- CreateTable
CREATE TABLE "origination"."appraisal_firms" (
    "appraisal_firm_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "appraisal_firms_pkey" PRIMARY KEY ("appraisal_firm_id")
);

-- CreateTable
CREATE TABLE "origination"."corridor_clearances" (
    "corridor_clearance_id" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "structure_pattern" TEXT NOT NULL,
    "distribution_posture" TEXT NOT NULL,
    "gate_status" TEXT NOT NULL DEFAULT 'not_yet_cleared',
    "counsel_memo_ref" TEXT,
    "cleared_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corridor_clearances_pkey" PRIMARY KEY ("corridor_clearance_id")
);

-- CreateTable
CREATE TABLE "origination"."origination_cases" (
    "case_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "applicant_account_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "can_reopen" BOOLEAN NOT NULL DEFAULT false,
    "current_submission_revision_id" TEXT,
    "rejected_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),
    "approved_for_final_offering_at" TIMESTAMPTZ(6),
    "rejection_reason_code" TEXT,
    "rejection_notes" TEXT,
    "founder_review_notes" TEXT,
    "reviewed_by_account_id" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "legal_execution_event_refs" TEXT[],
    "ipo_period_days" INTEGER,
    "ipo_end_at" TIMESTAMPTZ(6),
    "ipo_value_eur" DECIMAL(15,2),
    "legal_practice_id" TEXT,
    "legal_document_refs" TEXT[],
    "legal_structuring_completed_at" TIMESTAMPTZ(6),
    "appraisal_firm_id" TEXT,
    "appraisal_value_opinion_eur" DECIMAL(15,2),
    "appraisal_document_refs" TEXT[],
    "appraisal_completed_at" TIMESTAMPTZ(6),
    "post_ipo_structuring_completed_at" TIMESTAMPTZ(6),
    "exclusivity_commenced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "origination_cases_pkey" PRIMARY KEY ("case_id")
);

-- CreateTable
CREATE TABLE "origination"."submission_revisions" (
    "revision_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by_account_id" TEXT NOT NULL,
    "submission_data" JSONB NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "submission_revisions_pkey" PRIMARY KEY ("revision_id")
);

-- CreateTable
CREATE TABLE "origination"."documentary_screening_evidence" (
    "evidence_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "submission_revision_id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "document_ref" TEXT NOT NULL,
    "extract_dated" TIMESTAMPTZ(6),
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentary_screening_evidence_pkey" PRIMARY KEY ("evidence_id")
);

-- CreateTable
CREATE TABLE "origination"."workstream_assignment_events" (
    "event_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "workstream" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_account_id" TEXT,
    "target_legal_practice_id" TEXT,
    "target_appraisal_firm_id" TEXT,
    "target_reviewer_account_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workstream_assignment_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "origination"."case_integrity_flags" (
    "flag_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "flag_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "raised_by_account_id" TEXT,
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by_account_id" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,

    CONSTRAINT "case_integrity_flags_pkey" PRIMARY KEY ("flag_id")
);

-- CreateTable
CREATE TABLE "origination"."information_requests" (
    "request_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "requesting_workstream" TEXT NOT NULL,
    "proposed_by_account_id" TEXT NOT NULL,
    "proposed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "published_by_account_id" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "request_body" TEXT NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_type" TEXT,
    "resolving_revision_id" TEXT,

    CONSTRAINT "information_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "origination"."case_threads" (
    "thread_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "lane" TEXT NOT NULL,

    CONSTRAINT "case_threads_pkey" PRIMARY KEY ("thread_id")
);

-- CreateTable
CREATE TABLE "origination"."case_messages" (
    "message_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "author_account_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "origination"."legal_execution_events" (
    "execution_event_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL DEFAULT 'power_of_attorney',
    "requested_by_account_id" TEXT NOT NULL,
    "owner_confirmed_at" TIMESTAMPTZ(6),
    "outcome" TEXT,
    "outcome_document_ref" TEXT,
    "logged_at" TIMESTAMPTZ(6),

    CONSTRAINT "legal_execution_events_pkey" PRIMARY KEY ("execution_event_id")
);

-- CreateTable
CREATE TABLE "origination"."pivs" (
    "piv_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "legal_name" TEXT,
    "jurisdiction" TEXT,
    "registration_no" TEXT,
    "structure_pattern" TEXT NOT NULL DEFAULT 'default_aligned',
    "corridor_clearance_id" TEXT,
    "aif_gate_status" TEXT NOT NULL DEFAULT 'not_yet_cleared',
    "aif_counsel_memo_ref" TEXT,
    "incorporated_at" TIMESTAMPTZ(6),
    "deed_transfer_status" TEXT,
    "token_id" DECIMAL(78,0),

    CONSTRAINT "pivs_pkey" PRIMARY KEY ("piv_id")
);

-- CreateTable
CREATE TABLE "offering"."offerings" (
    "offering_id" TEXT NOT NULL,
    "piv_id" TEXT NOT NULL,
    "minimum_raise_eur" DECIMAL(15,2) NOT NULL,
    "target_raise_eur" DECIMAL(15,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pre_offering',
    "final_offering_published_at" TIMESTAMPTZ(6),
    "platform_rights_end_at" TIMESTAMPTZ(6),
    "effective_rights_end_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offerings_pkey" PRIMARY KEY ("offering_id")
);

-- CreateTable
CREATE TABLE "offering"."reservations" (
    "reservation_id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount_eur" DECIMAL(15,2) NOT NULL,
    "reservation_stage" TEXT NOT NULL DEFAULT 'initiated',
    "disclosure_pack_version_at_reservation" TEXT,
    "reconfirmed_at" TIMESTAMPTZ(6),
    "reservation_finalized_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("reservation_id")
);

-- CreateTable
CREATE TABLE "offering"."disclosure_packs" (
    "disclosure_pack_id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "disclosure_packs_pkey" PRIMARY KEY ("disclosure_pack_id")
);

-- CreateTable
CREATE TABLE "offering"."disclosure_documents" (
    "document_id" TEXT NOT NULL,
    "disclosure_pack_id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_ref" TEXT NOT NULL,
    "is_core_reading" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "disclosure_documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "offering"."materiality_records" (
    "materiality_record_id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "change_description" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "threshold_type" TEXT,
    "reset_triggered" BOOLEAN NOT NULL DEFAULT false,
    "classified_by_account_id" TEXT,
    "classified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "materiality_records_pkey" PRIMARY KEY ("materiality_record_id")
);

-- CreateTable
CREATE TABLE "money"."money_events" (
    "money_event_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_reference" TEXT,
    "capital_state" TEXT NOT NULL,
    "amount_eur" DECIMAL(15,2) NOT NULL,
    "amount_eurc" DECIMAL(20,6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciled_at" TIMESTAMPTZ(6),

    CONSTRAINT "money_events_pkey" PRIMARY KEY ("money_event_id")
);

-- CreateTable
CREATE TABLE "money"."treasury_sweep_batches" (
    "sweep_batch_id" TEXT NOT NULL,
    "sweep_date" DATE NOT NULL,
    "net_sweepable_eur" DECIMAL(15,2) NOT NULL,
    "dual_approval_ref_1" TEXT,
    "dual_approval_ref_2" TEXT,
    "eligibility_confirmed_at" TIMESTAMPTZ(6),
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "treasury_sweep_batches_pkey" PRIMARY KEY ("sweep_batch_id")
);

-- CreateTable
CREATE TABLE "money"."payouts" (
    "payout_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount_eur" DECIMAL(15,2) NOT NULL,
    "amount_eurc" DECIMAL(20,6) NOT NULL,
    "destination_wallet_address" TEXT NOT NULL,
    "chain_tx_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("payout_id")
);

-- CreateTable
CREATE TABLE "settlement"."wallet_registrations" (
    "account_id" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "registration_commitment" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registered_at" TIMESTAMPTZ(6),

    CONSTRAINT "wallet_registrations_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "settlement"."position_ledger" (
    "position_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "piv_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "unit_count" DECIMAL(20,6) NOT NULL,
    "cost_basis_eur" DECIMAL(15,2) NOT NULL,
    "position_status" TEXT NOT NULL DEFAULT 'pending_internal_settlement',
    "holder_wallet_address" TEXT,
    "activated_at" TIMESTAMPTZ(6),
    "redeemed_at" TIMESTAMPTZ(6),
    "redemption_proceeds_eur" DECIMAL(15,2),

    CONSTRAINT "position_ledger_pkey" PRIMARY KEY ("position_id")
);

-- CreateTable
CREATE TABLE "settlement"."chain_settlement_events" (
    "chain_event_id" TEXT NOT NULL,
    "position_id" TEXT,
    "event_type" TEXT NOT NULL,
    "token_contract_address" TEXT NOT NULL,
    "token_id" DECIMAL(78,0) NOT NULL,
    "chain_tx_hash" TEXT NOT NULL,
    "reconciled_at" TIMESTAMPTZ(6),

    CONSTRAINT "chain_settlement_events_pkey" PRIMARY KEY ("chain_event_id")
);

-- CreateTable
CREATE TABLE "audit"."audit_log" (
    "audit_log_id" TEXT NOT NULL,
    "actor_account_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "changes" JSONB,
    "ip_address_hash" TEXT,
    "user_agent_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("audit_log_id")
);

-- CreateTable
CREATE TABLE "audit"."idempotency_keys" (
    "idempotency_key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_body_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "account_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("idempotency_key","endpoint")
);

-- CreateTable
CREATE TABLE "platform"."settings" (
    "setting_key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("setting_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_better_auth_user_id_key" ON "account"."accounts"("better_auth_user_id");

-- CreateIndex
CREATE INDEX "idx_staff_role_assignments_account" ON "account"."staff_role_assignments"("account_id");

-- CreateIndex
CREATE INDEX "idx_staff_role_assignments_legal_practice" ON "account"."staff_role_assignments"("legal_practice_id");

-- CreateIndex
CREATE INDEX "idx_staff_role_assignments_appraisal_firm" ON "account"."staff_role_assignments"("appraisal_firm_id");

-- CreateIndex
CREATE UNIQUE INDEX "login_methods_account_id_method_type_key" ON "account"."login_methods"("account_id", "method_type");

-- CreateIndex
CREATE UNIQUE INDEX "login_methods_method_type_provider_subject_key" ON "account"."login_methods"("method_type", "provider_subject");

-- CreateIndex
CREATE INDEX "idx_sessions_account_status" ON "account"."sessions"("account_id", "status");

-- CreateIndex
CREATE INDEX "idx_sessions_replaced_by" ON "account"."sessions"("replaced_by_session_id");

-- CreateIndex
CREATE INDEX "idx_recovery_cases_account" ON "account"."account_recovery_cases"("account_id");

-- CreateIndex
CREATE INDEX "idx_recovery_cases_reviewed_primary" ON "account"."account_recovery_cases"("reviewed_by_primary");

-- CreateIndex
CREATE INDEX "idx_recovery_cases_reviewed_secondary" ON "account"."account_recovery_cases"("reviewed_by_secondary");

-- CreateIndex
CREATE INDEX "idx_kyc_history_account" ON "identity"."kyc_eligibility_history"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "corridor_clearances_country_code_structure_pattern_distribu_key" ON "origination"."corridor_clearances"("country_code", "structure_pattern", "distribution_posture");

-- CreateIndex
CREATE INDEX "idx_cases_property" ON "origination"."origination_cases"("property_id");

-- CreateIndex
CREATE INDEX "idx_cases_applicant" ON "origination"."origination_cases"("applicant_account_id");

-- CreateIndex
CREATE INDEX "idx_cases_current_revision" ON "origination"."origination_cases"("current_submission_revision_id");

-- CreateIndex
CREATE INDEX "idx_cases_legal_practice" ON "origination"."origination_cases"("legal_practice_id");

-- CreateIndex
CREATE INDEX "idx_cases_appraisal_firm" ON "origination"."origination_cases"("appraisal_firm_id");

-- CreateIndex
CREATE INDEX "idx_cases_stage" ON "origination"."origination_cases"("stage");

-- CreateIndex
CREATE INDEX "idx_revisions_submitted_by" ON "origination"."submission_revisions"("submitted_by_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_revisions_case_id_revision_number_key" ON "origination"."submission_revisions"("case_id", "revision_number");

-- CreateIndex
CREATE INDEX "idx_evidence_case" ON "origination"."documentary_screening_evidence"("case_id");

-- CreateIndex
CREATE INDEX "idx_evidence_revision" ON "origination"."documentary_screening_evidence"("submission_revision_id");

-- CreateIndex
CREATE INDEX "idx_workstream_events_actor" ON "origination"."workstream_assignment_events"("actor_account_id");

-- CreateIndex
CREATE INDEX "idx_workstream_events_target_practice" ON "origination"."workstream_assignment_events"("target_legal_practice_id");

-- CreateIndex
CREATE INDEX "idx_workstream_events_target_firm" ON "origination"."workstream_assignment_events"("target_appraisal_firm_id");

-- CreateIndex
CREATE INDEX "idx_workstream_events_target_reviewer" ON "origination"."workstream_assignment_events"("target_reviewer_account_id");

-- CreateIndex
CREATE INDEX "idx_workstream_events_case_stream" ON "origination"."workstream_assignment_events"("case_id", "workstream", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "idx_integrity_flags_case_status" ON "origination"."case_integrity_flags"("case_id", "status");

-- CreateIndex
CREATE INDEX "idx_integrity_flags_raised_by" ON "origination"."case_integrity_flags"("raised_by_account_id");

-- CreateIndex
CREATE INDEX "idx_integrity_flags_resolved_by" ON "origination"."case_integrity_flags"("resolved_by_account_id");

-- CreateIndex
CREATE INDEX "idx_info_requests_case_status" ON "origination"."information_requests"("case_id", "status");

-- CreateIndex
CREATE INDEX "idx_info_requests_status_due" ON "origination"."information_requests"("status", "due_at");

-- CreateIndex
CREATE INDEX "idx_info_requests_proposed_by" ON "origination"."information_requests"("proposed_by_account_id");

-- CreateIndex
CREATE INDEX "idx_info_requests_published_by" ON "origination"."information_requests"("published_by_account_id");

-- CreateIndex
CREATE INDEX "idx_info_requests_resolving_revision" ON "origination"."information_requests"("resolving_revision_id");

-- CreateIndex
CREATE INDEX "idx_case_threads_case" ON "origination"."case_threads"("case_id");

-- CreateIndex
CREATE INDEX "idx_case_messages_thread_created" ON "origination"."case_messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_case_messages_author" ON "origination"."case_messages"("author_account_id");

-- CreateIndex
CREATE INDEX "idx_execution_events_case" ON "origination"."legal_execution_events"("case_id");

-- CreateIndex
CREATE INDEX "idx_execution_events_requested_by" ON "origination"."legal_execution_events"("requested_by_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "pivs_property_id_key" ON "origination"."pivs"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "pivs_token_id_key" ON "origination"."pivs"("token_id");

-- Named reconciliation lookup from INDEXES_AND_OPTIMIZATION.md. The unique
-- index above enforces the invariant; this stable name documents the query path.
CREATE INDEX "idx_pivs_token_id" ON "origination"."pivs"("token_id");

-- CreateIndex
CREATE INDEX "idx_pivs_corridor_clearance" ON "origination"."pivs"("corridor_clearance_id");

-- CreateIndex
CREATE INDEX "idx_pivs_case" ON "origination"."pivs"("case_id");

-- CreateIndex
CREATE INDEX "idx_offerings_piv" ON "offering"."offerings"("piv_id");

-- CreateIndex
CREATE INDEX "idx_reservations_offering_stage" ON "offering"."reservations"("offering_id", "reservation_stage");

-- CreateIndex
CREATE INDEX "idx_reservations_account" ON "offering"."reservations"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "disclosure_packs_offering_id_version_key" ON "offering"."disclosure_packs"("offering_id", "version");

-- CreateIndex
CREATE INDEX "idx_disclosure_documents_pack" ON "offering"."disclosure_documents"("disclosure_pack_id");

-- CreateIndex
CREATE INDEX "idx_materiality_offering" ON "offering"."materiality_records"("offering_id");

-- CreateIndex
CREATE INDEX "idx_materiality_classified_by" ON "offering"."materiality_records"("classified_by_account_id");

-- CreateIndex
CREATE INDEX "idx_money_events_reservation_recorded" ON "money"."money_events"("reservation_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_sweep_batches_approval_ref_1" ON "money"."treasury_sweep_batches"("dual_approval_ref_1");

-- CreateIndex
CREATE INDEX "idx_sweep_batches_approval_ref_2" ON "money"."treasury_sweep_batches"("dual_approval_ref_2");

-- CreateIndex
CREATE INDEX "idx_payouts_account" ON "money"."payouts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_registrations_wallet_address_key" ON "settlement"."wallet_registrations"("wallet_address");

-- CreateIndex
CREATE INDEX "idx_position_ledger_reservation" ON "settlement"."position_ledger"("reservation_id");

-- CreateIndex
CREATE INDEX "idx_position_ledger_piv" ON "settlement"."position_ledger"("piv_id");

-- CreateIndex
CREATE INDEX "idx_position_ledger_account" ON "settlement"."position_ledger"("account_id");

-- CreateIndex
CREATE INDEX "idx_chain_events_position" ON "settlement"."chain_settlement_events"("position_id");

-- CreateIndex
CREATE INDEX "idx_chain_events_contract_token" ON "settlement"."chain_settlement_events"("token_contract_address", "token_id");

-- CreateIndex
CREATE INDEX "idx_audit_log_actor" ON "audit"."audit_log"("actor_account_id");

-- CreateIndex
CREATE INDEX "idx_audit_log_resource" ON "audit"."audit_log"("resource_type", "resource_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_idempotency_keys_account" ON "audit"."idempotency_keys"("account_id");

-- CreateIndex
CREATE INDEX "idx_idempotency_keys_expires" ON "audit"."idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "idx_settings_updated_by" ON "platform"."settings"("updated_by");

-- AddForeignKey
ALTER TABLE "account"."staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_legal_practice_id_fkey" FOREIGN KEY ("legal_practice_id") REFERENCES "origination"."legal_practices"("legal_practice_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_appraisal_firm_id_fkey" FOREIGN KEY ("appraisal_firm_id") REFERENCES "origination"."appraisal_firms"("appraisal_firm_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."login_methods" ADD CONSTRAINT "login_methods_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."sessions" ADD CONSTRAINT "sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."sessions" ADD CONSTRAINT "sessions_replaced_by_session_id_fkey" FOREIGN KEY ("replaced_by_session_id") REFERENCES "account"."sessions"("session_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."account_recovery_cases" ADD CONSTRAINT "account_recovery_cases_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."account_recovery_cases" ADD CONSTRAINT "account_recovery_cases_reviewed_by_primary_fkey" FOREIGN KEY ("reviewed_by_primary") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account"."account_recovery_cases" ADD CONSTRAINT "account_recovery_cases_reviewed_by_secondary_fkey" FOREIGN KEY ("reviewed_by_secondary") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."kyc_eligibility" ADD CONSTRAINT "kyc_eligibility_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."kyc_eligibility_history" ADD CONSTRAINT "kyc_eligibility_history_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."origination_cases" ADD CONSTRAINT "origination_cases_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "origination"."properties"("property_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."origination_cases" ADD CONSTRAINT "origination_cases_applicant_account_id_fkey" FOREIGN KEY ("applicant_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."origination_cases" ADD CONSTRAINT "origination_cases_reviewed_by_account_id_fkey" FOREIGN KEY ("reviewed_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."origination_cases" ADD CONSTRAINT "origination_cases_legal_practice_id_fkey" FOREIGN KEY ("legal_practice_id") REFERENCES "origination"."legal_practices"("legal_practice_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."origination_cases" ADD CONSTRAINT "origination_cases_appraisal_firm_id_fkey" FOREIGN KEY ("appraisal_firm_id") REFERENCES "origination"."appraisal_firms"("appraisal_firm_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."origination_cases" ADD CONSTRAINT "origination_cases_current_submission_revision_id_fkey" FOREIGN KEY ("current_submission_revision_id") REFERENCES "origination"."submission_revisions"("revision_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."submission_revisions" ADD CONSTRAINT "submission_revisions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."submission_revisions" ADD CONSTRAINT "submission_revisions_submitted_by_account_id_fkey" FOREIGN KEY ("submitted_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."documentary_screening_evidence" ADD CONSTRAINT "documentary_screening_evidence_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."documentary_screening_evidence" ADD CONSTRAINT "documentary_screening_evidence_submission_revision_id_fkey" FOREIGN KEY ("submission_revision_id") REFERENCES "origination"."submission_revisions"("revision_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."workstream_assignment_events" ADD CONSTRAINT "workstream_assignment_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."workstream_assignment_events" ADD CONSTRAINT "workstream_assignment_events_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."workstream_assignment_events" ADD CONSTRAINT "workstream_assignment_events_target_legal_practice_id_fkey" FOREIGN KEY ("target_legal_practice_id") REFERENCES "origination"."legal_practices"("legal_practice_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."workstream_assignment_events" ADD CONSTRAINT "workstream_assignment_events_target_appraisal_firm_id_fkey" FOREIGN KEY ("target_appraisal_firm_id") REFERENCES "origination"."appraisal_firms"("appraisal_firm_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."workstream_assignment_events" ADD CONSTRAINT "workstream_assignment_events_target_reviewer_account_id_fkey" FOREIGN KEY ("target_reviewer_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."case_integrity_flags" ADD CONSTRAINT "case_integrity_flags_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."case_integrity_flags" ADD CONSTRAINT "case_integrity_flags_raised_by_account_id_fkey" FOREIGN KEY ("raised_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."case_integrity_flags" ADD CONSTRAINT "case_integrity_flags_resolved_by_account_id_fkey" FOREIGN KEY ("resolved_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."information_requests" ADD CONSTRAINT "information_requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."information_requests" ADD CONSTRAINT "information_requests_proposed_by_account_id_fkey" FOREIGN KEY ("proposed_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."information_requests" ADD CONSTRAINT "information_requests_published_by_account_id_fkey" FOREIGN KEY ("published_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."information_requests" ADD CONSTRAINT "information_requests_resolving_revision_id_fkey" FOREIGN KEY ("resolving_revision_id") REFERENCES "origination"."submission_revisions"("revision_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."case_threads" ADD CONSTRAINT "case_threads_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."case_messages" ADD CONSTRAINT "case_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "origination"."case_threads"("thread_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."case_messages" ADD CONSTRAINT "case_messages_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."legal_execution_events" ADD CONSTRAINT "legal_execution_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."legal_execution_events" ADD CONSTRAINT "legal_execution_events_requested_by_account_id_fkey" FOREIGN KEY ("requested_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pivs" ADD CONSTRAINT "pivs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "origination"."properties"("property_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pivs" ADD CONSTRAINT "pivs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "origination"."origination_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pivs" ADD CONSTRAINT "pivs_corridor_clearance_id_fkey" FOREIGN KEY ("corridor_clearance_id") REFERENCES "origination"."corridor_clearances"("corridor_clearance_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering"."offerings" ADD CONSTRAINT "offerings_piv_id_fkey" FOREIGN KEY ("piv_id") REFERENCES "origination"."pivs"("piv_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering"."reservations" ADD CONSTRAINT "reservations_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"."offerings"("offering_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering"."reservations" ADD CONSTRAINT "reservations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering"."disclosure_packs" ADD CONSTRAINT "disclosure_packs_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"."offerings"("offering_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering"."disclosure_documents" ADD CONSTRAINT "disclosure_documents_disclosure_pack_id_fkey" FOREIGN KEY ("disclosure_pack_id") REFERENCES "offering"."disclosure_packs"("disclosure_pack_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering"."materiality_records" ADD CONSTRAINT "materiality_records_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"."offerings"("offering_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering"."materiality_records" ADD CONSTRAINT "materiality_records_classified_by_account_id_fkey" FOREIGN KEY ("classified_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money"."money_events" ADD CONSTRAINT "money_events_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "offering"."reservations"("reservation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money"."treasury_sweep_batches" ADD CONSTRAINT "treasury_sweep_batches_dual_approval_ref_1_fkey" FOREIGN KEY ("dual_approval_ref_1") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money"."treasury_sweep_batches" ADD CONSTRAINT "treasury_sweep_batches_dual_approval_ref_2_fkey" FOREIGN KEY ("dual_approval_ref_2") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money"."payouts" ADD CONSTRAINT "payouts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."wallet_registrations" ADD CONSTRAINT "wallet_registrations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."position_ledger" ADD CONSTRAINT "position_ledger_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "offering"."reservations"("reservation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."position_ledger" ADD CONSTRAINT "position_ledger_piv_id_fkey" FOREIGN KEY ("piv_id") REFERENCES "origination"."pivs"("piv_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."position_ledger" ADD CONSTRAINT "position_ledger_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."chain_settlement_events" ADD CONSTRAINT "chain_settlement_events_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "settlement"."position_ledger"("position_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit"."audit_log" ADD CONSTRAINT "audit_log_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."settings" ADD CONSTRAINT "settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Checks documented in CORE_TABLES.md that Prisma cannot represent in its schema DSL.
ALTER TABLE "origination"."properties"
ADD CONSTRAINT "properties_residential_only"
CHECK ("property_type" = 'residential');

ALTER TABLE "account"."staff_role_assignments"
ADD CONSTRAINT "staff_role_assignment_scope"
CHECK (
  ("role" = 'legal_partner' AND "legal_practice_id" IS NOT NULL AND "appraisal_firm_id" IS NULL) OR
  ("role" = 'appraisal_partner' AND "appraisal_firm_id" IS NOT NULL AND "legal_practice_id" IS NULL) OR
  ("role" = 'admin_operations' AND "legal_practice_id" IS NULL AND "appraisal_firm_id" IS NULL)
);

ALTER TABLE "account"."account_recovery_cases"
ADD CONSTRAINT "account_recovery_distinct_reviewers"
CHECK (
  "reviewed_by_primary" IS NULL OR
  "reviewed_by_secondary" IS NULL OR
  "reviewed_by_primary" <> "reviewed_by_secondary"
);

ALTER TABLE "money"."treasury_sweep_batches"
ADD CONSTRAINT "dual_approval_distinct_operators"
CHECK (
  "dual_approval_ref_1" IS NULL OR
  "dual_approval_ref_2" IS NULL OR
  "dual_approval_ref_1" <> "dual_approval_ref_2"
);
