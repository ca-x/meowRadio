export type User = { id: number; username: string; role: "admin" | "user" };
export type Station = {
  id: string;
  name: string;
  url: string;
  country: string;
  countrycode: string;
  tags: string;
  codec: string;
  bitrate: number;
  hls: boolean;
};
export type Settings = {
  proxy_configured: boolean;
  relay_enabled: boolean;
  registration_enabled: boolean;
  version: string;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers: { "Content-Type": "application/json", "X-Meow-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data.error || "请求失败，请稍后重试");
  }
  return response.status === 204 ||
    response.headers.get("content-length") === "0"
    ? (undefined as T)
    : response.json();
}
export function playableUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return ["http:", "https:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
