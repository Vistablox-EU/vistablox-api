// Best-effort, coarse device label for the "Friendly support-facing device
// name" SESSION_MODEL.md calls for — not a full user-agent parser. Falls
// back to null (the field is optional) rather than guessing.
export function deriveDeviceLabel(userAgent: string | null): string | null {
  if (userAgent === null || userAgent.trim() === "") return null;

  const os = detectOperatingSystem(userAgent);
  const browser = detectBrowser(userAgent);
  if (os === null && browser === null) return null;
  if (os === null) return browser;
  if (browser === null) return os;
  return `${browser} on ${os}`;
}

function detectOperatingSystem(userAgent: string): string | null {
  if (/iphone|ipad/i.test(userAgent)) return "iOS";
  if (/android/i.test(userAgent)) return "Android";
  if (/mac os x/i.test(userAgent)) return "macOS";
  if (/windows/i.test(userAgent)) return "Windows";
  if (/linux/i.test(userAgent)) return "Linux";
  return null;
}

function detectBrowser(userAgent: string): string | null {
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/chrome\//i.test(userAgent) && !/chromium/i.test(userAgent)) return "Chrome";
  if (/crios\//i.test(userAgent)) return "Chrome";
  if (/firefox\//i.test(userAgent)) return "Firefox";
  if (/version\/.*safari\//i.test(userAgent)) return "Safari";
  return null;
}
