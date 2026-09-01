import type { ProtectedDisplayProfile } from "../../modules/investor-profile/application/protected-display-profile.js";

export interface ProtectedProfileCache {
  get(accountId: string): Promise<ProtectedDisplayProfile | null>;
  set(accountId: string, profile: ProtectedDisplayProfile): Promise<void>;
  delete(accountId: string): Promise<void>;
}
