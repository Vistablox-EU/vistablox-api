import type { AccountRepository } from "../repository/account.repository.js";

export class SearchAccountsByEmailService {
  public constructor(private readonly repository: AccountRepository) {}

  public async execute(email: string) {
    const accounts = await this.repository.findByEmail(email);
    return {
      data: accounts.map((account) => ({
        account_id: account.accountId,
        email: account.email,
        status: account.status,
      })),
    };
  }
}
