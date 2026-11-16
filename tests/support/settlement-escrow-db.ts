import { randomBytes } from "node:crypto";

import type { PrismaClient } from "../../src/generated/prisma/client.js";

/**
 * Records the offering's IPO escrow campaign as open, the readiness the
 * reservation gate requires (#176). Rows reference the PIV ON DELETE RESTRICT,
 * so delete them (deleteSettlementEscrowReadiness) before the PIV.
 */
export async function markSettlementEscrowReady(database: PrismaClient, pivId: string): Promise<void> {
  await database.ipoEscrowCampaign.create({
    data: {
      pivId,
      tokenId: BigInt(`0x${randomBytes(16).toString("hex")}`).toString(),
      escrowContractAddress: "0x00000000000000000000000000000000000E5c20",
      targetAmount: "1",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      treasuryAddress: "0x000000000000000000000000000000000000Ba5e",
    },
  });
}

export async function deleteSettlementEscrowReadiness(database: PrismaClient, pivIds: string[]): Promise<void> {
  await database.ipoEscrowCampaign.deleteMany({ where: { pivId: { in: pivIds } } });
}
