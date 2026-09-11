export const MOBILE_PLATFORMS = ["android", "ios"] as const;

export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

export interface MobilePlatformPolicy {
  supportedPlatforms: readonly MobilePlatform[];
}

export const ANDROID_ONLY_MOBILE_PLATFORM_POLICY: MobilePlatformPolicy = {
  supportedPlatforms: ["android"],
};

export function isMobilePlatform(value: string): value is MobilePlatform {
  return (MOBILE_PLATFORMS as readonly string[]).includes(value);
}

export function isMobilePlatformSupported(
  platform: MobilePlatform,
  policy: MobilePlatformPolicy,
): boolean {
  return policy.supportedPlatforms.includes(platform);
}

/**
 * C1's `mobile_auth_platforms` map, derived from the same policy the
 * enrolment and login services enforce, so the advertised flags and the
 * server's actual behaviour can't disagree.
 */
export function mobileAuthPlatformFlags(policy: MobilePlatformPolicy): { android: boolean; ios: boolean } {
  return {
    android: isMobilePlatformSupported("android", policy),
    ios: isMobilePlatformSupported("ios", policy),
  };
}
