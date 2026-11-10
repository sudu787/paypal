import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import { env } from "@/server/env";

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8_000;

function ipToV4Number(address: string) {
  return address.split(".").reduce((value, part) => (value << BigInt(8)) + BigInt(Number(part)), BigInt(0));
}

function inV4Range(address: string, base: string, bits: number) {
  const shift = BigInt(32 - bits);
  return (ipToV4Number(address) >> shift) === (ipToV4Number(base) >> shift);
}

export function isPublicEvidenceAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, bits]) => inV4Range(address, base, bits));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::") || normalized.startsWith("::ffff:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8") || normalized.startsWith("2001:10") || normalized.startsWith("2001:20") || normalized.startsWith("2002:") || normalized.startsWith("3fff:")) return false;
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff;
}

function allowedHosts() {
  const hosts = new Set(env.EVIDENCE_ALLOWED_HOSTS);
  try { hosts.add(new URL(env.APP_URL).hostname.toLowerCase()); } catch { /* startup validation already handles the app URL */ }
  return hosts;
}

export function validateEvidenceUrl(value: string, hosts = allowedHosts()) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Evidence URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Evidence URLs must use HTTPS on the standard port.");
  const host = url.hostname.toLowerCase();
  if (!hosts.has(host) || isIP(host)) throw new Error("This evidence host is not on the configured allowlist.");
  return url;
}

function extractText(input: string) {
  return input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff)))
    .replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim().slice(0, 24_000);
}

export type EvidencePage = { text: string; observedAt: string; sourceUrl: string; contentType: string };

export async function fetchEvidencePage(value: string): Promise<EvidencePage> {
  const url = validateEvidenceUrl(value);
  const host = url.hostname.toLowerCase();
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicEvidenceAddress(item.address))) throw new Error("Evidence host resolves to a restricted network address.");
  const destination = addresses[0]!;

  const response = await new Promise<{ status: number; contentType: string; body: string }>((resolve, reject) => {
    const request = https.request({
      hostname: destination.address,
      family: destination.family,
      port: 443,
      servername: host,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { Host: url.host, Accept: "text/html,text/plain;q=0.9", "Accept-Encoding": "identity", "User-Agent": "HoldFast-Evidence-Review/1.0" },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = res.headers["content-type"] ?? "";
      if (status >= 300 && status < 400) { res.resume(); reject(new Error("Evidence URL redirects are not followed.")); return; }
      if (status < 200 || status >= 300) { res.resume(); reject(new Error(`Evidence page returned HTTP ${status}.`)); return; }
      if (!/^text\/(html|plain)(?:\s*;|$)/i.test(contentType)) { res.resume(); reject(new Error("Evidence page must return HTML or plain text.")); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BYTES) { request.destroy(new Error("Evidence page exceeds the 1 MB limit.")); return; }
        chunks.push(buffer);
      });
      res.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error("Evidence page request timed out.")));
    request.on("error", reject);
    request.end();
  });
  const text = extractText(response.body);
  if (!text) throw new Error("Evidence page contains no readable text.");
  return { text, observedAt: new Date().toISOString(), sourceUrl: url.toString(), contentType: response.contentType };
}
