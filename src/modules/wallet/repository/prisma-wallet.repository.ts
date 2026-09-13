import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import {
  WalletAddressConflictError,
  type RegisteredWallet,
  type WalletRepository,
  type WalletStatusReader,
  type WalletStatusSnapshot,
} from "./wallet.repository.js";

export class PrismaWalletRepository implements WalletRepository, WalletStatusReader {
  public constructor(private readonly database: DatabaseClient) {}

  public async registerWallet(input: {
    accountId: string;
    walletAddress: string;
    registrationCommitment: string;
    requestedAt: Date;
  }): Promise<RegisteredWallet> {
    return this.database.$transaction(async (transaction) => {
      const existingForAccount = await transaction.walletRegistration.findUnique({
        where: { accountId: input.accountId },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
        },
      });
      if (existingForAccount !== null && existingForAccount.walletAddress === input.walletAddress) {
        // Idempotent replay of the same request: return the existing
        // registration rather than creating a second one.
        return existingForAccount;
      }

      // Checked before the account's own existing-registration state: if
      // this exact address already belongs to a *different* account, that's
      // the more specific conflict, regardless of whether the requesting
      // account also happens to already have a different address of its
      // own. Checking address_mismatch first would misreport a genuine
      // address-uniqueness violation as "you're trying to change your own
      // address" whenever both conditions happen to be true at once.
      const claimedByOther = await transaction.walletRegistration.findUnique({
        where: { walletAddress: input.walletAddress },
        select: { accountId: true },
      });
      if (claimedByOther !== null && claimedByOther.accountId !== input.accountId) {
        throw new WalletAddressConflictError("address_claimed");
      }

      if (existingForAccount !== null) {
        throw new WalletAddressConflictError("address_mismatch");
      }

      const created = await transaction.walletRegistration.create({
        data: {
          accountId: input.accountId,
          walletAddress: input.walletAddress,
          registrationCommitment: input.registrationCommitment,
          requestedAt: input.requestedAt,
        },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "settlement.wallet_registration_requested",
          resourceType: "account",
          resourceId: input.accountId,
          changes: { wallet_address: input.walletAddress },
          createdAt: input.requestedAt,
        },
      });
      return created;
    });
  }

  public async getStatus(accountId: string): Promise<WalletStatusSnapshot | null> {
    return this.database.walletRegistration.findUnique({
      where: { accountId },
      select: { requestedAt: true, registeredAt: true },
    });
  }

  public async findByAccountId(accountId: string): Promise<RegisteredWallet | null> {
    return this.database.walletRegistration.findUnique({
      where: { accountId },
      select: {
        walletAddress: true,
        registrationCommitment: true,
        requestedAt: true,
        registeredAt: true,
      },
    });
  }
}
