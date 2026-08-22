/**
 * Direct credential material must never become manifest evidence, diagnostics, or generated
 * artifacts. This intentionally detects assignments/headers, not ordinary prose such as
 * "password reset" or a benign URL query like `?lang=en`.
 */
const DIRECT_CREDENTIAL = /(?:\b(?:api[ _-]?(?:key|token)|access[ _-]?token|auth(?:orization)?[ _-]?token|client[ _-]?secret|secret|password|private[ _-]?key|bearer)\s*[:=]\s*(?:["']?)[^\s"']+|\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{8,}|\bbearer\s+[A-Za-z0-9._~+\/-]{8,})/i;
const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|secret|password|private[_-]?key|bearer|credential|signature|sig|token|key|code)(?:$|[_-])/i;
const SENSITIVE_PATH_SEGMENT = /^(?:api[-_.]?(?:key|token)|access[-_.]?token|auth(?:orization)?|client[-_.]?secret|secret|password|private[-_.]?key|bearer|credential|signature|sig|token|key)$/i;
const BENIGN_PATH_VALUE = new Set(["about", "callback", "docs", "guide", "help", "legal", "login", "oauth", "policy", "privacy", "reference", "signin", "support", "terms"]);

export function containsDirectCredentialMaterial(value: string): boolean {
  return /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i.test(value)
    || DIRECT_CREDENTIAL.test(value)
    || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value);
}

/** Detect credential-bearing URLs embedded in free text before an artifact can echo them. */
export function containsCredentialUrlMaterial(value: string): boolean {
  for (const candidate of value.match(/https?:\/\/[^\s"'<>]+/g) || []) {
    try { if (urlContainsCredentialMaterial(new URL(candidate))) return true; }
    catch { /* malformed URLs are handled by their own validation */ }
  }
  return false;
}

/** URL userinfo is always credential material. Benign navigation state such as `?lang=en` or
 * `#retention` remains valid, while credential-shaped parameters are not. This supplements, not
 * replaces, direct-content detection above. */
export function urlContainsCredentialMaterial(url: URL): boolean {
  if (url.username || url.password) return true;
  if (containsDirectCredentialMaterial(`${url.search}\n${url.hash}`)) return true;
  try {
    // A scanner deliberately retains query *names* for endpoint identity while
    // discarding values. A bare `?api_key` therefore is not credential material
    // by itself; reject it only when the sensitive-looking key carries a value.
    if ([url.search, url.hash.replace(/^#/, "")].some((component) => [...new URLSearchParams(component).entries()].some(([key, value]) => SENSITIVE_URL_PARAMETER.test(key) && value.trim().length > 0))) return true;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment).trim());
    return segments.some((segment, index) => SENSITIVE_PATH_SEGMENT.test(segment) && index + 1 < segments.length && !BENIGN_PATH_VALUE.has(segments[index + 1].toLowerCase()));
  } catch { return true; }
}
