import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "../database/prisma.js";
import type { IdempotencyStore, StoredIdempotentResponse } from "./idempotency-store.js";

export class PrismaIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly database: DatabaseClient) {}

  public async find(
    idempotencyKey: string,
    endpoint: string,
  ): Promise<StoredIdempotentResponse | null> {
    const row = await this.database.idempotencyKey.findUnique({
      where: { idempotencyKey_endpoint: { idempotencyKey, endpoint } },
    });
    return row === null ? null : toStoredResponse(row);
  }

  public async save(input: {
    idempotencyKey: string;
    endpoint: string;
    requestBodyHash: string;
    responseStatus: number;
    responseBody: unknown;
    accountId: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<StoredIdempotentResponse> {
    try {
      const row = await this.database.idempotencyKey.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          endpoint: input.endpoint,
          requestBodyHash: input.requestBodyHash,
          responseStatus: input.responseStatus,
          responseBody: input.responseBody as Prisma.InputJsonValue,
          accountId: input.accountId,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        },
      });
      return toStoredResponse(row);
    } catch (error) {
      // A concurrent request for the same key raced past find() and saved
      // first — that row, not this one, is the one every caller must agree
      // on, so read it back rather than surfacing a 500 for a genuine replay.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.find(input.idempotencyKey, input.endpoint);
        if (existing !== null) return existing;
      }
      throw error;
    }
  }
}

function toStoredResponse(row: {
  requestBodyHash: string;
  responseStatus: number;
  responseBody: unknown;
}): StoredIdempotentResponse {
  return {
    requestBodyHash: row.requestBodyHash,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
  };
}
