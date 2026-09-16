import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as Tabs from "@radix-ui/react-tabs";
import { Upload, UserRound } from "lucide-react";
import { api, rawApi, type User } from "./api";
import { tr } from "./i18n";
import "./profile-settings.css";
export default function ProfileSettings({
  user,
  onUpdate,
}: {
  user: User;
  onUpdate: (user: User) => void;
}) {
  useTranslation();
  const [nickname, setNickname] = useState(user.nickname || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setNickname(user.nickname || ""), [user.id, user.nickname]);
  const profile = useMutation({
    mutationFn: () =>
      api<User>("/profile", "PATCH", { nickname }, undefined, {
        "X-Meow-Owner": String(user.id),
      }),
    onSuccess: (updated) => {
      onUpdate(updated);
      setMessage("个人资料已保存");
    },
  });
  const avatar = useMutation({
    mutationFn: (image: File) =>
      rawApi<User>("/profile/avatar", image, image.type, String(user.id)),
    onSuccess: (updated) => {
      onUpdate(updated);
      setMessage("头像已更新");
    },
  });
  const password = useMutation({
    mutationFn: () =>
      api(
        "/profile/password",
        "POST",
        {
          current_password: currentPassword,
          new_password: newPassword,
        },
        undefined,
        { "X-Meow-Owner": String(user.id) },
      ),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("密码已修改，其他设备需要重新登录。");
    },
  });
  const error =
    validation ||
    profile.error?.message ||
    avatar.error?.message ||
    password.error?.message;
  const clear = () => {
    setMessage("");
    setValidation("");
    profile.reset();
    avatar.reset();
    password.reset();
  };
  return (
    <Tabs.Root
      defaultValue="profile"
      className="profile-settings"
      onValueChange={clear}
    >
      <Tabs.List className="settings-tab-list" aria-label={tr("个人选项分类")}>
        <Tabs.Trigger value="profile">{tr("个人资料")}</Tabs.Trigger>
        <Tabs.Trigger value="password">{tr("修改密码")}</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="profile">
        <div className="profile-avatar-row">
          <div className="profile-avatar">
            {user.avatar_url ? (
              <img src={user.avatar_url} alt={tr("当前头像")} />
            ) : (
              <UserRound size={38} />
            )}
          </div>
          <div>
            <strong>{user.nickname || user.username}</strong>
            <p>@{user.username}</p>
            <button
              className="secondary"
              type="button"
              disabled={avatar.isPending}
              onClick={() => file.current?.click()}
            >
              <Upload size={16} />
              {avatar.isPending ? tr("正在上传…") : tr("更换头像")}
            </button>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label={tr("上传头像")}
              tabIndex={-1}
              onChange={(event) => {
                const image = event.target.files?.[0];
                event.target.value = "";
                if (!image) return;
                clear();
                if (image.size > 5 * 1024 * 1024) {
                  setValidation("头像图片不能超过 5 MiB");
                  return;
                }
                avatar.mutate(image);
              }}
            />
          </div>
        </div>
        <p className="profile-help">
          {tr("支持 JPG、PNG、WebP，最大 5 MiB。新头像会替换旧头像。")}
        </p>
        <form
          className="profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            clear();
            profile.mutate();
          }}
        >
          <label>
            {tr("昵称")}
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={60}
              autoComplete="nickname"
              placeholder={user.username}
            />
          </label>
          <p>{tr("昵称为空时显示用户名，登录用户名保持不变。")}</p>
          <button
            className="primary"
            disabled={profile.isPending || avatar.isPending}
          >
            {profile.isPending ? tr("正在保存…") : tr("保存资料")}
          </button>
        </form>
      </Tabs.Content>
      <Tabs.Content value="password">
        <form
          className="profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            clear();
            if (newPassword !== confirmPassword) {
              setValidation("两次输入的新密码不一致");
              return;
            }
            const bytes = new TextEncoder().encode(newPassword).length;
            if (bytes < 10 || bytes > 128) {
              setValidation("密码需为 10–128 字节");
              return;
            }
            password.mutate();
          }}
        >
          <input
            type="text"
            value={user.username}
            readOnly
            autoComplete="username"
            hidden
          />
          <label>
            {tr("当前密码")}
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            {tr("新密码")}
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={128}
            />
          </label>
          <label>
            {tr("确认新密码")}
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={128}
            />
          </label>
          <p>{tr("修改后保留当前登录，其他设备需要重新登录。")}</p>
          <button className="primary" disabled={password.isPending}>
            {password.isPending ? tr("正在修改…") : tr("修改密码")}
          </button>
        </form>
      </Tabs.Content>
      {message && (
        <p className="profile-message" role="status">
          {tr(message)}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {tr(error)}
        </p>
      )}
    </Tabs.Root>
  );
}
