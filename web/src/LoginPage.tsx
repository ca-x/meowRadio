import i18n, { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import AccountForm from "./AccountForm";
import useTheme from "./useTheme";
import { api, ApiError } from "./api";
import type { User, Settings } from "./api";
export default function LoginPage() {
  useTranslation();
  useTheme();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  useEffect(() => {
    document.title = tr("{{v0}} · 阿喵收音机", {
      v0: mode === "login" ? tr("登录") : tr("注册"),
    });
    return () => {
      document.title = tr("阿喵收音机 · meowRadio");
    };
  }, [mode, i18n.language]);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api<User>("/auth/me").catch((e) => {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }),
    retry: false,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<Settings>("/settings"),
  });
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () =>
      api<{
        initialized: boolean;
      }>("/setup"),
  });
  if (me.data || setup.data?.initialized === false)
    return <Navigate to="/" replace />;
  return (
    <div className="login-page">
      <header className="login-header">
        <Link className="brand" to="/">
          <img src="/branding/logo-256.webp" width="42" height="42" alt="" />
          <span>
            {tr("阿喵")}
            <span>{tr("收音机")}</span>
          </span>
        </Link>
        <Link className="login-back" to="/">
          <ArrowLeft size={16} />
          {tr("返回收听")}
        </Link>
      </header>
      <main className="login-card">
        <img
          className="login-logo"
          src="/branding/logo-256.webp"
          width="94"
          height="94"
          alt=""
        />
        <h1>{mode === "login" ? tr("欢迎回来") : tr("留住喜欢的声音")}</h1>
        <p>{tr("一个账号，一份自己的电台收藏。")}</p>
        {me.isError || setup.isError ? (
          <div className="form-error" role="alert">
            {tr("暂时无法连接服务。")}
            <button
              className="text-button"
              onClick={() => {
                void me.refetch();
                void setup.refetch();
              }}
            >
              {tr("重新连接")}
            </button>
          </div>
        ) : (
          <AccountForm
            key={mode}
            mode={mode}
            onSuccess={(user) => {
              cache.setQueryData(["me"], user);
              cache.setQueryData(["setup"], {
                initialized: true,
              });
              navigate("/", {
                replace: true,
              });
            }}
          />
        )}
        {settings.data?.registration_enabled && (
          <button
            className="text-button"
            onClick={() =>
              setMode((v) => (v === "login" ? "register" : "login"))
            }
          >
            {mode === "login"
              ? tr("还没有账号？创建一个")
              : tr("已有账号？返回登录")}
          </button>
        )}
      </main>
      <footer>{tr("阿喵收音机 · 把世界，调到喜欢的频道。")}</footer>
    </div>
  );
}
