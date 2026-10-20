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
import { countGenres, genreIndex } from "./stationGenres";
import type { Station } from "./api";
import { createStationScene } from "./StationScene";
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
vi.mock("./StationScene", () => ({
  createStationScene: vi.fn(
    (_host, view, stations: Station[], _pick, _hover, _lost, visibility) => {
      const emit = (genre: number | null) =>
        queueMicrotask(() =>
          visibility?.({
            ids: stations
              .filter(
                (station) => genre === null || genreIndex(station) === genre,
              )
              .map((station) => station.id),
            countries: [
              ...new Set(
                stations.map((station) => station.countrycode).filter(Boolean),
              ),
            ],
            genreCounts: countGenres(stations),
            distance: view === "globe" ? 4.8 : 6.2,
            cameraKey: view,
          }),
        );
      return {
        focus: vi.fn(),
        select: vi.fn(),
        reset: vi.fn(),
        zoom: vi.fn(),
        rotate: vi.fn(),
        setActive: vi.fn(),
        dispose: vi.fn(),
        setGenreFilter: vi.fn(emit),
        getCameraState: vi.fn(() => ({
          position: [0, 0, 5],
          target: [0, 0, 0],
          fitFactor: 1,
        })),
        restoreCameraState: vi.fn(),
      };
    },
  ),
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
    if (path === "/favorites/summary") return { ids: [], presets: [] };
    if (path.startsWith("/favorites/page"))
      return { items: [], page: 0, page_size: 24, total: 0 };
    if (path.startsWith("/stations/explore"))
      return { items: [station], total: 1, complete: true };
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
it("switches directory views without replacing audio and loads a separate unpaged catalog once", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "收听 Example FM" }),
  );
  const audio = document.querySelector("audio")!;
  fireEvent.playing(audio);
  const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
  const requests = vi
    .mocked(api)
    .mock.calls.filter(([path]) => path.startsWith("/stations")).length;
  fireEvent.click(screen.getByRole("button", { name: "地球" }));
  await screen.findByRole("region", { name: "地球电台视图" });
  fireEvent.click(screen.getByRole("button", { name: "星云" }));
  await screen.findByRole("region", { name: "星云电台视图" });
  fireEvent.click(screen.getByRole("button", { name: "列表" }));
  await screen.findByRole("button", { name: "收听 Example FM" });
  expect(document.querySelector("audio")).toBe(audio);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
  expect(
    vi
      .mocked(api)
      .mock.calls.filter(
        ([path]) =>
          path.startsWith("/stations") && !path.startsWith("/stations/explore"),
      ),
  ).toHaveLength(requests);
  expect(
    vi
      .mocked(api)
      .mock.calls.filter(([path]) => path.startsWith("/stations/explore")),
  ).toHaveLength(2);
});
it("remembers the directory view across reloads without starting playback", async () => {
  localStorage.setItem("meow-directory-view", "nebula");
  const first = mount();
  await screen.findByRole("region", { name: "星云电台视图" });
  expect(
    screen.getByRole("button", { name: "星云" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "地球" }));
  await waitFor(() =>
    expect(localStorage.getItem("meow-directory-view")).toBe("globe"),
  );
  first.unmount();
  mount();
  await screen.findByRole("region", { name: "地球电台视图" });
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});
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
  fireEvent.keyDown(screen.getByRole("button", { name: "listener" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "用户菜单" })).toBeTruthy(),
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
  fireEvent.keyDown(screen.getByRole("button", { name: "listener" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "系统设置" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("0.1.2");
  expect(dialog.querySelector(".home-appearance")).toBeNull();
});

it("separates two personal tabs, system themes and the recording library in the user menu", async () => {
  mount();
  await screen.findByRole("button", { name: "收听 Example FM" });
  fireEvent.keyDown(screen.getByRole("button", { name: "listener" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "个人选项" }));
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "个人资料",
    "修改密码",
  ]);
  expect(screen.getByLabelText("昵称")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("tab", { name: "个人资料" }), {
    key: "ArrowRight",
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "修改密码" }), {
    button: 0,
  });
  expect(await screen.findByLabelText("当前密码")).toBeTruthy();
  expect(screen.queryByText("录制格式")).toBeNull();
});

it("keeps a one-time relay selection separate from the persisted default", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "本次经服务器收听 Example FM" }),
  );
  expect(document.querySelector("audio")?.getAttribute("src")).toBe(
    "/api/stream/station-a",
  );
  expect(localStorage.getItem("meow-relay")).toBe("false");
  const toggle = screen.getByRole("button", { name: "服务器中转" });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(toggle.textContent).toBe("");
  fireEvent.click(toggle);
  expect(document.querySelector("audio")?.getAttribute("src")).toBe(
    station.url,
  );
  expect(localStorage.getItem("meow-relay")).toBe("false");
});

it("changing the saved default does not interrupt the current live stream", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "收听 Example FM" }),
  );
  const audio = document.querySelector("audio")!;
  fireEvent.playing(audio);
  const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
  fireEvent.keyDown(screen.getByRole("button", { name: "listener" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "系统设置" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "设置" }), { button: 0 });
  fireEvent.click(await screen.findByRole("radio", { name: /^服务端中转/ }));
  expect(localStorage.getItem("meow-relay")).toBe("true");
  expect(audio.getAttribute("src")).toBe(station.url);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
});

