import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  PAYPAL_API_BASE: z.string().url().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  PAYPAL_WEBHOOK_ID: z.string().default(""),
  PAYPAL_WEBHOOK_SKIP_VERIFY: z.enum(["true", "false"]).default("false"),
  WORKER_DISABLED: z.enum(["true", "false"]).default("false"),
  EVIDENCE_ALLOWED_HOSTS: z.string().default(""),
  ADMIN_EMAILS: z.string().default(""),
  PAYOUTS_ENABLED: z.enum(["true", "false"]).default("false"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  AI_PROVIDER: z.enum(["anthropic", "gemini"]).default("anthropic"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.6-flash"),
  AI_DAILY_BUDGET_USD: z.coerce.number().positive().default(5),
  AI_INPUT_PRICE_USD_PER_MTOK: z.coerce.number().positive().default(4),
  AI_OUTPUT_PRICE_USD_PER_MTOK: z.coerce.number().positive().default(20),
  AI_MODE: z.enum(["live", "replay"]).default("replay"),
  DEMO_MODE: z.enum(["true", "false"]).default("true"),
  DEMO_ADMIN_EMAIL: z.string().email().default("admin@holdfast.demo"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
}

const config = parsed.data;
const paypalUrl = new URL(config.PAYPAL_API_BASE);
if (paypalUrl.hostname !== "api-m.sandbox.paypal.com" || paypalUrl.protocol !== "https:") {
  throw new Error("HoldFast runs against the PayPal sandbox only (api-m.sandbox.paypal.com).");
}
if (config.NODE_ENV === "production" && config.PAYPAL_WEBHOOK_SKIP_VERIFY === "true") {
  throw new Error("PAYPAL_WEBHOOK_SKIP_VERIFY cannot be enabled in production.");
}
if (config.NODE_ENV === "production" && !config.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}

export const env = Object.freeze({
  ...config,
  SESSION_SECRET: config.SESSION_SECRET ?? "local-development-only-session-secret-32-chars",
  PAYOUTS_ENABLED: config.PAYOUTS_ENABLED === "true",
  PAYPAL_WEBHOOK_SKIP_VERIFY: config.PAYPAL_WEBHOOK_SKIP_VERIFY === "true",
  WORKER_DISABLED: config.WORKER_DISABLED === "true",
  EVIDENCE_ALLOWED_HOSTS: config.EVIDENCE_ALLOWED_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
  ADMIN_EMAILS: config.ADMIN_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
  DEMO_MODE: config.DEMO_MODE === "true",
});
