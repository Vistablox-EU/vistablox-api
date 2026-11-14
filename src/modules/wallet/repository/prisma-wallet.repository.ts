import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { isUniqueViolation } from "../../../infrastructure/database/unique-violation.js";
import {
  WalletAddressConflictError,
  WalletRegistrationChangedError,
  WalletReplacementFreshAuthenticationRequiredError,
  type RegisteredWallet,
  type WalletRepository,
  type WalletStatusReader,
  type WalletStatusSnapshot,
} from "./wallet.repository.js";

// The partial unique index created by
// 20261113150200_wallet_claims_confirmed_address_uniqueness:
// UNIQUE (lower(wallet_address)) WHERE registered_at IS NOT NULL.
const CONFIRMED_ADDRESS_INDEX = "wallet_registrations_confirmed_address_key";

const WALLET_SELECT = {
  walletAddress: true,
  registrationCommitment: true,
  requestedAt: true,
  registeredAt: true,
  registrationTxHash: true,
  registrationBlockNumber: true,
} as const;

/**
 * A wallet_registrations row with registered_at NULL is a pending claim: the
 * customer typed an address and nothing has proved they control it. A pending
 * claim is account-scoped. It never blocks another account, and its own
 * account may replace it with a different address, provided the caller's
 * session is fresh (see registerWallet). Only a CONFIRMED row binds
 * an address to an account, and the database enforces that through the
 * partial unique index above. Every address comparison is lower(col) =
 * lower($x) so rows written before the canonical lowercase form still match.
 */
export class PrismaWalletRepository implements WalletRepository, WalletStatusReader {
  public constructor(private readonly database: DatabaseClient) {}

  public async registerWallet(input: {
    accountId: string;
    walletAddress: string;
    registrationCommitment: string;
    requestedAt: Date;
    freshAuthentication: boolean;
  }): Promise<RegisteredWallet> {
    const address = input.walletAddress.trim().toLowerCase();
    return this.database.$transaction(async (transaction) => {
      // Two passes: the first can lose the insert race to a concurrent
      // request of the same account (ON CONFLICT DO NOTHING reports 0 rows),
      // in which case the second locks and reads the row that request
      // committed and decides against it.
      for (let pass = 0; pass < 2; pass += 1) {
        // Serialises this account's register/replace with the confirm and
        // reconcile writes, which take the same row lock through UPDATE. A
        // no-op while the account has no row yet.
        await transaction.$queryRaw`
          SELECT 1 FROM settlement.wallet_registrations
          WHERE account_id = ${input.accountId}
          FOR UPDATE
        `;
        const own = await transaction.walletRegistration.findUnique({
          where: { accountId: input.accountId },
          select: WALLET_SELECT,
        });
        // Trim + lower-case on the input, lower-case on the stored side: a case
        // or whitespace variant of the account's own address is a replay of it,
        // never a replacement, so it never needs freshness.
        const ownAddressMatches = own !== null && own.walletAddress.toLowerCase() === address;

        // Replacing the account's own PENDING claim with a different address
        // needs a fresh session. Decided here, under the row lock and on the
        // row just read, so no concurrent request can change the answer
        // between "is this a replacement?" and the write (a peek in the router
        // followed by a write could not promise that). Placed BEFORE the
        // owners query on purpose: the refusal then depends only on this
        // account's own row and this session's freshness, never on another
        // account's addresses, so a session that is not fresh cannot use the
        // replace path to ask which addresses are confirmed elsewhere. Nothing
        // has been written in this pass, and throwing rolls the transaction
        // back: the row, its commitment, requested_at and the audit trail stay
        // exactly as they were, and the refusal itself writes no audit row.
        if (own !== null && own.registeredAt === null && !ownAddressMatches && !input.freshAuthentication) {
          throw new WalletReplacementFreshAuthenticationRequiredError();
        }

        // Only CONFIRMED rows bind an address. Raw SQL rather than Prisma's
        // `mode: insensitive`, which emits ILIKE: wildcard semantics for _
        // and %, and no match for the partial index.
        const owners = await transaction.$queryRaw<Array<{ account_id: string }>>`
          SELECT account_id FROM settlement.wallet_registrations
          WHERE lower(wallet_address) = lower(${address})
            AND registered_at IS NOT NULL
        `;
        const claimedByOther = owners.some((owner) => owner.account_id !== input.accountId);

        // The more specific conflict wins: when the address is confirmed for a
        // different account, report that, even if this account's own
        // registration is also confirmed on another address.
        if (own !== null && own.registeredAt !== null) {
          if (ownAddressMatches) return own; // Idempotent replay of a confirmed registration.
          throw new WalletAddressConflictError(claimedByOther ? "address_claimed" : "address_mismatch");
        }
        // Also covers a replay of a pending claim whose address another
        // account has since confirmed: its commitment is dead, so do not
        // hand it out again.
        if (claimedByOther) throw new WalletAddressConflictError("address_claimed");

        if (own === null) {
          const inserted = await transaction.$executeRaw`
            INSERT INTO settlement.wallet_registrations
              (account_id, wallet_address, registration_commitment, requested_at)
            VALUES
              (${input.accountId}, ${address}, ${input.registrationCommitment}, ${input.requestedAt})
            ON CONFLICT (account_id) DO NOTHING
          `;
          if (inserted === 0) continue; // A concurrent request created the row; decide against it.
          await transaction.auditLog.create({
            data: {
              id: `audit_${ulid()}`,
              actorAccountId: input.accountId,
              action: "settlement.wallet_registration_requested",
              resourceType: "account",
              resourceId: input.accountId,
              changes: { wallet_address: address },
              createdAt: input.requestedAt,
            },
          });
          return transaction.walletRegistration.findUniqueOrThrow({
            where: { accountId: input.accountId },
            select: WALLET_SELECT,
          });
        }

        // Idempotent replay of the same pending claim: keep the commitment
        // the device may already have signed.
        if (ownAddressMatches) return own;

        // A pending claim of this account on another address: replace it in
        // place. The old commitment dies with the overwritten column, so the
        // event watcher can no longer match it.
        const replaced = await transaction.walletRegistration.update({
          where: { accountId: input.accountId, registeredAt: null },
          data: {
            walletAddress: address,
            registrationCommitment: input.registrationCommitment,
            requestedAt: input.requestedAt,
          },
          select: WALLET_SELECT,
        });
        await transaction.auditLog.create({
          data: {
            id: `audit_${ulid()}`,
            actorAccountId: input.accountId,
            action: "settlement.wallet_registration_replaced",
            resourceType: "account",
            resourceId: input.accountId,
            changes: { previous_wallet_address: own.walletAddress, wallet_address: address },
            createdAt: input.requestedAt,
          },
        });
        return replaced;
      }
      // Unreachable: the second pass always finds the row the concurrent
      // request committed, because the lock above waits for it.
      throw new Error("Wallet registration did not settle.");
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
      select: WALLET_SELECT,
    });
  }

