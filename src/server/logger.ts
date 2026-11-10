import pino from "pino";
import { env } from "@/server/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ["password", "password_hash", "cookie", "authorization", "token", "client_secret", "secret"],
    censor: "[REDACTED]",
  },
});
