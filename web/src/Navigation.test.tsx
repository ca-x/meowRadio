import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ApplicationShell from "./ApplicationShell";
import { api } from "./api";
import i18n from "./i18n";
import { DEFAULT_FILTERS } from "./StationFilters";
const station = {
  id: "station-a",
  name: "Example FM",
  url: "https://example.com/audio",
  country: "China",
  countrycode: "CN",
  tags: "jazz",
  codec: "MP3",
  bitrate: 128,
  hls: false,
};
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/setup") return { initialized: true };
    if (path === "/auth/me")
      return { id: 1, username: "listener", role: "user" };
    if (path === "/settings")
      return {
        version: "0.1.2",
        registration_enabled: true,
        relay_enabled: true,
        proxy_configured: false,
      };
    if (path === "/favorites") return [];
    if (path.startsWith("/stations")) return [station];
    return {};
  });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("zh");
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ApplicationShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it("keeps the same playing audio, query and country when clicking home and changing appearance", async () => {
  localStorage.setItem(
    "meow-browse",
    JSON.stringify({
      query: "FM",
      filters: { ...DEFAULT_FILTERS, country: "CN" },
      page: 2,
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "收听 Example FM" }),
  );
  const audio = document.querySelector("audio")!;
  fireEvent.playing(audio);
  const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
  fireEvent.click(screen.getByRole("link", { name: "阿喵收音机首页" }));
  fireEvent.click(screen.getByRole("button", { name: "切换暗色" }));
  await act(async () =>
    fireEvent.change(screen.getByRole("combobox", { name: "语言" }), {
      target: { value: "en" },
    }),
  );
  expect(document.querySelector("audio")).toBe(audio);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Search stations",
      }) as HTMLInputElement
    ).value,
  ).toBe("FM");
  expect(JSON.parse(localStorage.getItem("meow-browse")!).filters.country).toBe(
    "CN",
  );
  expect(document.documentElement.dataset.color).toBe("dark");
  expect(localStorage.getItem("meow-language")).toBe("en");
});
it("honors saved relay on regular play, retains preference after logout and reload", async () => {
  localStorage.setItem("meow-relay", "true");
  const first = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "收听 Example FM" }),
  );
  expect(document.querySelector("audio")?.getAttribute("src")).toBe(
    "/api/stream/station-a",
  );
  fireEvent.click(screen.getByRole("button", { name: "listener" }));
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "登录 / 注册" })).toBeTruthy(),
  );
  expect(localStorage.getItem("meow-relay")).toBe("true");
  first.unmount();
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "收听 Example FM" }),
  );
  expect(document.querySelector("audio")?.getAttribute("src")).toBe(
    "/api/stream/station-a",
  );
});
it("shows version in settings, with language and color controls only on home", async () => {
  mount();
  await screen.findByRole("button", { name: "收听 Example FM" });
  fireEvent.click(screen.getByRole("button", { name: "连接设置" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("0.1.2");
  expect(dialog.querySelector(".home-appearance")).toBeNull();
});
