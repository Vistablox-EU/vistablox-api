import type { ProtectedProfileCache } from "../cache/protected-profile-cache.js";
import type { DiditClient } from "../../modules/identity/application/didit-client.js";
import type {
  ProtectedDisplayProfile,
  ProtectedDisplayProfileProvider,
} from "../../modules/investor-profile/application/protected-display-profile.js";

export class DiditProtectedDisplayProfileProvider
  implements ProtectedDisplayProfileProvider
{
  public constructor(
    private readonly cache: ProtectedProfileCache,
    private readonly didit: DiditClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly onError: (error: unknown, operation: string) => void = () => {},
  ) {}

  public async get(input: {
    accountId: string;
    diditReference: string | null;
    providerStatus: string | null;
  }): Promise<ProtectedDisplayProfile | null> {
    if (input.diditReference === null || input.providerStatus !== "Approved") {
      await this.tryDelete(input.accountId);
      return null;
    }
    const cacheRead = await this.tryGet(input.accountId);
    if (!cacheRead.available) return null;
    const cached = cacheRead.profile;
    if (
      cached !== null &&
      this.clock().getTime() - cached.syncedAt.getTime() < 6 * 60 * 60 * 1_000
    ) {
      return cached;
    }

    let decision: Awaited<ReturnType<DiditClient["getDecision"]>>;
    try {
      decision = await this.didit.getDecision(input.diditReference);
    } catch (error) {
      this.onError(error, "didit_profile_fetch");
      return cached;
    }
    if (
      decision.sessionId !== input.diditReference ||
      decision.sessionKind === "business" ||
      decision.vendorData !== input.accountId ||
      decision.status !== "Approved" ||
      decision.verifiedDisplayProfile === null
    ) {
      await this.tryDelete(input.accountId);
      return null;
    }

    const refreshed = {
      ...decision.verifiedDisplayProfile,
      syncedAt: this.clock(),
    };
    return (await this.trySet(input.accountId, refreshed)) ? refreshed : cached;
  }

  private async tryGet(accountId: string): Promise<
    | { available: true; profile: ProtectedDisplayProfile | null }
    | { available: false }
  > {
    try {
      return { available: true, profile: await this.cache.get(accountId) };
    } catch (error) {
      this.onError(error, "profile_cache_read");
      return { available: false };
    }
  }

  private async trySet(
    accountId: string,
    profile: ProtectedDisplayProfile,
  ): Promise<boolean> {
    try {
      await this.cache.set(accountId, profile);
      return true;
    } catch (error) {
      this.onError(error, "profile_cache_write");
      return false;
    }
  }

  private async tryDelete(accountId: string): Promise<void> {
    try {
      await this.cache.delete(accountId);
    } catch (error) {
      this.onError(error, "profile_cache_delete");
    }
  }
}

export class UnavailableProtectedDisplayProfileProvider
  implements ProtectedDisplayProfileProvider
{
  public async get(): Promise<null> {
    return null;
  }
}
