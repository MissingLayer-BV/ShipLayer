import { createPrivateKey, sign } from "node:crypto";
import type { PlayManifest } from "./play-types.js";

const API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_ROOT = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export interface PlayFetchResponse { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }
export type PlayFetchLike = (input: string, init?: RequestInit) => Promise<PlayFetchResponse>;
export interface PlayServiceAccount { client_email: string; private_key: string; token_uri: string }
export interface PlayAccessToken { accessToken: string }
export type PlayAuthentication = PlayServiceAccount | PlayAccessToken;

export function playCredentialsFromEnvironment(manifest: PlayManifest, environment: NodeJS.ProcessEnv = process.env): PlayAuthentication | undefined {
  const accessTokenName = manifest.sync.accessTokenEnv || "GOOGLE_PLAY_ACCESS_TOKEN";
  const accessToken = environment[accessTokenName];
  if (accessToken) {
    if (accessToken.length < 20 || accessToken.length > 16_384 || /\s/.test(accessToken)) throw new Error(`${accessTokenName} does not contain a valid OAuth access token.`);
    return { accessToken };
  }
  const name = manifest.sync.serviceAccountJsonEnv || "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON";
  const serialized = environment[name];
  if (!serialized) return undefined;
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new Error(`${name} must contain the service-account JSON object, not a path or partial credential.`); }
  if (!record(value) || typeof value.client_email !== "string" || typeof value.private_key !== "string" || typeof value.token_uri !== "string") throw new Error(`${name} is not a complete Google service-account credential.`);
  if (!/^[-A-Za-z0-9._%+]+@[-A-Za-z0-9.]+\.gserviceaccount\.com$/.test(value.client_email)) throw new Error(`${name} has an invalid service-account email.`);
  if (value.token_uri !== TOKEN_URI) throw new Error(`${name} uses an unexpected OAuth token endpoint.`);
  const key = createPrivateKey(value.private_key);
  if (key.asymmetricKeyType !== "rsa") throw new Error(`${name} must contain an RSA private key.`);
  return { client_email: value.client_email, private_key: value.private_key, token_uri: value.token_uri };
}

export async function createGoogleAccessToken(credentials: PlayServiceAccount, fetcher: PlayFetchLike = fetch as unknown as PlayFetchLike, now = new Date()): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({ iss: credentials.client_email, scope: SCOPE, aud: credentials.token_uri, iat: issuedAt, exp: issuedAt + 3600 })).toString("base64url");
  const input = `${header}.${claim}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), credentials.private_key).toString("base64url");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(credentials.token_uri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${signature}` }).toString(), signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`Google OAuth token request failed (${response.status}): ${redact(body)}`);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.access_token !== "string" || !parsed.access_token) throw new Error("Google OAuth response did not contain an access token.");
    return parsed.access_token;
  } finally { clearTimeout(timer); }
}

