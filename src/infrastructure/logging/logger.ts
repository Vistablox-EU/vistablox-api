import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level,
    base: null,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-csrf-token']",
        "req.headers['x-internal-signature']",
        "res.headers['set-cookie']",
        "res.headers['set-auth-token']",
        "password",
        "token",
        "access_token",
        "refresh_token",
      ],
      censor: "[REDACTED]",
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
