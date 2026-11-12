// Dummy sandbox credentials so payment paths can run against a stubbed fetch.
// Tests never reach PayPal: every PayPal-calling test replaces globalThis.fetch.
process.env.PAYPAL_CLIENT_ID ||= "test-client-id";
process.env.PAYPAL_CLIENT_SECRET ||= "test-client-secret";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.OPENROUTER_API_KEY ||= "test-openrouter-key";
