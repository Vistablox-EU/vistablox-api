import { createHmac, randomInt } from "node:crypto";

const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_GROUPS = 4;
const RECOVERY_CODE_GROUP_LENGTH = 5;

export function generateAccountRecoveryCode(): string {
  return Array.from({ length: RECOVERY_CODE_GROUPS }, () => {
    let group = "";
    for (let index = 0; index < RECOVERY_CODE_GROUP_LENGTH; index += 1) {
      group += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
    }
    return group;
  }).join("-");
}

export function normalizeAccountRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

export function hashAccountRecoveryCode(code: string, hashKey: string): string {
  return createHmac("sha256", hashKey)
    .update(normalizeAccountRecoveryCode(code))
    .digest("hex");
}
