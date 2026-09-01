export interface StoredIdempotentResponse {
  requestBodyHash: string;
  responseStatus: number;
  responseBody: unknown;
}

export interface IdempotencyStore {
  find(idempotencyKey: string, endpoint: string): Promise<StoredIdempotentResponse | null>;
  /**
   * Records the response for (idempotencyKey, endpoint). Returns the
   * winning row — usually the one just saved, but if a concurrent request
   * for the same key raced past `find` first, the row it already saved.
   */
  save(input: {
    idempotencyKey: string;
    endpoint: string;
    requestBodyHash: string;
    responseStatus: number;
    responseBody: unknown;
    accountId: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<StoredIdempotentResponse>;
}
