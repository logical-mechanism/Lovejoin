/**
 * Redact infrastructure topology from an upstream error message before
 * returning it to the client. Strips: postgres connection strings,
 * Blockfrost project ids, IPv4 addresses with optional ports, and bare
 * URLs. Caps the result at 256 chars so a chatty upstream stack trace
 * can't be used as an amplifier for log spam (security review v1,
 * finding H3). Operators get the full message via the structured
 * pino logger (`request.log.error({ raw, err }, ...)`); clients get a
 * redacted, length-bounded summary.
 */
export function redactUpstreamMessage(raw: string | undefined | null): string {
  if (!raw) return "upstream error";
  let s = String(raw);
  s = s.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "postgres://***");
  s = s.replace(/\bproject_id[=:]\s*[a-z0-9]{20,}/gi, "project_id=***");
  s = s.replace(/\bpreprod[a-z0-9]{20,}\b/gi, "preprod***");
  s = s.replace(/\bmainnet[a-z0-9]{20,}\b/gi, "mainnet***");
  s = s.replace(/\bpreview[a-z0-9]{20,}\b/gi, "preview***");
  s = s.replace(/(https?|wss?):\/\/[^\s"'`]+/gi, "$1://***");
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?/g, "***");
  if (s.length > 256) s = s.slice(0, 253) + "...";
  return s;
}
