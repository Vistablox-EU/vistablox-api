import { createHmac, randomInt } from "node:crypto";

// AD-177 leaves the exact backup-code count undecided; ten one-time codes is
// a common, generous baseline that survives several lost-device events.
export const BACKUP_CODE_COUNT = 10;

const BACKUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BACKUP_CODE_LENGTH = 10;

export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateBackupCode());
}

function generateBackupCode(): string {
  let code = "";
  for (let index = 0; index < BACKUP_CODE_LENGTH; index += 1) {
    code += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
    if (index === 4) code += "-";
  }
  return code;
}

// AD-177: backup codes are hashed and marked consumed-on-use, mirroring
// password-storage discipline. HMAC (not a per-code salt) is deliberate: it
// keeps lookup a single indexed equality query instead of scanning every
// unconsumed code with a slow per-row comparison.
export function hashBackupCode(code: string, hashKey: string): string {
  return createHmac("sha256", hashKey).update(normalizeBackupCode(code)).digest("hex");
}

export function normalizeBackupCode(code: string): string {
  return code.trim().toUpperCase();
}
