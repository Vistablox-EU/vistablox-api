import type { DatabaseClient } from "./prisma.js";

export interface DatabaseProbe {
  check(): Promise<void>;
}

export class PrismaDatabaseProbe implements DatabaseProbe {
  public constructor(private readonly database: DatabaseClient) {}

  public async check(): Promise<void> {
    await this.database.$queryRaw`SELECT 1`;
  }
}
