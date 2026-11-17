/**
 * Opens the IPO escrow campaign of every offering that is open for reservations
 * (docs/investor-offering.md, AD-286).
 *
 *   npm run settlement:open-ipo-escrow-campaigns             (dry run)
 *   npm run settlement:open-ipo-escrow-campaigns -- --confirm
 *
 * Run from a shell inside the worker container, where the container's own
 * environment (the CHAIN_* settings and the operator key) is read through the
 * normal loadEnvironment(). It refuses unless the configured chain is a
 * testnet. The dry run reads the chain and writes nothing.
 *
 * Exit codes: 0 done or dry run ok, 1 refused, or an offering failed or needs
 * manual action, 2 bad arguments.
 */
import "dotenv/config";

import { loadEnvironment } from "../config/environment.js";
import { createChainClients } from "../infrastructure/blockchain/chain-client.js";
import { PostgresOperatorKeyLock } from "../infrastructure/blockchain/operator-key-lock.js";
import { createPrismaClient } from "../infrastructure/database/prisma.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import {
  OpenIpoEscrowCampaignsCommandService,
  renderIpoEscrowActivationReport,
  resolveOpenIpoEscrowCampaignsStartup,
} from "../modules/settlement/application/open-ipo-escrow-campaigns-command.service.js";
import { OpenIpoEscrowCampaignService } from "../modules/settlement/application/open-ipo-escrow-campaign.service.js";
import { PrismaSettlementRepository } from "../modules/settlement/repository/prisma-settlement.repository.js";
import {
  OPEN_IPO_ESCROW_CAMPAIGNS_USAGE,
  parseOpenIpoEscrowCampaignsArguments,
} from "./open-ipo-escrow-campaigns-arguments.js";

const EXIT_REFUSED_OR_FAILED = 1;
const EXIT_USAGE = 2;

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<number> {
  const parsed = parseOpenIpoEscrowCampaignsArguments(process.argv.slice(2));
  if (!parsed.ok) {
    printError(`Error: ${parsed.error}\n`);
    printError(OPEN_IPO_ESCROW_CAMPAIGNS_USAGE);
    return EXIT_USAGE;
  }
  if (parsed.value.mode === "help") {
    print(OPEN_IPO_ESCROW_CAMPAIGNS_USAGE);
    return 0;
  }
  const { mode } = parsed.value;

  const environment = loadEnvironment();
  // The refusal (no bundle, not a testnet) is decided, and tested, in the command service's module.
  const startup = resolveOpenIpoEscrowCampaignsStartup(environment);
  if (!startup.ok) {
    printError(startup.message);
    return startup.exitCode;
  }
  const { chainConfig } = startup;

  const logger = createLogger(environment.LOG_LEVEL, process.stderr);
  const database = createPrismaClient(environment.DATABASE_URL);
  try {
    const repository = new PrismaSettlementRepository(database);
    const chain = createChainClients(chainConfig);
    const campaigns = new OpenIpoEscrowCampaignService(
      chain,
      repository,
      new PostgresOperatorKeyLock(database),
      logger,
    );
    const report = await new OpenIpoEscrowCampaignsCommandService(repository, campaigns, logger).run(mode);
    for (const line of renderIpoEscrowActivationReport(
      {
        chainNetwork: chainConfig.network,
        escrowContractAddress: chainConfig.ipoEscrowContractAddress ?? "",
        treasuryAddress: chainConfig.pivTreasuryAddress ?? "",
      },
      report,
    )) {
      print(line);
    }
    return report.exitCode;
  } catch (error) {
    printError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_REFUSED_OR_FAILED;
  } finally {
    await database.$disconnect().catch(() => undefined);
  }
}

process.exit(await main());
