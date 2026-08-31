import pino, { type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-csrf-token']",
        "res.headers['set-cookie']",
        "password",
        "token",
        "access_token",
        "refresh_token",
      ],
      censor: "[REDACTED]",
    },
  });
}
