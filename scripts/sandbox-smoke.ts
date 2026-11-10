import "dotenv/config";
import { env } from "../src/server/env";
import { verifySandboxCredentials } from "../src/server/paypal/client";

if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
  throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to verify the sandbox connection.");
}

await verifySandboxCredentials();
console.info("PayPal sandbox OAuth connection succeeded. No orders or payments were created.");
