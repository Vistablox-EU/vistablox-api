import { randomBytes } from "node:crypto";

import type { PrismaClient } from "../../src/generated/prisma/client.js";

/**
 * Records the offering's IPO escrow campaign as last observed Open, with its
 * deadline far ahead: the readiness the reservation gate requires where the
 * settlement bundle is configured (#176, AD-286). `state` and `deadlineAt`
 * record any other observation. Rows reference the PIV ON DELETE RESTRICT, so
 * delete them (deleteSettlementEscrowReadiness) before the PIV.
 */
export async function markSettlementEscrowReady(
  database: PrismaClient,
  pivId: string,
  observation: { state?: "not_opened" | "open" | "successful" | "failed"; deadlineAt?: Date } = {},
): Promise<void> {
  await database.ipoEscrowCampaign.create({
    data: {
      pivId,
      tokenId: BigInt(`0x${randomBytes(16).toString("hex")}`).toString(),
      escrowContractAddress: "0x00000000000000000000000000000000000E5c20",
      targetAmount: "1",
      deadlineAt: observation.deadlineAt ?? new Date("2099-01-01T00:00:00.000Z"),
      treasuryAddress: "0x000000000000000000000000000000000000Ba5e",
      observedState: observation.state ?? "open",
      observedAt: new Date(),
    },
  });
}

export async function deleteSettlementEscrowReadiness(database: PrismaClient, pivIds: string[]): Promise<void> {
  await database.ipoEscrowCampaign.deleteMany({ where: { pivId: { in: pivIds } } });
}
