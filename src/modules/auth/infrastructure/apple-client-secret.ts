import { importPKCS8, SignJWT } from "jose";

const APPLE_AUDIENCE = "https://appleid.apple.com";
const APPLE_SECRET_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

export async function createAppleClientSecret(input: {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  now?: Date;
}): Promise<string> {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const privateKey = await importPKCS8(input.privateKey.replaceAll("\\n", "\n"), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: input.keyId })
    .setIssuer(input.teamId)
    .setSubject(input.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + APPLE_SECRET_LIFETIME_SECONDS)
    .sign(privateKey);
}
