import { api, rawApi } from "./api";
import type { Station } from "./api";
export type PersonalSource = {
  id: string;
  label: string;
  kind: "url" | "file";
  url: string | null;
  station_count: number;
  created_at: number;
  updated_at: number;
};
export type PersonalPage = {
  items: Station[];
  total: number;
  page: number;
  page_size: number;
  categories: string[][];
};
export type SourceCapabilities = {
  available: boolean;
  mp3: boolean;
  native_rtmp: boolean;
  rtsp: boolean;
  mmst: boolean;
  mmsh: boolean;
};
export type SourceChange = {
  owner: number;
  sourceId?: string;
  stationId?: string;
  all?: boolean;
};
export const SOURCE_CHANGE = "meow-personal-sources-change";
export function notifySourceChange(change: SourceChange) {
  window.dispatchEvent(new CustomEvent(SOURCE_CHANGE, { detail: change }));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(SOURCE_CHANGE);
    channel.postMessage(change);
    channel.close();
  }
}
export function importSource(
  owner: number,
  label: string,
  url: string,
  discardInvalid = false,
  snapshotToken?: string,
) {
  return api<PersonalSource>(
    "/personal-sources",
    "POST",
    {
      label,
      url,
      discard_invalid: discardInvalid,
      snapshot_token: snapshotToken,
    },
    undefined,
    { "X-Meow-Owner": String(owner) },
  );
}
export function uploadSource(
  owner: number,
  label: string,
  file: File,
  sourceId?: string,
  discardInvalid = false,
  snapshotToken?: string,
) {
  const query = new URLSearchParams({ label });
  if (sourceId) query.set("source_id", sourceId);
  if (discardInvalid) query.set("discard_invalid", "true");
  if (snapshotToken) query.set("snapshot_token", snapshotToken);
  return rawApi<PersonalSource>(
    `/personal-sources/upload?${query}`,
    file,
    "application/json",
    String(owner),
  );
}
export function sourceAction(owner: number, path: string, method = "DELETE") {
  return api<PersonalSource>(path, method, undefined, undefined, {
    "X-Meow-Owner": String(owner),
  });
}
export const sourceExample = JSON.stringify(
  [
    {
      name: "CNR 中国之声",
      categories: [["推荐电台"], ["国内电台", "央广"]],
      urls: [
        "https://apppc.cnr.cn/national?cf=zgzs",
        "http://ngcdn001.cnr.cn/live/zgzs/index.m3u8",
      ],
    },
    {
      name: "请求头示例（请替换地址）",
      categories: [["自定义"]],
      urls: [
        {
          url: "https://radio.example/live.m3u8",
          headers: {
            Referer: "https://radio.example/",
            "User-Agent": "Mozilla/5.0",
          },
        },
      ],
    },
  ],
  null,
  2,
);
