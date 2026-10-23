import pino, { type Logger } from "pino";

export const REDACT_PATHS = [
  "req.headers['x-api-key']",
  'req.headers["x-api-key"]',
  "req.headers.authorization",
  "req.body.paymentMethod.token",
  "headers['x-api-key']",
  'headers["x-api-key"]',
  "headers.authorization",
  "paymentMethod.token",
  "*.token",
  "*.cvv",
  "*.pan",
  "*.cardNumber",
  "cvv",
  "pan",
  "cardNumber",
  "token",
];

export function createLogger(
  level: string,
  destination?: pino.DestinationStream,
): Logger {
  return pino(
    {
      level,
      redact: {
        paths: REDACT_PATHS,
        censor: "[Redacted]",
      },
    },
    destination,
  );
}
