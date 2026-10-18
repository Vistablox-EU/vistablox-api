import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { FinalizeIpoEscrowCampaignsService } from "../src/modules/settlement/application/finalize-ipo-escrow-campaigns.service.js";
import type {
  PivPendingEscrowResolution,
  RecordEscrowMintedPositionInput,
} from "../src/modules/settlement/repository/settlement.repository.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import { CAMPAIGN_STATE_SUCCESSFUL, FakeEscrowChain, makeCapturingLogger } from "./support/escrow-mint-fakes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// The real repository on a real database, but only this suite's PIV: the
// shared test database holds other suites' tokenized, past-deadline PIVs that
// the unscoped query would also return.
class ScopedRepository extends PrismaSettlementRepository {
  public failNextPositionRecording = false;

  public constructor(
    database: ConstructorParameters<typeof PrismaSettlementRepository>[0],
    private readonly scope: PivPendingEscrowResolution[],
  ) {
    super(database);
  }

  public override async findPivsWithPassedIpoDeadline(): Promise<PivPendingEscrowResolution[]> {
    return this.scope;
  }

  public override async recordEscrowMintedPosition(
    input: RecordEscrowMintedPositionInput,
  ): Promise<{ positionId: string }> {
    if (this.failNextPositionRecording) {
      this.failNextPositionRecording = false;
      throw new Error("connection terminated before the position was written");
    }
    return super.recordEscrowMintedPosition(input);
  }
}

