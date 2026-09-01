import Provider, { type Configuration, type JWKS } from "oidc-provider";
import type { Pool } from "pg";

import { createPostgresOidcAdapterFactory } from "./postgres-oidc-adapter.js";

export const OIDC_NATIVE_CLIENT_ID = "vistablox-native";

export interface OidcProviderFactoryOptions {
  /** VistaBlox API's own external base URL, e.g. https://api.vistablox.example */
  baseUrl: string;
  pool: Pool;
  /** Reuses the app-wide symmetric secret, matching the HMAC-keying precedent elsewhere in this module. */
  cookieSecret: string;
  jwks: JWKS;
  nativeRedirectUris: string[];
  secureCookies: boolean;
}

/**
 * The native-client Authorization Code + PKCE flow described in
 * SESSION_MODEL.md (AD-169): a single first-party VistaBlox client, PKCE
 * required (oidc-provider's own default for any `token_endpoint_auth_method:
 * "none"` client), rotating refresh tokens with built-in reuse detection,
 * and credential/MFA verification delegated to better-auth rather than a
 * second credential store — see oidc-interaction.router.ts.
 */
export function createOidcProvider(options: OidcProviderFactoryOptions): Provider {
  const issuer = new URL("/oidc", options.baseUrl).toString();

  const configuration: Configuration = {
    adapter: createPostgresOidcAdapterFactory(options.pool),
    clients: [
      {
        client_id: OIDC_NATIVE_CLIENT_ID,
        client_name: "VistaBlox Mobile/Desktop",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: options.nativeRedirectUris,
      },
    ],
    findAccount(_ctx, sub) {
      return {
        accountId: sub,
        async claims() {
          return { sub };
        },
      };
    },
    claims: {
      openid: ["sub"],
    },
    cookies: {
      keys: [options.cookieSecret],
      long: { secure: options.secureCookies },
      short: { secure: options.secureCookies },
    },
    jwks: options.jwks,
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      rpInitiatedLogout: { enabled: false },
    },
    rotateRefreshToken: true,
    ttl: {
      // Short-lived access token per SESSION_MODEL.md; refresh continuity is
      // the long-lived artifact and is what secure platform storage holds.
      AccessToken: 10 * 60,
      RefreshToken: 30 * 24 * 60 * 60,
      // Must be >= RefreshToken's ttl so the grant record outlives the
      // refresh-token chain it authorizes.
      Grant: 30 * 24 * 60 * 60,
    },
    interactions: {
      url(_ctx, interaction) {
        return `/oidc/interaction/${interaction.uid}`;
      },
    },
  };

  return new Provider(issuer, configuration);
}
