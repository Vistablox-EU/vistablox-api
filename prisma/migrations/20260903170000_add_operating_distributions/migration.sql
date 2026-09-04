-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "rental";

-- CreateTable
CREATE TABLE "rental"."rent_collections" (
    "rent_collection_id" TEXT NOT NULL,
    "piv_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "gross_rent_collected_eur" DECIMAL(15,2) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "rent_collections_pkey" PRIMARY KEY ("rent_collection_id")
);

-- CreateTable
CREATE TABLE "settlement"."operating_distributions" (
    "operating_distribution_id" TEXT NOT NULL,
    "piv_id" TEXT NOT NULL,
    "rent_collection_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "record_date" DATE NOT NULL,
    "gross_rent_eur" DECIMAL(15,2) NOT NULL,
    "management_fee_eur" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "other_expenses_eur" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "reserve_holdback_eur" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "distributable_net_eur" DECIMAL(15,2) NOT NULL,
    "total_units_at_record_date" DECIMAL(20,6) NOT NULL,
    "amount_per_unit_eur" DECIMAL(15,6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'calculated',
    "calculated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by" TEXT,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "operating_distributions_pkey" PRIMARY KEY ("operating_distribution_id")
);

-- CreateTable
CREATE TABLE "settlement"."operating_distribution_entries" (
    "operating_distribution_entry_id" TEXT NOT NULL,
    "operating_distribution_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "unit_count_at_record_date" DECIMAL(20,6) NOT NULL,
    "amount_eurc" DECIMAL(15,6) NOT NULL,
    "destination_wallet_address" TEXT NOT NULL,
    "chain_tx_hash" TEXT,
    "paid_at" TIMESTAMPTZ(6),

    CONSTRAINT "operating_distribution_entries_pkey" PRIMARY KEY ("operating_distribution_entry_id")
);

-- CreateIndex
CREATE INDEX "idx_rent_collections_piv" ON "rental"."rent_collections"("piv_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rent_collections_piv_period" ON "rental"."rent_collections"("piv_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "operating_distributions_rent_collection_id_key" ON "settlement"."operating_distributions"("rent_collection_id");

-- CreateIndex
CREATE INDEX "idx_operating_distributions_piv" ON "settlement"."operating_distributions"("piv_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_operating_distributions_piv_period" ON "settlement"."operating_distributions"("piv_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "idx_distribution_entries_distribution" ON "settlement"."operating_distribution_entries"("operating_distribution_id");

-- CreateIndex
CREATE INDEX "idx_distribution_entries_position" ON "settlement"."operating_distribution_entries"("position_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_distribution_entries_dist_position" ON "settlement"."operating_distribution_entries"("operating_distribution_id", "position_id");

-- AddForeignKey
ALTER TABLE "rental"."rent_collections" ADD CONSTRAINT "rent_collections_piv_id_fkey" FOREIGN KEY ("piv_id") REFERENCES "origination"."pivs"("piv_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental"."rent_collections" ADD CONSTRAINT "rent_collections_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."operating_distributions" ADD CONSTRAINT "operating_distributions_piv_id_fkey" FOREIGN KEY ("piv_id") REFERENCES "origination"."pivs"("piv_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."operating_distributions" ADD CONSTRAINT "operating_distributions_rent_collection_id_fkey" FOREIGN KEY ("rent_collection_id") REFERENCES "rental"."rent_collections"("rent_collection_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."operating_distributions" ADD CONSTRAINT "operating_distributions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "account"."accounts"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."operating_distribution_entries" ADD CONSTRAINT "operating_distribution_entries_operating_distribution_id_fkey" FOREIGN KEY ("operating_distribution_id") REFERENCES "settlement"."operating_distributions"("operating_distribution_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement"."operating_distribution_entries" ADD CONSTRAINT "operating_distribution_entries_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "settlement"."position_ledger"("position_id") ON DELETE RESTRICT ON UPDATE CASCADE;
