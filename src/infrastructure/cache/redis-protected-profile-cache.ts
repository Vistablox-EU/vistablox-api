import { z } from "zod";

import type { ProtectedDisplayProfile, ProtectedProfileCache } from "./protected-profile-cache.js";

interface RedisStringClient {
  readonly isReady: boolean;
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const cachedProfileSchema = z.object({
  given_name: z.string().min(1),
  family_name: z.string().min(1),
  full_display_name: z.string().min(1),
  didit_profile_last_synced_at: z.iso.datetime(),
}).strict();

export class RedisProtectedProfileCache implements ProtectedProfileCache {
  public constructor(private readonly client: RedisStringClient) {}

  public async get(accountId: string): Promise<ProtectedDisplayProfile | null> {
    this.requireReady();
    const value = await this.client.get(cacheKey(accountId));
    if (value === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      await this.client.del(cacheKey(accountId));
      return null;
    }
    const parsed = cachedProfileSchema.safeParse(decoded);
    if (!parsed.success) {
      await this.client.del(cacheKey(accountId));
      return null;
    }
    return {
      givenName: parsed.data.given_name,
      familyName: parsed.data.family_name,
      fullDisplayName: parsed.data.full_display_name,
      syncedAt: new Date(parsed.data.didit_profile_last_synced_at),
    };
  }

  public async set(
    accountId: string,
    profile: ProtectedDisplayProfile,
  ): Promise<void> {
    this.requireReady();
    await this.client.setEx(
      cacheKey(accountId),
      24 * 60 * 60,
      JSON.stringify({
        given_name: profile.givenName,
        family_name: profile.familyName,
        full_display_name: profile.fullDisplayName,
        didit_profile_last_synced_at: profile.syncedAt.toISOString(),
      }),
    );
  }

  public async delete(accountId: string): Promise<void> {
    this.requireReady();
    await this.client.del(cacheKey(accountId));
  }

  private requireReady(): void {
    if (!this.client.isReady) throw new Error("Protected profile cache unavailable");
  }
}

function cacheKey(accountId: string): string {
  return `kyc_display:${accountId}`;
}