it("keeps lists paged while both 3D views display every matching station and filter real genres", async () => {
  const catalog = Array.from({ length: 180 }, (_, index) => ({
    ...station,
    id: `radio-${index}`,
    name: `Radio ${index}`,
    countrycode: index % 2 ? "US" : "CN",
    tags: index % 2 ? "rock" : "jazz",
  }));
  const previous = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, ...args) => {
    if (path.startsWith("/stations/explore"))
      return { items: catalog, total: catalog.length, complete: true };
    if (path.startsWith("/stations?")) {
      const params = new URL(path, "http://localhost").searchParams;
      const offset = Number(params.get("offset") || 0);
      return catalog.slice(offset, offset + Number(params.get("limit") || 24));
    }
    return previous(path, ...args);
  });
  mount();
  await waitFor(() =>
    expect(document.querySelectorAll(".station-card")).toHaveLength(24),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "每页数量" }), {
    target: { value: "100" },
  });
  await waitFor(() =>
    expect(document.querySelectorAll(".station-card")).toHaveLength(100),
  );
  expect(localStorage.getItem("meow-page-size")).toBe("100");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(document.querySelectorAll(".station-card")).toHaveLength(80),
  );
  fireEvent.click(screen.getByRole("button", { name: "地球" }));
  await screen.findByRole("region", { name: "地球电台视图" });
  expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "每页数量" })).toBeNull();
  expect(
    screen
      .getByRole("combobox", { name: "选择电台" })
      .querySelectorAll("option"),
  ).toHaveLength(180);
  fireEvent.click(screen.getByRole("button", { name: "星云" }));
  await screen.findByRole("region", { name: "星云电台视图" });
  fireEvent.click(screen.getByRole("button", { name: "爵士 90 点" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("combobox", { name: "选择电台" })
        .querySelectorAll("option"),
    ).toHaveLength(90),
  );
  fireEvent.click(screen.getByRole("button", { name: "全部 90 点" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("combobox", { name: "选择电台" })
        .querySelectorAll("option"),
    ).toHaveLength(180),
  );
});

it("does not show private viewport names after logout while public exploration is pending", async () => {
  const privateStation = {
    ...station,
    id: "private-a",
    name: "Private owner-only station",
    personal: true,
  };
  const previous = vi.mocked(api).getMockImplementation()!;
  let finishPublic!: (value: unknown) => void;
  const pendingPublic = new Promise((resolve) => {
    finishPublic = resolve;
  });
  vi.mocked(api).mockImplementation(async (path, ...args) => {
    if (path === "/personal-sources") return [];
    if (path.startsWith("/personal-stations"))
      return {
        items: [privateStation],
        total: 1,
        page: 0,
        page_size: 24,
        categories: [],
      };
    if (path.startsWith("/stations/explore")) return pendingPublic;
    return previous(path, ...args);
  });
  mount();
  await screen.findByRole("button", { name: "收听 Example FM" });
  fireEvent.click(screen.getByRole("tab", { name: "个人电台" }));
  await screen.findByRole("button", {
    name: "收听 Private owner-only station",
  });
  fireEvent.click(screen.getByRole("button", { name: "星云" }));
  await screen.findByRole("option", { name: "Private owner-only station" });
  fireEvent.keyDown(screen.getByRole("button", { name: "listener" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  await screen.findByRole("button", { name: "用户菜单" });
  expect(document.body.textContent).not.toContain("Private owner-only station");
  await act(async () => finishPublic({ items: [], total: 0, complete: true }));
});

it("keeps an explicit remainder drill when settled visibility suggests other tags", async () => {
  localStorage.setItem("meow-directory-view", "nebula");
  const nodes: Station[] = [
    "music",
    "radio",
    "english",
    "spanish",
    "talk",
    "dance",
    "*",
  ].map((key) => ({
    ...station,
    id: `genre:${key}`,
    name: key === "*" ? "Other" : key,
    country: "",
    countrycode: "",
    url: "",
    tags: key === "*" ? "" : key,
    cluster: { kind: "genre", key, count: key === "*" ? null : 100 },
  }));
  const previous = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, ...args) =>
    path.startsWith("/stations/explore")
      ? { items: nodes, total: null, complete: false }
      : previous(path, ...args),
  );
  mount();
  await screen.findByRole("option", { name: /Other/ });
  fireEvent.change(screen.getByRole("combobox", { name: "选择电台" }), {
    target: { value: "genre:*" },
  });
  fireEvent.click(screen.getByRole("button", { name: "探索" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(api)
        .mock.calls.some(
          ([path]) =>
            path.startsWith("/stations/explore") &&
            new URL(path, "http://localhost").searchParams.get("genres") ===
              "*",
        ),
    ).toBe(true),
  );
  const callback = vi.mocked(createStationScene).mock.calls.at(-1)?.[6];
  act(() =>
    callback?.({
      ids: nodes.map((node) => node.id),
      countries: [],
      genreCounts: [0, 0, 1, 0, 0, 0, 1, 5],
      distance: 3.4,
      cameraKey: "focused-other",
    }),
  );
  await waitFor(() => {
    const path = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path.startsWith("/stations/explore"))
      .at(-1)![0];
    expect(new URL(path, "http://localhost").searchParams.get("genres")).toBe(
      "*",
    );
  });
});
