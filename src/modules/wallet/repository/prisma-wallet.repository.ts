import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { canonicalWalletAddress } from "../../../shared/domain/wallet-address.js";
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
    // The HTTP edge already canonicalises, but this is the persistence boundary
    // and other callers can skip the edge: whatever spelling arrives, one
    // address is stored, compared and audited in one form.
    const walletAddress = canonicalWalletAddress(input.walletAddress);
    return this.database.$transaction(async (transaction) => {
      const existingForAccount = await transaction.walletRegistration.findUnique({
        where: { accountId: input.accountId },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
          registrationTxHash: true,
          registrationBlockNumber: true,
        },
      });
      // The stored value is compared in canonical form too, so a row that
      // predates the lowercase check (or a spelling change on retry) is still a
      // replay and returns the stored row.
      if (
        existingForAccount !== null &&
        canonicalWalletAddress(existingForAccount.walletAddress) === walletAddress
      ) {
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
      //
      // lower(wallet_address) = $1 rather than Prisma's `mode: "insensitive"`:
      // that compiles to ILIKE, where % and _ in the value are wildcards, so an
      // address containing one would match other accounts' rows. The value is
      // already canonical (lowercase), and the column is lowercase too, but the
      // lower() keeps this correct for a row that predates the check.
      const claimedByOther = await transaction.$queryRaw<Array<{ account_id: string }>>`
        SELECT "account_id" FROM "settlement"."wallet_registrations"
        WHERE lower("wallet_address") = ${walletAddress} AND "account_id" <> ${input.accountId}
        LIMIT 1`;
      if (claimedByOther.length > 0) {
        throw new WalletAddressConflictError("address_claimed");
      }

      if (existingForAccount !== null) {
        throw new WalletAddressConflictError("address_mismatch");
      }

      const created = await transaction.walletRegistration.create({
        data: {
          accountId: input.accountId,
          walletAddress,
          registrationCommitment: input.registrationCommitment,
          requestedAt: input.requestedAt,
        },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
          registrationTxHash: true,
          registrationBlockNumber: true,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "settlement.wallet_registration_requested",
          resourceType: "account",
          resourceId: input.accountId,
          changes: { wallet_address: walletAddress },
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
        registrationTxHash: true,
        registrationBlockNumber: true,
      },
    });
  }

  public async reconcileWalletRegistration(input: { accountId: string; txHash: string; blockNumber: bigint; registeredAt: Date; actorAccountId: string }): Promise<RegisteredWallet> {
    return this.database.$transaction(async (transaction) => {
      const wallet = await transaction.walletRegistration.update({
        where: { accountId: input.accountId },
        data: { registeredAt: input.registeredAt, registrationTxHash: input.txHash, registrationBlockNumber: input.blockNumber },
        select: { walletAddress: true, registrationCommitment: true, requestedAt: true, registeredAt: true, registrationTxHash: true, registrationBlockNumber: true },
      });
      await transaction.auditLog.create({
        data: { id: `audit_${ulid()}`, actorAccountId: input.actorAccountId, action: "settlement.wallet_registration_reconciled", resourceType: "wallet_registration", resourceId: input.accountId, changes: { tx_hash: input.txHash, block_number: input.blockNumber.toString(), registered_at: input.registeredAt.toISOString() }, createdAt: input.registeredAt },
      });
      return wallet;
    });
  }
}
