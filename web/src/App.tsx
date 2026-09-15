import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Radio,
  Search,
  Heart,
  Settings2,
  UserRound,
  X,
  ArrowUpRight,
  Globe2,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Headphones,
  Signal,
  RotateCw,
  Check,
  Cable,
} from "lucide-react";
import { api, ApiError } from "./api";
import type { Station, User, Settings } from "./api";
import Player from "./Player";

function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
          <Dialog.Close className="modal-close icon-button" aria-label="关闭">
            <X size={20} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function AccountForm({
  mode,
  onSuccess,
}: {
  mode: "setup" | "login" | "register";
  onSuccess: (user: User) => void;
}) {
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
      <label htmlFor="username">用户名</label>
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
      <small id="username-help">3–32 位字母、数字、下划线或短横线</small>
      <label htmlFor="password">密码</label>
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
          <small>至少 10 个字符，建议使用密码管理器生成。</small>
          <label htmlFor="confirm">再次输入密码</label>
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
          {localError || mutation.error?.message}
        </p>
      )}
      <button className="primary" disabled={mutation.isPending}>
        {mutation.isPending
          ? "正在保存…"
          : mode === "setup"
            ? "创建管理员，开始收听"
            : mode === "login"
              ? "登录我的收音机"
              : "创建账号"}
        <ArrowUpRight size={17} />
      </button>
    </form>
  );
}
export default function App() {
  const cache = useQueryClient();
  const [theme, setTheme] = useState<"walnut" | "vitreous" | "led">(() => {
    try {
      const saved = localStorage.getItem("meow-theme");
      return saved === "vitreous" || saved === "led" ? saved : "walnut";
    } catch {
      return "walnut";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("meow-theme", theme);
    } catch {
      /* private storage */
    }
  }, [theme]);
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => api<{ initialized: boolean }>("/setup"),
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<Settings>("/settings"),
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api<User>("/auth/me").catch((e) => {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }),
    retry: false,
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountMode, setAccountMode] = useState<"login" | "register">("login");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState("discover");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [country, setCountry] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Station | null>(null);
  const [selection, setSelection] = useState(0);
  const [notice, setNotice] = useState("");
  const [relay, setRelay] = useState(() => {
    try {
      return localStorage.getItem("meow-relay") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    try {
      localStorage.setItem("meow-relay", String(relay));
    } catch {
      /* no storage */
    }
  }, [relay]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const stations = useQuery({
    queryKey: ["stations", query, tag, country, page],
    queryFn: ({ signal }) =>
      api<Station[]>(
        `/stations?${new URLSearchParams({ q: query, tag, country, offset: String(page * 24) })}`,
        "GET",
        undefined,
        signal,
      ),
    enabled: setup.data?.initialized === true && tab === "discover",
  });
  const favorites = useQuery({
    queryKey: ["favorites", me.data?.id],
    queryFn: () => api<Station[]>("/favorites"),
    enabled: !!me.data,
  });
  const savedIds = new Set(favorites.data?.map((s) => s.id));
  const save = useMutation({
    mutationFn: ({ station, saved }: { station: Station; saved: boolean }) =>
      api(`/favorites/${station.id}`, saved ? "DELETE" : "PUT"),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["favorites"] });
    },
    onError: (e) => {
      setNotice(e.message);
      if (e instanceof ApiError && e.status === 401) {
        cache.setQueryData(["me"], null);
        setAccountOpen(true);
      }
    },
  });
  const toggleSave = (station: Station) => {
    if (!me.data) {
      setAccountOpen(true);
      return;
    }
    save.mutate({ station, saved: savedIds.has(station.id) });
  };
  const onAccount = (u: User) => {
    cache.setQueryData(["me"], u);
    cache.setQueryData(["setup"], { initialized: true });
    setAccountOpen(false);
    setNotice(`欢迎，${u.username}。你的频道已就位。`);
  };
  const logout = async () => {
    try {
      await api("/auth/logout", "POST");
      cache.setQueryData(["me"], null);
      cache.removeQueries({ queryKey: ["favorites"] });
      setRelay(false);
      setSelected(null);
      setTab("discover");
      setAccountOpen(false);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const choose = (s: Station) => {
    setSelected(s);
    setSelection((v) => v + 1);
  };
  const visible =
    tab === "favorites"
      ? (favorites.data || []).filter((s) =>
          `${s.name} ${s.tags} ${s.country}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : stations.data || [];
  const currentQuery = tab === "favorites" ? favorites : stations;
  const setupNeeded = setup.data?.initialized === false;
  if (setupNeeded)
    return (
      <div className="setup-page">
        <a className="brand" href="/">
          <Radio />
          <span>
            meow<span>Radio</span>
          </span>
        </a>
        <main className="setup-card">
          <div className="setup-icon">
            <Radio size={34} />
          </div>
          <p className="eyebrow">第一次见面，你好。</p>
          <h1>
            让这台收音机
            <br />
            成为你的。
          </h1>
          <p>
            创建首个管理员账号，完成初始化。之后，每个人都可以拥有自己的收藏频道。
          </p>
          <div className="setup-steps">
            <span className="complete">
              <Check size={14} /> SQLite 已就绪
            </span>
            <span>创建管理员</span>
            <span>开始收听</span>
          </div>
          <AccountForm mode="setup" onSuccess={onAccount} />
          <p className="setup-note">
            自动部署也可通过 MEOW_INIT_USERNAME 和 MEOW_INIT_PASSWORD
            初始化。此向导仅显示一次。
          </p>
        </main>
        <footer>meowRadio · 一个属于你的声音角落</footer>
      </div>
    );
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="meowRadio 首页">
          <Radio size={25} />
          <span>
            meow<span>Radio</span>
          </span>
          <span className="brand-note">把世界，调到喜欢的频道。</span>
        </a>
        <nav aria-label="账号与设置">
          <button
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="连接设置"
          >
            <Settings2 size={20} />
          </button>
          <button
            className="account-button"
            onClick={() => setAccountOpen(true)}
          >
            <UserRound size={17} />
            <span>{me.data?.username || "登录 / 注册"}</span>
          </button>
        </nav>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">A LITTLE RADIO. A WHOLE WORLD.</p>
            <h1>
              好声音，慢慢听<span>。</span>
            </h1>
            <p>从某座城市的清晨，到另一片海岸的深夜。</p>
          </div>
          <span className="intro-aside">
            <Headphones size={17} /> 留一点时间给耳朵
          </span>
        </div>
        {(setup.isError || me.isError) && (
          <div className="error-panel" role="alert">
            服务连接失败。
            <button
              onClick={() => {
                void setup.refetch();
                void me.refetch();
              }}
            >
              重新连接
            </button>
          </div>
        )}
        <Player
          theme={theme}
          station={selected}
          stations={visible}
          onSelect={choose}
          relay={relay && !!me.data}
          saved={!!selected && savedIds.has(selected.id)}
          onSave={() => selected && toggleSave(selected)}
          selection={selection}
        />
        <section className="station-section" aria-label="电台目录">
          <div className="library-header">
            <div className="tabs" role="tablist" aria-label="频道来源">
              <button
                role="tab"
                aria-selected={tab === "discover"}
                onClick={() => {
                  setTab("discover");
                  setPage(0);
                }}
              >
                <Globe2 size={18} />
                发现电台
              </button>
              <button
                role="tab"
                aria-selected={tab === "favorites"}
                onClick={() => {
                  setTab("favorites");
                  setPage(0);
                }}
              >
                <Heart size={18} />
                我的收藏
                {me.data && (
                  <span className="count">{favorites.data?.length || 0}</span>
                )}
              </button>
            </div>
            <div className="search-field">
              <Search size={17} />
              <input
                aria-label="搜索电台"
                placeholder="搜索你想听的电台…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                maxLength={100}
              />
              {search && (
                <button aria-label="清空搜索" onClick={() => setSearch("")}>
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
          {tab === "discover" && (
            <div className="filters">
              <div className="genre-filters">
                {[
                  ["", "全部频道"],
                  ["jazz", "爵士"],
                  ["classical", "古典"],
                  ["ambient", "氛围"],
                  ["pop", "流行"],
                  ["rock", "摇滚"],
                  ["news", "新闻"],
                ].map(([value, label]) => (
                  <button
                    className={tag === value ? "selected" : ""}
                    key={value}
                    aria-pressed={tag === value}
                    onClick={() => {
                      setTag(value);
                      setPage(0);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="country-filter">
                <Globe2 size={14} />
                <select
                  aria-label="按国家筛选"
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">世界各地</option>
                  <option value="CN">中国</option>
                  <option value="US">美国</option>
                  <option value="GB">英国</option>
                  <option value="JP">日本</option>
                  <option value="DE">德国</option>
                  <option value="FR">法国</option>
                  <option value="TW">中国台湾</option>
                </select>
              </label>
            </div>
          )}
          {tab === "favorites" && !me.data ? (
            <div className="empty-state">
              <Heart size={30} />
              <h3>为喜欢的声音留个位置</h3>
              <p>登录后，收藏会跟随你的账号保存。</p>
              <button className="primary" onClick={() => setAccountOpen(true)}>
                登录并收藏
                <ArrowUpRight size={16} />
              </button>
            </div>
          ) : currentQuery.isPending ? (
            <div
              className="station-grid"
              aria-label="正在加载电台"
              aria-busy="true"
            >
              {Array.from({ length: 6 }, (_, i) => (
                <div className="station-skeleton" key={i}>
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
              ))}
            </div>
          ) : currentQuery.isError ? (
            <div className="empty-state" role="alert">
              <Signal size={30} />
              <h3>信号暂时没有到达</h3>
              <p>{currentQuery.error.message}</p>
              <button
                className="primary"
                onClick={() => void currentQuery.refetch()}
              >
                <RotateCw size={16} />
                重新连接
              </button>
            </div>
          ) : !visible.length ? (
            <div className="empty-state">
              <Radio size={30} />
              <h3>
                {tab === "favorites" ? "还没有收藏的频道" : "没有找到这个声音"}
              </h3>
              <p>
                {tab === "favorites"
                  ? "在电台旁点一下爱心，把喜欢的声音留下来。"
                  : "试试其他关键词，或者选择更多国家和音乐类型。"}
              </p>
            </div>
          ) : (
            <div className="station-grid">
              {visible.map((s, i) => (
                <article
                  className={`station-card ${s.id === selected?.id ? "tuned" : ""}`}
                  key={s.id}
                >
                  <button
                    className="station-play"
                    onClick={() => choose(s)}
                    aria-label={`收听 ${s.name}`}
                  >
                    <span
                      className={`station-art art-${i % 6}`}
                      aria-hidden="true"
                    >
                      {s.name.trim().slice(0, 2).toUpperCase() || "FM"}
                    </span>
                    <span className="station-info">
                      <strong>{s.name}</strong>
                      <span>
                        {s.country || "世界电台"}
                        <span className="separator"> / </span>
                        {s.tags.split(",").filter(Boolean)[0] || "Radio"}
                      </span>
                      <span className="station-quality">
                        {s.codec || "AUDIO"}
                        {s.bitrate ? ` · ${s.bitrate} kbps` : ""}
                        {s.id === selected?.id ? " · 已选台" : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    className={`save-button icon-button ${savedIds.has(s.id) ? "saved" : ""}`}
                    aria-label={`${savedIds.has(s.id) ? "取消收藏" : "收藏"} ${s.name}`}
                    aria-pressed={savedIds.has(s.id)}
                    disabled={save.isPending}
                    onClick={() => toggleSave(s)}
                  >
                    <Heart
                      size={18}
                      fill={savedIds.has(s.id) ? "currentColor" : "none"}
                    />
                  </button>
                </article>
              ))}
            </div>
          )}
          {tab === "discover" && !stations.isError && (
            <div className="pagination">
              <span>
                {stations.isFetching
                  ? "正在寻找声音…"
                  : `第 ${page + 1} 页 · ${visible.length} 个频道`}
              </span>
              <div>
                <button
                  className="icon-button"
                  aria-label="上一页"
                  disabled={page === 0 || stations.isFetching}
                  onClick={() => setPage((v) => v - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="下一页"
                  disabled={
                    visible.length < 24 || stations.isFetching || page >= 416
                  }
                  onClick={() => setPage((v) => v + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
      <footer className="site-footer">
        <span>
          <Radio size={15} /> meowRadio <span className="footer-dot">·</span>{" "}
          为每一种心情，留一个频道。
        </span>
        <a
          href="https://www.radio-browser.info/"
          target="_blank"
          rel="noreferrer"
        >
          电台目录来自 Radio Browser <ArrowUpRight size={13} />
        </a>
      </footer>
      <Modal
        open={accountOpen}
        onOpenChange={setAccountOpen}
        title={
          me.data
            ? "我的收音机"
            : accountMode === "login"
              ? "欢迎回来"
              : "留住喜欢的声音"
        }
        description={
          me.data
            ? `${me.data.username} · ${me.data.role === "admin" ? "管理员" : "听众"}，收藏只属于你。`
            : "一个账号，一份自己的电台收藏。"
        }
      >
        {me.data ? (
          <div className="account-summary">
            <Heart size={24} />
            <p>已收藏 {favorites.data?.length || 0} 个电台</p>
            <button className="secondary" onClick={() => void logout()}>
              <LogOut size={16} />
              退出登录
            </button>
          </div>
        ) : (
          <>
            <AccountForm
              key={accountMode}
              mode={accountMode}
              onSuccess={onAccount}
            />
            {settings.data?.registration_enabled && (
              <button
                className="text-button"
                onClick={() =>
                  setAccountMode((v) => (v === "login" ? "register" : "login"))
                }
              >
                {accountMode === "login"
                  ? "还没有账号？创建一个"
                  : "已有账号？返回登录"}
              </button>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="外观与连接"
        description="让收音机成为你喜欢的样子。"
      >
        <fieldset className="theme-options">
          <legend>收音机主题</legend>
          <label className={theme === "walnut" ? "chosen" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === "walnut"}
              onChange={() => setTheme("walnut")}
            />
            <span className="theme-preview walnut-preview" />
            <strong>胡桃木</strong>
            <small>温暖的模拟时光</small>
          </label>
          <label className={theme === "vitreous" ? "chosen" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === "vitreous"}
              onChange={() => setTheme("vitreous")}
            />
            <span className="theme-preview vitreous-preview" />
            <strong>琉璃夜色</strong>
            <small>青紫光影，玻璃质感</small>
          </label>
          <label className={theme === "led" ? "chosen" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === "led"}
              onChange={() => setTheme("led")}
            />
            <span className="theme-preview led-preview" />
            <strong>光阵立方</strong>
            <small>三面 LED，点亮声音</small>
          </label>
        </fieldset>
        <div className="connection-status">
          <Cable size={22} />
          <div>
            <strong>
              {settings.data?.proxy_configured
                ? "服务端代理已配置"
                : "服务端使用直接连接"}
            </strong>
            <p>代理地址与凭据由部署者管理。</p>
          </div>
        </div>
        <fieldset className="playback-options">
          <legend>收听方式</legend>
          <label>
            <input
              type="radio"
              name="connection"
              checked={!relay}
              onChange={() => setRelay(false)}
            />
            <span>
              <strong>浏览器直连</strong>
              <small>直接连接电台，支持普通音频和 HLS。</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="connection"
              checked={relay}
              disabled={!me.data || !settings.data?.relay_enabled}
              onChange={() => setRelay(true)}
            />
            <span>
              <strong>服务端中转</strong>
              <small>
                {!me.data
                  ? "登录后可用。"
                  : !settings.data?.relay_enabled
                    ? "此服务未启用中转。"
                    : "适合 HTTP 电台或浏览器无法连接的音源。"}
              </small>
            </span>
          </label>
        </fieldset>
        <p className="settings-note">
          中转支持公共 HTTP/HTTPS 音频流。配置代理时仅中转 HTTP 音源；HTTPS 与
          HLS 音源请选择直连。
        </p>
        <button className="primary" onClick={() => setSettingsOpen(false)}>
          完成
          <Check size={16} />
        </button>
      </Modal>
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="关闭提示"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
