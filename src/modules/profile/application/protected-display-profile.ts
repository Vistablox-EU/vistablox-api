import type { ProtectedDisplayProfile } from "../../../infrastructure/cache/protected-profile-cache.js";

export type { ProtectedDisplayProfile };

export interface ProtectedDisplayProfileProvider {
  get(input: {
    accountId: string;
    diditReference: string | null;
    providerStatus: string | null;
  }): Promise<ProtectedDisplayProfile | null>;
}