export class GooglePlayClient {
  private constructor(private readonly accessToken: string, private readonly fetcher: PlayFetchLike, private readonly timeoutMs: number) {}
  static async connect(authentication: PlayAuthentication, fetcher: PlayFetchLike = fetch as unknown as PlayFetchLike, timeoutMs = 120_000): Promise<GooglePlayClient> {
    const accessToken = "accessToken" in authentication ? authentication.accessToken : await createGoogleAccessToken(authentication, fetcher);
    return new GooglePlayClient(accessToken, fetcher, timeoutMs);
  }
  async insertEdit(packageName: string): Promise<string> { const result = await this.json("POST", `${appPath(packageName)}/edits`, {}); if (typeof result.id !== "string") throw new Error("Google Play did not return an edit ID."); return result.id; }
  async deleteEdit(packageName: string, editId: string): Promise<void> { await this.json("DELETE", `${appPath(packageName)}/edits/${segment(editId)}`); }
  async validateEdit(packageName: string, editId: string): Promise<void> { await this.json("POST", `${appPath(packageName)}/edits/${segment(editId)}:validate`, {}); }
  async commitEdit(packageName: string, editId: string): Promise<void> { await this.json("POST", `${appPath(packageName)}/edits/${segment(editId)}:commit`, {}); }
  async listings(packageName: string, editId: string): Promise<Record<string, unknown>[]> { return array((await this.json("GET", `${appPath(packageName)}/edits/${segment(editId)}/listings`)).listings); }
  async updateListing(packageName: string, editId: string, language: string, body: Record<string, string>): Promise<void> { await this.json("PUT", `${appPath(packageName)}/edits/${segment(editId)}/listings/${segment(language)}`, body); }
  async images(packageName: string, editId: string, language: string, imageType: string): Promise<Record<string, unknown>[]> { return array((await this.json("GET", `${appPath(packageName)}/edits/${segment(editId)}/listings/${segment(language)}/${segment(imageType)}`)).images); }
  async deleteImages(packageName: string, editId: string, language: string, imageType: string): Promise<void> { await this.json("DELETE", `${appPath(packageName)}/edits/${segment(editId)}/listings/${segment(language)}/${segment(imageType)}`); }
  async uploadImage(packageName: string, editId: string, language: string, imageType: string, bytes: Buffer, contentType: string): Promise<void> { await this.binary(`${UPLOAD_ROOT}${appPath(packageName)}/edits/${segment(editId)}/listings/${segment(language)}/${segment(imageType)}?uploadType=media`, bytes, contentType); }
  async bundles(packageName: string, editId: string): Promise<Record<string, unknown>[]> { return array((await this.json("GET", `${appPath(packageName)}/edits/${segment(editId)}/bundles`)).bundles); }
  async uploadBundle(packageName: string, editId: string, bytes: Buffer): Promise<Record<string, unknown>> { return this.binary(`${UPLOAD_ROOT}${appPath(packageName)}/edits/${segment(editId)}/bundles?uploadType=media`, bytes, "application/octet-stream"); }
  async track(packageName: string, editId: string, track: string): Promise<Record<string, unknown>> { return this.json("GET", `${appPath(packageName)}/edits/${segment(editId)}/tracks/${segment(track)}`); }
  async updateTrack(packageName: string, editId: string, track: string, body: Record<string, unknown>): Promise<void> { await this.json("PUT", `${appPath(packageName)}/edits/${segment(editId)}/tracks/${segment(track)}`, body); }

  private async json(method: "GET" | "POST" | "PUT" | "DELETE", suffix: string, body?: unknown): Promise<Record<string, unknown>> {
    return this.request(method, `${API_ROOT}${suffix}`, body === undefined ? undefined : Buffer.from(JSON.stringify(body)), body === undefined ? undefined : "application/json");
  }
  private async binary(url: string, bytes: Buffer, contentType: string): Promise<Record<string, unknown>> { return this.request("POST", url, bytes, contentType); }
  private async request(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: Buffer, contentType?: string): Promise<Record<string, unknown>> {
    if (!url.startsWith(`${API_ROOT}/applications/`) && !url.startsWith(`${UPLOAD_ROOT}/applications/`)) throw new Error("Refusing a Google Play request outside the Android Publisher API.");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" };
      if (contentType) headers["Content-Type"] = contentType;
      const response = await this.fetcher(url, { method, headers, body: body as unknown as BodyInit, signal: controller.signal });
      const responseBody = await response.text();
      if (!response.ok) {
        if (method === "DELETE" && response.status === 404) return {};
        throw new Error(`Google Play ${method} failed (${response.status}): ${redact(responseBody)}${method === "GET" ? "" : " Reconcile remote state before retrying because Google may have accepted the request."}`);
      }
      if (!responseBody) return {};
      try { return JSON.parse(responseBody) as Record<string, unknown>; }
      catch { throw new Error("Google Play returned a non-JSON response."); }
    } finally { clearTimeout(timer); }
  }
}

function appPath(packageName: string): string { return `/applications/${segment(packageName)}`; }
function segment(value: string): string { return encodeURIComponent(value); }
function array(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(record) : []; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function redact(value: string): string { return value.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/g, "[REDACTED]").replace(/(?:Bearer\s+)?[A-Za-z0-9._~-]{32,}/g, "[REDACTED]").slice(0, 1_000); }
