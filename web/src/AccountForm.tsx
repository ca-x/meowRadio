import { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { api } from "./api";
import type { User } from "./api";
export default function AccountForm({
  mode,
  onSuccess,
}: {
  mode: "setup" | "login" | "register";
  onSuccess: (user: User) => void;
}) {
  useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<User>(mode === "setup" ? "/setup" : `/auth/${mode}`, "POST", {
        username,
        password,
      }),
    onSuccess,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (mode !== "login" && password !== confirm) {
      setLocalError("两次输入的密码不一致");
      return;
    }
    mutation.mutate();
  }
  return (
    <form className="account-form" onSubmit={submit}>
      <label htmlFor="username">{tr("用户名")}</label>
      <input
        id="username"
        name="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        required
        minLength={3}
        maxLength={32}
        pattern="[a-zA-Z0-9_\-]+"
        aria-describedby="username-help"
      />
      <small id="username-help">
        {tr("3–32 位字母、数字、下划线或短横线")}
      </small>
      <label htmlFor="password">{tr("密码")}</label>
      <input
        id="password"
        name="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        required
        minLength={10}
        maxLength={128}
      />
      {mode !== "login" && (
        <>
          <small>{tr("至少 10 个字符，建议使用密码管理器生成。")}</small>
          <label htmlFor="confirm">{tr("再次输入密码")}</label>
          <input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </>
      )}
      {(localError || mutation.error) && (
        <p className="form-error" role="alert">
          {tr(localError || mutation.error?.message || "")}
        </p>
      )}
      <button className="primary" disabled={mutation.isPending}>
        {mutation.isPending
          ? tr("正在保存…")
          : mode === "setup"
            ? tr("创建管理员，开始收听")
            : mode === "login"
              ? tr("登录我的收音机")
              : tr("创建账号")}
        <ArrowUpRight size={17} />
      </button>
    </form>
  );
}