describe.skipIf(databaseUrl === undefined)(
  "FinalizeIpoEscrowCampaignsService against a real database (crash-safe, idempotent escrow mint)",
  () => {
    const suffix = randomUUID();
    const hex = suffix.replace(/-/g, "");
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");

    const propertyId = `property_escrow_mint_${suffix}`;
    const caseId = `case_escrow_mint_${suffix}`;
    const ownerAccountId = `account_escrow_mint_owner_${suffix}`;
    const ownerAuthUserId = `auth_escrow_mint_owner_${suffix}`;
    const tokenBase = BigInt(`0x${hex.slice(0, 12)}`) * 1000n + 500n;

    const investors = Array.from({ length: 5 }, (_, index) => ({
      accountId: `account_escrow_mint_${index}_${suffix}`,
      authUserId: `auth_escrow_mint_${index}_${suffix}`,
      wallet: `0x${index.toString(16)}${hex}${"0".repeat(7)}`.slice(0, 42),
      contribution: BigInt(100 + index * 10) * 1_000_000n,
    }));

    // A fresh PIV (and token id) per test, so no test sees another's intents or positions.
    let pivCounter = 0;
    const createdPivIds: string[] = [];
    const createdPropertyIds: string[] = [];
    const createdCaseIds: string[] = [];

    async function createPiv(): Promise<{ pivId: string; tokenId: string }> {
      const n = pivCounter++;
      const pivId = `piv_escrow_mint_${n}_${suffix}`;
      const tokenId = (tokenBase + BigInt(n)).toString();
      const property = `${propertyId}_${n}`;
      const intakeCase = `${caseId}_${n}`;
      await database.property.create({
        data: {
          id: property,
          countryCode: "RS",
          city: "Belgrade",
          addressLine: `Escrow Mint Test ${n} ${suffix}`,
          ownerDeclaredValueEur: "100000.00",
        },
      });
      await database.intakeCase.create({
        data: {
          id: intakeCase,
          propertyId: property,
          applicantAccountId: ownerAccountId,
          stage: "pre_offering_open",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
          ipoEndAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });
      await database.piv.create({ data: { id: pivId, propertyId: property, caseId: intakeCase, tokenId } });
      createdPivIds.push(pivId);
      createdPropertyIds.push(property);
      createdCaseIds.push(intakeCase);
      return { pivId, tokenId };
    }

    function build(options: { piv: { pivId: string; tokenId: string }; contributors: typeof investors }) {
      const contributions = new Map([
        [options.piv.tokenId, new Map(options.contributors.map((i) => [i.wallet, i.contribution]))],
      ]);
      const total = options.contributors.reduce((sum, i) => sum + i.contribution, 0n);
      const campaigns = new Map([
        [
          options.piv.tokenId,
          {
            targetAmount: total,
            totalRaised: total,
            deadline: 1n,
            treasury: "0xTREASURY",
            state: CAMPAIGN_STATE_SUCCESSFUL,
            swept: false,
          },
        ],
      ]);
      const contributors = new Map([[options.piv.tokenId, options.contributors.map((i) => i.wallet)]]);
      const chain = new FakeEscrowChain(campaigns, contributions, contributors);
      const repository = new ScopedRepository(database, [options.piv]);
      const { logger, entries } = makeCapturingLogger();
      const newService = () => new FinalizeIpoEscrowCampaignsService(repository, chain as never, logger);
      return { chain, repository, entries, campaigns, newService };
    }

    async function dbState(pivId: string) {
      const intents = await database.escrowMintIntent.findMany({ where: { pivId }, orderBy: { id: "asc" } });
      const positions = await database.positionLedger.findMany({ where: { pivId } });
      const events = await database.chainSettlementEvent.findMany({ where: { position: { pivId } } });
      return { intents, positions, events };
    }

    beforeAll(async () => {
      for (const [accountId, authUserId, label] of [
        [ownerAccountId, ownerAuthUserId, "owner"],
        ...investors.map((i, index) => [i.accountId, i.authUserId, `investor ${index}`] as const),
      ] as const) {
        await authPool.query(
          'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
          [authUserId, `Escrow Mint ${label}`, `${authUserId}@example.test`, true, "customer"],
        );
        await database.account.create({ data: { id: accountId, betterAuthUserId: authUserId } });
      }
      for (const investor of investors) {
        await database.walletRegistration.create({
          data: {
            accountId: investor.accountId,
            walletAddress: investor.wallet,
            registrationCommitment: `commitment_${investor.accountId}`,
            registeredAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        });
      }
    });

    afterAll(async () => {
      await database.chainSettlementEvent.deleteMany({ where: { position: { pivId: { in: createdPivIds } } } });
      await database.positionLedger.deleteMany({ where: { pivId: { in: createdPivIds } } });
      await database.escrowMintIntent.deleteMany({ where: { pivId: { in: createdPivIds } } });
      await database.piv.deleteMany({ where: { id: { in: createdPivIds } } });
      await database.intakeCase.deleteMany({ where: { id: { in: createdCaseIds } } });
      await database.property.deleteMany({ where: { id: { in: createdPropertyIds } } });
      await database.walletRegistration.deleteMany({
        where: { accountId: { in: investors.map((i) => i.accountId) } },
      });
      const accountIds = [ownerAccountId, ...investors.map((i) => i.accountId)];
      await database.account.deleteMany({ where: { id: { in: accountIds } } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1)', [
        [ownerAuthUserId, ...investors.map((i) => i.authUserId)],
      ]);
      await Promise.all([database.$disconnect(), authPool.end()]);
    });

    it("mints once and records once across a crash between the mint and the position write", async () => {
      const piv = await createPiv();
      const investor = investors[0]!;
      const h = build({ piv, contributors: [investor] });
      h.repository.failNextPositionRecording = true;

      const first = await h.newService().execute("req_first");

      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toContain(`piv_id=${piv.pivId}`);
      expect(h.chain.mints).toHaveLength(1);
      const afterCrash = await dbState(piv.pivId);
      expect(afterCrash.positions).toHaveLength(0);
      expect(afterCrash.events).toHaveLength(0);
      expect(afterCrash.intents).toHaveLength(1);
      expect(afterCrash.intents[0]).toMatchObject({ status: "mint_sent", mintTxHash: h.chain.mints[0]!.hash });

      const second = await h.newService().execute("req_second");

      expect(second.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.balanceOf(investor.wallet, BigInt(piv.tokenId))).toBe(investor.contribution);
      const recovered = await dbState(piv.pivId);
      expect(recovered.positions).toHaveLength(1);
      expect(recovered.positions[0]).toMatchObject({
        accountId: investor.accountId,
        escrowMintIntentId: recovered.intents[0]!.id,
        positionStatus: "active",
      });
      expect(recovered.events).toHaveLength(1);
      expect(recovered.events[0]).toMatchObject({ eventType: "mint", chainTxHash: h.chain.mints[0]!.hash });
      expect(recovered.intents[0]).toMatchObject({ status: "recorded" });
      expect(h.campaigns.get(piv.tokenId)!.swept).toBe(true);

      // A third run finds everything done and sends nothing.
      const third = await h.newService().execute("req_third");
      expect(third.positionsMinted).toBe(0);
      expect(h.chain.mints).toHaveLength(1);
      expect((await dbState(piv.pivId)).positions).toHaveLength(1);
    });

    it("records the mint that is on-chain when the process died before the mint's hash was stored", async () => {
      const piv = await createPiv();
      const investor = investors[1]!;
      const h = build({ piv, contributors: [investor] });
      h.chain.mintModes.push("mine-then-reject");

      const first = await h.newService().execute("req_first");

      expect(first.errors).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(1);
      const afterCrash = await dbState(piv.pivId);
      expect(afterCrash.intents[0]).toMatchObject({ status: "sending", mintTxHash: null });
      expect(afterCrash.positions).toHaveLength(0);

      const second = await h.newService().execute("req_second");

      expect(second.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      const recovered = await dbState(piv.pivId);
      expect(recovered.positions).toHaveLength(1);
      expect(recovered.events[0]).toMatchObject({ chainTxHash: h.chain.mints[0]!.hash });
      expect(recovered.intents[0]).toMatchObject({ status: "recorded", mintTxHash: h.chain.mints[0]!.hash });
    });

    it("records a mint that predates intents instead of minting it again", async () => {
      const piv = await createPiv();
      const investor = investors[2]!;
      const h = build({ piv, contributors: [investor] });
      const orphanHash = h.chain.seedUnrecordedMint(investor.wallet, BigInt(piv.tokenId), investor.contribution);

      const summary = await h.newService().execute("req_adopt");

      expect(summary.errors).toEqual([]);
      expect(h.chain.property.write.mint).not.toHaveBeenCalled();
      const state = await dbState(piv.pivId);
      expect(state.positions).toHaveLength(1);
      expect(state.events[0]).toMatchObject({ chainTxHash: orphanHash });
      expect(state.intents[0]).toMatchObject({ status: "recorded", mintTxHash: orphanHash, searchFromBlock: null });
    });

    it("mints each contributor exactly once when several runs overlap on the same campaign", async () => {
      const piv = await createPiv();
      const h = build({ piv, contributors: investors });

      await Promise.all(
        ["a", "b", "c", "d"].map((name) => h.newService().execute(`req_overlap_${name}`)),
      );

      // However the two interleaved, a later run settles whatever one of them left unfinished...
      const settle = await h.newService().execute("req_settle");
      expect(settle.errors).toEqual([]);

      // ...and in no interleaving did any contributor get more than one mint.
      expect(h.chain.mints).toHaveLength(investors.length);
      for (const investor of investors) {
        expect(h.chain.balanceOf(investor.wallet, BigInt(piv.tokenId))).toBe(investor.contribution);
      }
      const state = await dbState(piv.pivId);
      expect(state.intents).toHaveLength(investors.length);
      expect(state.intents.every((intent) => intent.status === "recorded")).toBe(true);
      expect(state.positions).toHaveLength(investors.length);
      expect(new Set(state.positions.map((p) => p.accountId)).size).toBe(investors.length);
      expect(state.events).toHaveLength(investors.length);
      expect(new Set(state.events.map((e) => e.chainTxHash)).size).toBe(investors.length);
      expect(h.campaigns.get(piv.tokenId)!.swept).toBe(true);
    });
  },
);
