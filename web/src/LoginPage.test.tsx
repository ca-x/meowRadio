import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";
import { api, ApiError } from "./api";
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/me") throw new ApiError(401, "请登录");
    if (path === "/setup") return { initialized: true };
    if (path === "/settings") return { registration_enabled: true };
    if (path === "/auth/login")
      return { id: 1, username: "listener", role: "user" };
    return null;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>Radio home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("standalone login page", () => {
  it("renders branded login at /login and returns home after success", async () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "listener" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "safe-test-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录我的收音机" }));
    await screen.findByText("Radio home");
    expect(api).toHaveBeenCalledWith("/auth/login", "POST", {
      username: "listener",
      password: "safe-test-password",
    });
  });
  it("registration remains on the independent page", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "还没有账号？创建一个" }),
    );
    expect(screen.getByRole("heading", { name: "注册" })).toBeTruthy();
    expect(screen.getByLabelText("再次输入密码")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps failed login on the page with an actionable error", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (...args) => {
      if (args[0] === "/auth/login")
        throw new ApiError(401, "用户名或密码不正确");
      return original(...args);
    });
    mount();
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "listener" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong-test-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录我的收音机" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "用户名或密码不正确",
      ),
    );
    expect(screen.queryByText("Radio home")).toBeNull();
  });
});
