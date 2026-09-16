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
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api, rawApi, ApiError, type Station } from "./api";
import SourcesPage from "./SourcesPage";
import SourceValidationDialog from "./SourceValidationDialog";
import ApplicationShell from "./ApplicationShell";
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
  rawApi: vi.fn(),
}));
const source = {
  id: "source-a",
  label: "我的测试源",
  kind: "file" as const,
  url: null,
  station_count: 1,
  created_at: 1,
  updated_at: 1,
};
const personal: Station = {
  id: "12345678-1234-4321-8321-123456789abc",
  name: "个人 A",
  url: "/api/personal-stations/12345678-1234-4321-8321-123456789abc/stream",
  country: "",
  countrycode: "",
  tags: "国内 / 测试",
  codec: "MP3",
  bitrate: 128,
  hls: false,
  personal: true,
  source_id: source.id,
  source_name: source.label,
};
const system = {
  ...personal,
  id: "sys-a",
  name: "System FM",
  url: "https://radio.example/live.mp3",
  personal: false,
};
const failures = [
  {
    name: "A",
    url: "https://radio.example/c.mp3",
    reason: "电台连接失败",
    line: 2,
    key: "bad-c",
    station_id: personal.id,
  },
  {
    name: "A",
    url: "https://radio.example/d.mp3",
    reason: "电台连接失败",
    line: 3,
    key: "bad-d",
    station_id: personal.id,
  },
];
const job = {
  id: "job-a",
  source_id: source.id,
  total: 3,
  checked: 3,
  status: "complete",
  failed_count: 2,
  failures,
};
let saved: boolean, added: boolean;
beforeEach(() => {
  localStorage.clear();
  saved = false;
  added = false;
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.mocked(api).mockReset();
  vi.mocked(rawApi).mockReset();
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/auth/me")
      return { id: 1, username: "listener", role: "user" };
    if (path === "/setup") return { initialized: true };
    if (path === "/settings") return { relay_enabled: true, version: "0.3.0" };
    if (path === "/personal-sources") return added ? [source] : [];
    if (path === "/personal-sources/capabilities")
      return {
        available: true,
        mp3: true,
        native_rtmp: true,
        rtsp: true,
        mmst: true,
        mmsh: true,
      };
    if (path === `/personal-sources/${source.id}/validation/clear`)
      return { removed_lines: 2, removed_stations: 0, skipped_lines: 0 };
    if (path === `/personal-sources/${source.id}/validation`) return job;
    if (path.startsWith("/personal-stations?")) {
      const q = new URL(path, "https://local").searchParams;
      if (q.has("source_id") && !q.get("source_id"))
        throw new Error("empty source filter must be omitted");
      return {
        items: [personal],
        total: 1,
        page: 0,
        page_size: 24,
        categories: [["国内", "测试"]],
      };
    }
    if (path === `/favorites/${personal.id}` && method === "PUT") {
      saved = true;
      return personal;
    }
    if (path === "/favorites/summary")
      return {
        ids: saved ? [personal.id] : [],
        presets: saved ? [personal] : [],
      };
    if (path.startsWith("/favorites/page"))
      return {
        items: saved ? [personal] : [],
        total: saved ? 1 : 0,
        page: 0,
        page_size: 24,
      };
    if (path.startsWith("/stations")) return [system];
    return {};
  });
  vi.mocked(rawApi).mockImplementation(async () => {
    added = true;
    return source;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function wrapper(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}
it("shows only failed URLs and clears selected addresses only after confirmation", async () => {
  const onClose = vi.fn(),
    onCleared = vi.fn();
  wrapper(
    <SourceValidationDialog
      source={source}
      userId={1}
      onClose={onClose}
      onCleared={onCleared}
    />,
  );
  await screen.findByText(failures[0].url);
  expect(screen.getByText(failures[1].url)).toBeTruthy();
  expect(screen.queryByText("https://radio.example/b.mp3")).toBeNull();
  expect(api).not.toHaveBeenCalledWith(
    expect.stringContaining("/clear"),
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认清理 2 个地址" }));
  await waitFor(() => expect(onCleared).toHaveBeenCalledOnce());
  expect(onClose).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledWith(
    `/personal-sources/${source.id}/validation/clear`,
    "POST",
    { job_id: "job-a", keys: ["bad-c", "bad-d"] },
    undefined,
    { "X-Meow-Owner": "1" },
  );
});
it("can retain one failed address instead of clearing the entire station", async () => {
  wrapper(
    <SourceValidationDialog
      source={source}
      userId={1}
      onClose={vi.fn()}
      onCleared={vi.fn()}
    />,
  );
  await screen.findByText(failures[0].url);
  const checks = screen.getAllByRole("checkbox");
  fireEvent.click(checks[2]);
  fireEvent.click(screen.getByRole("button", { name: "确认清理 1 个地址" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining("/clear"),
      "POST",
      { job_id: "job-a", keys: ["bad-c"] },
      undefined,
      expect.anything(),
    ),
  );
});
it("reports all invalid import URLs before retrying with explicit discard confirmation", async () => {
  vi.mocked(rawApi)
    .mockRejectedValueOnce(
      new ApiError(422, "发现无效播放地址", {
        invalid_records: [
          {
            name: "A",
            index: 1,
            line: 2,
            url: "file:///bad",
            reason: "不支持的电台地址或地址包含凭据",
          },
        ],
        valid_count: 1,
        snapshot_token: "reviewed-snapshot",
      }),
    )
    .mockImplementation(async () => {
      added = true;
      return source;
    });
  wrapper(<SourcesPage />);
  await screen.findByRole("heading", { name: "还没有个人电台源" });
  fireEvent.click(screen.getAllByRole("button", { name: "添加电台源" })[0]);
  fireEvent.change(screen.getByLabelText("源名称"), {
    target: { value: "我的测试源" },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "上传文件" }), {
    button: 0,
  });
  const file = new File(["[]"], "radio.json", { type: "application/json" });
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "导入" }).closest("form")!,
  );
  await screen.findByText("file:///bad");
  expect(rawApi).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "清除无效地址并继续" }));
  await waitFor(() => expect(rawApi).toHaveBeenCalledTimes(2));
  expect(vi.mocked(rawApi).mock.calls[1][0]).toContain("discard_invalid=true");
  expect(vi.mocked(rawApi).mock.calls[1][0]).toContain(
    "snapshot_token=reviewed-snapshot",
  );
  expect(vi.mocked(rawApi).mock.calls[1][3]).toBe("1");
});
it("keeps private stations separate, plays through their private endpoint, and labels merged favorites", async () => {
  added = true;
  wrapper(<ApplicationShell />);
  await screen.findByRole("button", { name: "收听 System FM" });
  fireEvent.click(screen.getByRole("tab", { name: "个人电台" }));
  fireEvent.click(await screen.findByRole("button", { name: "收听 个人 A" }));
  const audio = document.querySelector("audio")!;
  expect(audio.getAttribute("src")).toContain(
    `/api/personal-stations/${personal.id}/stream`,
  );
  expect(
    screen
      .getByRole("button", { name: "服务器中转" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "收藏 个人 A" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `/favorites/${personal.id}`,
      "PUT",
      undefined,
      undefined,
      { "X-Meow-Owner": "1" },
    ),
  );
  fireEvent.click(screen.getByRole("tab", { name: /我的收藏/ }));
  await screen.findByRole("button", { name: "收听 个人 A" });
  expect(
    document.querySelector(".station-card .personal-source-badge")?.textContent,
  ).toBe("个人源");
  expect(document.querySelector("audio")).toBe(audio);
});
it("cancels a job accepted after its dialog was closed", async () => {
  let resolve!: (job: unknown) => void;
  const previous = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((...args) =>
    args[1] === "POST" && args[0].endsWith("/validation")
      ? new Promise((r) => {
          resolve = r;
        })
      : previous(...args),
  );
  const view = wrapper(
    <SourceValidationDialog
      source={source}
      userId={1}
      onClose={vi.fn()}
      onCleared={vi.fn()}
    />,
  );
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  view.unmount();
  await act(async () => resolve({ ...job, status: "running" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `/personal-sources/${source.id}/validation?job_id=${job.id}`,
      "DELETE",
      undefined,
      undefined,
      { "X-Meow-Owner": "1" },
    ),
  );
});
it("cancels an accepted running job when navigation unmounts the dialog", async () => {
  const previous = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((...args) =>
    args[0].endsWith("/validation")
      ? Promise.resolve({ ...job, status: "running", checked: 0, failures: [] })
      : previous(...args),
  );
  const view = wrapper(
    <SourceValidationDialog
      source={source}
      userId={1}
      onClose={vi.fn()}
      onCleared={vi.fn()}
    />,
  );
  await screen.findByText("已检测 0 / 3 个地址");
  view.unmount();
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `/personal-sources/${source.id}/validation?job_id=${job.id}`,
      "DELETE",
      undefined,
      undefined,
      { "X-Meow-Owner": "1" },
    ),
  );
});