  public async reconcileWalletRegistration(input: {
    accountId: string;
    expectedWalletAddress: string;
    expectedRegistrationCommitment: string;
    txHash: string;
    blockNumber: bigint;
    registeredAt: Date;
    actorAccountId: string;
  }): Promise<RegisteredWallet> {
    try {
      return await this.database.$transaction(async (transaction) => {
        // Compare-and-set on the identity the chain evidence was verified
        // against (address and commitment, exact). If the account replaced
        // its claim after the caller read it, nothing matches and the
        // unproven new address is not confirmed on the old address's
        // evidence. Deliberately not `registered_at IS NULL`: staff can still
        // attach evidence to a registration the watcher already confirmed.
        const updated = await transaction.walletRegistration.updateMany({
          where: {
            accountId: input.accountId,
            walletAddress: input.expectedWalletAddress,
            registrationCommitment: input.expectedRegistrationCommitment,
          },
          data: {
            registeredAt: input.registeredAt,
            registrationTxHash: input.txHash,
            registrationBlockNumber: input.blockNumber,
          },
        });
        if (updated.count === 0) throw new WalletRegistrationChangedError();
        await transaction.auditLog.create({
          data: {
            id: `audit_${ulid()}`,
            actorAccountId: input.actorAccountId,
            action: "settlement.wallet_registration_reconciled",
            resourceType: "wallet_registration",
            resourceId: input.accountId,
            changes: {
              tx_hash: input.txHash,
              block_number: input.blockNumber.toString(),
              registered_at: input.registeredAt.toISOString(),
            },
            createdAt: input.registeredAt,
          },
        });
        return transaction.walletRegistration.findUniqueOrThrow({
          where: { accountId: input.accountId },
          select: WALLET_SELECT,
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error, CONFIRMED_ADDRESS_INDEX)) throw error;
      // Another account confirmed this address first. The violation aborted
      // the transaction above, so the audit row is a separate statement.
      await this.recordConfirmationConflict(input);
      throw new WalletAddressConflictError("address_claimed");
    }
  }

  private async recordConfirmationConflict(input: {
    accountId: string;
    expectedWalletAddress: string;
    actorAccountId: string;
  }): Promise<void> {
    const address = input.expectedWalletAddress.toLowerCase();
    const holders = await this.database.$queryRaw<Array<{ account_id: string }>>`
      SELECT account_id FROM settlement.wallet_registrations
      WHERE lower(wallet_address) = lower(${address})
        AND registered_at IS NOT NULL
        AND account_id <> ${input.accountId}
      LIMIT 1
    `;
    await this.database.auditLog.create({
      data: {
        id: `audit_${ulid()}`,
        actorAccountId: input.actorAccountId,
        action: "settlement.wallet_registration_confirmation_conflict",
        resourceType: "wallet_registration",
        resourceId: input.accountId,
        changes: {
          wallet_address: address,
          holder_account_id: holders[0]?.account_id ?? null,
          source: "manual_reconcile",
        },
      },
    });
  }
}
