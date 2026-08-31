import type { AuthUserSnapshot } from "../../auth/infrastructure/better-auth.factory.js";
import type { AccountRepository } from "../repository/account.repository.js";

export class AccountProvisioner {
  public constructor(private readonly accounts: AccountRepository) {}

  public async onUserCreated(user: AuthUserSnapshot): Promise<void> {
    await this.accounts.provision({
      betterAuthUserId: user.id,
      protectedContactEmail: user.emailVerified ? user.email : null,
    });
  }

  public async onUserUpdated(user: AuthUserSnapshot): Promise<void> {
    if (!user.emailVerified) {
      return;
    }
    await this.accounts.syncVerifiedContactEmail({
      betterAuthUserId: user.id,
      protectedContactEmail: user.email,
    });
  }
}