it("binds late conflict recovery cancellation to the fetched job", async () => {
  let resolve!: (value: unknown) => void;
  const previous = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((...args) => {
    if (args[0].endsWith("/validation")) {
      if (args[1] === "POST")
        return Promise.reject(
          new ApiError(409, "此订阅正在校验，请查看当前进度"),
        );
      return new Promise((r) => {
        resolve = r;
      });
    }
    return previous(...args);
  });
  const view = wrapper(
    <SourceValidationDialog
      source={source}
      userId={1}
      onClose={vi.fn()}
      onCleared={vi.fn()}
    />,
  );
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  view.unmount();
  await act(async () =>
    resolve({ ...job, id: "existing-job", status: "running" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `/personal-sources/${source.id}/validation?job_id=existing-job`,
      "DELETE",
      undefined,
      undefined,
      { "X-Meow-Owner": "1" },
    ),
  );
});
it("binds close cancellation to the displayed running job", async () => {
  const previous = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((...args) =>
    args[0].endsWith("/validation")
      ? Promise.resolve({ ...job, status: "running", checked: 0, failures: [] })
      : previous(...args),
  );
  const onClose = vi.fn();
  wrapper(
    <SourceValidationDialog
      source={source}
      userId={1}
      onClose={onClose}
      onCleared={vi.fn()}
    />,
  );
  await screen.findByText("已检测 0 / 3 个地址");
  fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `/personal-sources/${source.id}/validation?job_id=${job.id}`,
      "DELETE",
      undefined,
      undefined,
      { "X-Meow-Owner": "1" },
    ),
  );
  expect(onClose).toHaveBeenCalled();
});
