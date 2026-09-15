import {
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
import { api, ApiError } from "./api";
const station = {
  id: "station-a",
  name: "Example FM",
  url: "https://example.com/audio",
  country: "Test",
  countrycode: "US",
  tags: "jazz",
  codec: "MP3",
  bitrate: 128,
  hls: false,
};
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
vi.mock("./Player", () => ({ default: () => null }));
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
async function scenario(nextId: number) {
  let deletes = 0;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === "DELETE") {
      deletes++;
      if (deletes === 1) throw new ApiError(401, "请先登录");
      return undefined;
    }
    if (path === "/auth/login")
      return { id: nextId, username: "listener", role: "user" };
    if (path === "/auth/me") return null;
    if (path === "/setup") return { initialized: true };
    if (path === "/settings")
      return {
        registration_enabled: true,
        relay_enabled: true,
        proxy_configured: false,
      };
    if (path === "/favorites") return deletes > 1 ? [] : [station];
    if (path.startsWith("/stations")) return [station];
    return {};
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["me"], { id: 1, username: "listener", role: "user" });
  client.setQueryData(["setup"], { initialized: true });
  client.setQueryData(["settings"], {
    registration_enabled: true,
    relay_enabled: true,
    proxy_configured: false,
  });
  client.setQueryData(["favorites", 1], [station]);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ApplicationShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "取消收藏 Example FM" }),
  );
  await screen.findByRole("heading", { name: "欢迎回来" });
  fireEvent.change(screen.getByLabelText("用户名"), {
    target: { value: "listener" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "safe-test-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录我的收音机" }));
  await screen.findByRole("heading", { name: "好声音，慢慢听。" });
  return () => deletes;
}
it("replays the intended DELETE after the same account signs in again", async () => {
  const deletes = await scenario(1);
  await waitFor(() => expect(deletes()).toBe(2));
  expect(api).toHaveBeenCalledWith("/favorites/station-a", "DELETE");
});
it("does not replay an expired-session write into a different account", async () => {
  const deletes = await scenario(2);
  await screen.findByText("账号已切换，请重新操作收藏");
  expect(deletes()).toBe(1);
});
