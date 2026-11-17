import {
  isSettlementBundleConfigured,
  type SettlementBundleEnvironment,
} from "../../../infrastructure/blockchain/settlement-bundle.js";
import type { PrismaOfferingRepositoryOptions } from "./prisma-offering.repository.js";

/**
 * The options the API process builds its PrismaOfferingRepository with, from
 * its environment. The one place that decides whether reservations wait for the
 * offering's settlement escrow (#176, AD-286): only where the settlement bundle
 * is configured, by the same predicate the worker uses to decide whether the
 * bundle exists (isSettlementBundleConfigured), so the API and the worker given
 * the same CHAIN_* settings agree. Where the bundle is dormant (AD-234) no
 * escrow contract is handed over and there is no gate.
 *
 * Kept as a function so a test can pin the wiring: a repository built with
 * defaults is dormant, and a server that stopped passing the escrow address
 * would silently take reservations for offerings that cannot settle.
 */
export function offeringRepositoryOptions(
  environment: SettlementBundleEnvironment & { MINIO_DISCLOSURES_BUCKET?: string | undefined },
): PrismaOfferingRepositoryOptions {
  return {
    disclosuresBucket: environment.MINIO_DISCLOSURES_BUCKET,
    settlementEscrowContractAddress: isSettlementBundleConfigured(environment)
      ? environment.VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS
      : undefined,
  };
}
