import type { Station } from "./api";
export function isHls(station: Station): boolean {
  return station.hls || /\.m3u8(?:$|[?#])/i.test(station.url);
}
export function requiresRelay(
  station: Station,
  protocol = window.location.protocol,
): boolean {
  try {
    return (
      station.personal ||
      (protocol === "https:" && new URL(station.url).protocol === "http:")
    );
  } catch {
    return false;
  }
}
