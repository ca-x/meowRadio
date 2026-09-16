import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import ApplicationShell from "./ApplicationShell";
import { api, type Station } from "./api";
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
let rows: Station[];
beforeEach(() => {
  localStorage.clear();
  rows = Array.from({ length: 49 }, (_, i) => ({
    id: `station-${i}`,
    name: `Favorite ${String(i).padStart(2, "0")}`,
    url: "https://example.com/audio",
    country: "Test",
    countrycode: "US",
    tags: i === 48 ? "unique" : "jazz",
    codec: "MP3",
    bitrate: 128,
    hls: false,
  }));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/setup") return { initialized: true };
    if (path === "/auth/me")
      return { id: 1, username: "listener", role: "user" };
    if (path === "/settings") return { version: "0.2.1", relay_enabled: true };
    if (method === "DELETE") {
      rows = rows.filter((row) => path !== `/favorites/${row.id}`);
      return;
    }
    if (path === "/favorites/summary")
      return { ids: rows.map((row) => row.id), presets: rows.slice(0, 4) };
    if (path.startsWith("/favorites/page")) {
      const params = new URL(path, "https://local").searchParams;
      const q = params.get("q") || "";
      const match = rows.filter((row) =>
        `${row.name} ${row.tags} ${row.country}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      );
      const page = Math.min(
        Number(params.get("page")),
        Math.max(0, Math.ceil(match.length / 24) - 1),
      );
      return {
        items: match.slice(page * 24, page * 24 + 24),
        page,
        page_size: 24,
        total: match.length,
      };
    }
    if (path.startsWith("/stations")) return rows.slice(0, 24);
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        })
      }
    >
      <MemoryRouter>
        <ApplicationShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "收听 Favorite 00" });
  fireEvent.click(screen.getByRole("tab", { name: /我的收藏/ }));
  await screen.findByText("第 1 / 3 页 · 共 49 个收藏");
}
it("paginates 24 favorites at a time without replacing or restarting playing audio", async () => {
  await mount();
  expect(document.querySelectorAll(".station-card")).toHaveLength(24);
  fireEvent.click(screen.getByRole("button", { name: "收听 Favorite 00" }));
  const audio = document.querySelector("audio")!;
  fireEvent.playing(audio);
  const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "收听 Favorite 24" });
  expect(document.querySelectorAll(".station-card")).toHaveLength(24);
  expect(document.querySelector("audio")).toBe(audio);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "收听 Favorite 48" });
  expect(document.querySelectorAll(".station-card")).toHaveLength(1);
  expect(
    (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("resets search to the first page and searches the entire collection", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "收听 Favorite 24" });
  fireEvent.change(screen.getByRole("textbox", { name: "搜索电台" }), {
    target: { value: "unique" },
  });
  fireEvent.click(screen.getByRole("button", { name: "立即搜索" }));
  await screen.findByText("第 1 / 1 页 · 共 1 个收藏");
  expect(screen.getByRole("button", { name: "收听 Favorite 48" })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("moves to the preceding page after deleting the last item on the final page", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "收听 Favorite 24" });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "收听 Favorite 48" });
  fireEvent.click(screen.getByRole("button", { name: "取消收藏 Favorite 48" }));
  await screen.findByText("第 2 / 2 页 · 共 48 个收藏");
  await waitFor(() =>
    expect(document.querySelectorAll(".station-card")).toHaveLength(24),
  );
});
