import TransientCopy from "./TransientCopy";
import i18n, { tr, setLanguage } from "./i18n";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Radio,
  Heart,
  Settings2,
  UserRound,
  X,
  ArrowUpRight,
  Globe2,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
  Signal,
  RotateCw,
  Check,
  Cable,
} from "lucide-react";
import { api, ApiError } from "./api";
import type { Station, User, Settings } from "./api";
import Player from "./Player";
import AccountForm from "./AccountForm";
import useTheme from "./useTheme";
import { Link, useNavigate } from "react-router-dom";
import { requiresRelay } from "./playback";
import { readBrowseState, saveBrowseState } from "./browseState";
import StationSearch from "./StationSearch";
import StationFilters, { DEFAULT_FILTERS, filterCount } from "./StationFilters";
import type { Filters } from "./StationFilters";
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
  useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
          <Dialog.Close
            className="modal-close icon-button"
            aria-label={tr("关闭")}
          >
            <X size={20} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export default function App({ active = true }: { active?: boolean }) {
  useTranslation();
  const cache = useQueryClient();
  const [theme, setTheme, colorMode, setColorMode] = useTheme();
  const navigate = useNavigate();
  useEffect(() => {
    if (active) document.title = tr("阿喵收音机");
  }, [active, i18n.language]);
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () =>
      api<{
        initialized: boolean;
      }>("/setup"),
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pendingAction = useRef<{
    kind: "save" | "proxy";
    station: Station;
    saved?: boolean;
    expectedUserId?: number;
    remember?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!active) {
      setSettingsOpen(false);
      setAccountOpen(false);
    }
  }, [active]);
  const [tab, setTab] = useState("discover");
  const [savedBrowse] = useState(readBrowseState);
  const [search, setSearch] = useState(savedBrowse.query);
  const [query, setQuery] = useState(savedBrowse.query);
  const [filters, setFilters] = useState<Filters>(savedBrowse.filters);
  const { tag, country, language, sort, codec, bitrateMin } = filters;
  const [page, setPage] = useState(savedBrowse.page);
  useEffect(
    () => saveBrowseState({ query, filters, page }),
    [query, filters, page],
  );
  const [selected, setSelected] = useState<Station | null>(null);
  const [selection, setSelection] = useState(0);
  const [notice, setNotice] = useState<
    string | { key: string; values: Record<string, unknown> }
  >("");
  const [relayPreference, setRelayPreference] = useState(() => {
    try {
      return localStorage.getItem("meow-relay") === "true";
    } catch {
      return false;
    }
  });
  const [relay, setRelay] = useState(relayPreference);
  const commitSearch = useCallback((value: string) => {
    setQuery(value);
    setPage(0);
  }, []);
  const clearFilters = () => {
    setFilters({
      ...DEFAULT_FILTERS,
    });
    setPage(0);
  };
  useEffect(() => {
    try {
      localStorage.setItem("meow-relay", String(relayPreference));
    } catch {
      /* no storage */
    }
  }, [relayPreference]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const stations = useQuery({
    queryKey: [
      "stations",
      query,
      tag,
      country,
      language,
      sort,
      codec,
      bitrateMin,
      page,
    ],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api<Station[]>(
        `/stations?${new URLSearchParams({
          q: query,
          tag,
          country,
          language,
          sort,
          codec,
          bitrate_min: String(bitrateMin),
          offset: String(page * 24),
        })}`,
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
  const proxyTest = useMutation({
    mutationFn: () =>
      api<{
        ok: boolean;
        mode: string;
        elapsed_ms: number;
        target: string;
      }>("/proxy/test", "POST"),
  });
  const save = useMutation({
    mutationFn: ({
      station,
      saved,
    }: {
      station: Station;
      saved: boolean;
      userId: number;
    }) => api(`/favorites/${station.id}`, saved ? "DELETE" : "PUT"),
    onSuccess: () => {
      void cache.invalidateQueries({
        queryKey: ["favorites"],
      });
    },
    onError: (e, variables) => {
      if (e instanceof ApiError && e.status === 401) {
        pendingAction.current = {
          kind: "save",
          station: variables.station,
          saved: variables.saved,
          expectedUserId: variables.userId,
        };
        cache.setQueryData(["me"], null);
        navigate("/login");
        return;
      }
      setNotice(e.message);
    },
  });
  const toggleSave = (station: Station) => {
    if (!me.data) {
      pendingAction.current = {
        kind: "save",
        station,
      };
      navigate("/login");
      return;
    }
    save.mutate({
      station,
      saved: savedIds.has(station.id),
      userId: me.data.id,
    });
  };
  const onAccount = (u: User) => {
    cache.setQueryData(["me"], u);
    cache.setQueryData(["setup"], {
      initialized: true,
    });
    setAccountOpen(false);
    setNotice({
      key: "已登录：{{v0}}",
      values: {
        v0: u.username,
      },
    });
  };
  const logout = async () => {
    try {
      await api("/auth/logout", "POST");
      cache.setQueryData(["me"], null);
      cache.removeQueries({
        queryKey: ["favorites"],
      });
      setRelay(false);
      setSelected(null);
      setTab("discover");
      setAccountOpen(false);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const selectStation = (station: Station) => {
    setSelected(station);
    setSelection((v) => v + 1);
  };
  const chooseProxy = (station: Station, remember = false) => {
    if (!me.data) {
      pendingAction.current = { kind: "proxy", station, remember };
      navigate("/login");
      return;
    }
    if (!settings.data?.relay_enabled) {
      setNotice("服务端中转未启用，请联系管理员");
      return;
    }
    if (remember) setRelayPreference(true);
    setRelay(true);
    selectStation(station);
  };
  const choose = (station: Station) => {
    if (relayPreference || requiresRelay(station)) {
      chooseProxy(station);
      return;
    }
    setRelay(false);
    selectStation(station);
  };
  const changePlaybackPreference = (value: boolean) => {
    setRelayPreference(value);
    if (selected) {
      if (value || requiresRelay(selected)) chooseProxy(selected);
      else {
        setRelay(false);
        selectStation(selected);
      }
    }
  };
  const relayAuthRequired = () => {
    if (!selected) return;
    pendingAction.current = { kind: "proxy", station: selected };
    cache.setQueryData(["me"], null);
    navigate("/login");
  };
  useEffect(() => {
    if (!me.data || !settings.data || !active || !pendingAction.current) return;
    const action = pendingAction.current;
    pendingAction.current = null;
    if (
      action.expectedUserId !== undefined &&
      action.expectedUserId !== me.data.id
    ) {
      setNotice("账号已切换，请重新操作收藏");
      return;
    }
    if (action.kind === "save")
      save.mutate({
        station: action.station,
        saved: action.saved ?? false,
        userId: me.data.id,
      });
    else chooseProxy(action.station, action.remember);
  }, [me.data, settings.data, active]);
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
        <Link className="brand" to="/">
          <img
            className="brand-logo"
            src="/branding/logo-256.webp"
            width="40"
            height="40"
            alt=""
          />
          <span>
            {tr("阿喵")}
            <span>{tr("收音机")}</span>
          </span>
        </Link>
        <main className="setup-card">
          <div className="setup-icon">
            <img
              src="/branding/logo-256.webp"
              width="96"
              height="96"
              alt={tr("阿喵收音机 Logo")}
            />
          </div>
          <h1>{tr("初始化设置")}</h1>
          <TransientCopy>{tr("第一次见面，你好。")}</TransientCopy>
          <p>
            {tr(
              "创建首个管理员账号，完成初始化。之后，每个人都可以拥有自己的收藏频道。",
            )}
          </p>
          <div className="setup-steps">
            <span className="complete">
              <Check size={14} />
              {tr("SQLite 已就绪")}
            </span>
            <span>{tr("创建管理员")}</span>
            <span>{tr("开始收听")}</span>
          </div>
          <AccountForm mode="setup" onSuccess={onAccount} />
          <p className="setup-note">
            {tr(
              "自动部署也可通过 MEOW_INIT_USERNAME 和 MEOW_INIT_PASSWORD 初始化。此向导仅显示一次。",
            )}
          </p>
        </main>
        <footer>
          <TransientCopy>
            {tr("阿喵收音机 · 一个属于你的声音角落")}
          </TransientCopy>
        </footer>
      </div>
    );
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand" to="/" aria-label={tr("阿喵收音机首页")}>
          <img
            className="brand-logo"
            src="/branding/logo-256.webp"
            width="40"
            height="40"
            alt=""
          />
          <span>
            {tr("阿喵")}
            <span>{tr("收音机")}</span>
          </span>
        </Link>
        <nav aria-label={tr("账号与设置")}>
          <div className="home-appearance">
            <label className="home-language">
              <span className="sr-only">{tr("语言")}</span>
              <select
                aria-label={tr("语言")}
                value={i18n.language === "en" ? "en" : "zh"}
                onChange={(e) => setLanguage(e.target.value as "zh" | "en")}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <button
              className="icon-button"
              onClick={() =>
                setColorMode(colorMode === "dark" ? "light" : "dark")
              }
              aria-label={
                colorMode === "dark" ? tr("切换浅色") : tr("切换暗色")
              }
              title={colorMode === "dark" ? tr("切换浅色") : tr("切换暗色")}
            >
              {colorMode === "dark" ? <Sun size={19} /> : <Moon size={19} />}
            </button>
          </div>
          <button
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label={tr("连接设置")}
          >
            <Settings2 size={20} />
          </button>
          <button
            className="account-button"
            aria-label={me.data?.username || tr("登录 / 注册")}
            onClick={() =>
              me.data ? setAccountOpen(true) : navigate("/login")
            }
          >
            <UserRound size={17} />
            <span>{me.data?.username || tr("登录 / 注册")}</span>
          </button>
        </nav>
      </header>
      <main aria-label={tr("收听首页")}>
        <h1 className="sr-only">{tr("阿喵收音机")}</h1>
        <TransientCopy className="home-greeting">
          {tr("把世界，调到喜欢的频道。")}
        </TransientCopy>
        {(setup.isError || me.isError) && (
          <div className="error-panel" role="alert">
            {tr("服务连接失败。")}
            <button
              onClick={() => {
                void setup.refetch();
                void me.refetch();
              }}
            >
              {tr("重新连接")}
            </button>
          </div>
        )}
        <Player
          active={active}
          theme={theme}
          station={selected}
          stations={visible}
          onSelect={choose}
          relay={relay}
          onRelayAuthRequired={relayAuthRequired}
          saved={!!selected && savedIds.has(selected.id)}
          onSave={() => selected && toggleSave(selected)}
          selection={selection}
        />
        <section className="station-section" aria-label={tr("电台目录")}>
          <div className="library-header">
            <div className="tabs" role="tablist" aria-label={tr("频道来源")}>
              <button
                role="tab"
                aria-selected={tab === "discover"}
                onClick={() => {
                  setTab("discover");
                  setPage(0);
                }}
              >
                <Globe2 size={18} />
                {tr("发现电台")}
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
                {tr("我的收藏")}
                {me.data && (
                  <span className="count">{favorites.data?.length || 0}</span>
                )}
              </button>
            </div>
            <div className="library-tools">
              <StationSearch
                value={search}
                committedValue={query}
                onChange={setSearch}
                onCommit={commitSearch}
              />
              {tab === "discover" && active && (
                <StationFilters
                  value={filters}
                  onApply={(next) => {
                    setFilters(next);
                    setPage(0);
                  }}
                />
              )}
            </div>
          </div>
          <p id="search-help" className="sr-only">
            {tr(
              "支持电台名称、FM 或频率关键词；也可使用筛选按钮按国家和语言浏览。",
            )}
          </p>
          <p className="search-progress" role="status" aria-live="polite">
            {tab === "discover" && stations.isFetching
              ? stations.isPlaceholderData
                ? tr("正在搜索，暂时显示上一次结果…")
                : tr("正在寻找电台…")
              : currentQuery.isSuccess
                ? tr("{{v0}} {{v1}} 个电台", {
                    v0: tab === "favorites" ? tr("收藏中匹配") : tr("本页找到"),
                    v1: visible.length,
                  })
                : ""}
          </p>
          {tab === "favorites" && !me.data ? (
            <div className="empty-state">
              <Heart size={30} />
              <h3>{tr("登录后查看收藏")}</h3>
              <p>{tr("登录后，收藏会跟随你的账号保存。")}</p>
              <button
                className="primary"
                onClick={() =>
                  me.data ? setAccountOpen(true) : navigate("/login")
                }
              >
                {tr("登录并收藏")}
                <ArrowUpRight size={16} />
              </button>
            </div>
          ) : currentQuery.isPending ? (
            <div
              className="station-grid"
              aria-label={tr("正在加载电台")}
              aria-busy="true"
            >
              {Array.from(
                {
                  length: 6,
                },
                (_, i) => (
                  <div className="station-skeleton" key={i}>
                    <span />
                    <div>
                      <i />
                      <i />
                    </div>
                  </div>
                ),
              )}
            </div>
          ) : currentQuery.isError ? (
            <div className="empty-state" role="alert">
              <Signal size={30} />
              <h3>{tr("电台加载失败")}</h3>
              <p>{tr(currentQuery.error.message)}</p>
              <button
                className="primary"
                onClick={() => void currentQuery.refetch()}
              >
                <RotateCw size={16} />
                {tr("重新连接")}
              </button>
            </div>
          ) : !visible.length ? (
            <div className="empty-state">
              <Radio size={30} />
              <h3>
                {tab === "favorites"
                  ? tr("还没有收藏的频道")
                  : tr("没有找到电台")}
              </h3>
              <p>
                {tab === "favorites"
                  ? query
                    ? tr("收藏里没有匹配的电台，可以到全部电台中继续搜索。")
                    : tr("点击电台旁的爱心即可收藏。")
                  : filterCount(filters) > 0
                    ? tr(
                        "当前关键词和筛选条件没有同时匹配的电台，试试放宽国家或分类。",
                      )
                    : tr(
                        "试试电台简称，或只输入频率数字（例如 104.2）。目录未收录的电台无法显示。",
                      )}
              </p>
              <div className="empty-actions">
                {tab === "favorites" && query && (
                  <button
                    className="primary"
                    onClick={() => {
                      setTab("discover");
                      clearFilters();
                    }}
                  >
                    {tr("在全部电台中搜索")}
                  </button>
                )}
                {tab === "discover" && filterCount(filters) > 0 && (
                  <button className="primary" onClick={clearFilters}>
                    {tr("清除筛选条件")}
                  </button>
                )}
                {query && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setSearch("");
                      commitSearch("");
                    }}
                  >
                    {tr("清空关键词")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              className="station-grid"
              aria-busy={tab === "discover" && stations.isFetching}
            >
              {visible.map((s, i) => (
                <article
                  className={`station-card ${s.id === selected?.id ? "tuned" : ""}`}
                  key={s.id}
                >
                  <button
                    className="station-play"
                    onClick={() => choose(s)}
                    aria-label={tr("收听 {{v0}}", {
                      v0: s.name,
                    })}
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
                        {s.country || tr("世界电台")}
                        <span className="separator"> / </span>
                        {s.tags.split(",").filter(Boolean)[0] || "Radio"}
                      </span>
                      <span className="station-quality">
                        {s.codec || "AUDIO"}
                        {s.bitrate ? ` · ${s.bitrate} kbps` : ""}
                        {s.id === selected?.id ? tr(" · 已选台") : ""}
                      </span>
                    </span>
                  </button>
                  <div className="station-actions">
                    <button
                      className={`proxy-play icon-button ${s.id === selected?.id && relay ? "active" : ""}`}
                      aria-label={tr("代理收听 {{v0}}", {
                        v0: s.name,
                      })}
                      aria-pressed={s.id === selected?.id && relay}
                      title={tr("通过服务端收听")}
                      onClick={() => chooseProxy(s, true)}
                    >
                      <Cable size={18} />
                    </button>
                    <button
                      className={`save-button icon-button ${savedIds.has(s.id) ? "saved" : ""}`}
                      aria-label={`${savedIds.has(s.id) ? tr("取消收藏") : tr("收藏")} ${s.name}`}
                      aria-pressed={savedIds.has(s.id)}
                      disabled={save.isPending}
                      onClick={() => toggleSave(s)}
                    >
                      <Heart
                        size={18}
                        fill={savedIds.has(s.id) ? "currentColor" : "none"}
                      />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {tab === "discover" && !stations.isError && (
            <div className="pagination">
              <span>
                {stations.isFetching
                  ? tr("正在加载电台")
                  : tr("第 {{v0}} 页 · {{v1}} 个频道", {
                      v0: page + 1,
                      v1: visible.length,
                    })}
              </span>
              <div>
                <button
                  className="icon-button"
                  aria-label={tr("上一页")}
                  disabled={page === 0 || stations.isFetching}
                  onClick={() => setPage((v) => v - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label={tr("下一页")}
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
        <a
          href="https://www.radio-browser.info/"
          target="_blank"
          rel="noreferrer"
        >
          {tr("电台目录来自 Radio Browser")}
          <ArrowUpRight size={13} />
        </a>
      </footer>
      <Modal
        open={accountOpen}
        onOpenChange={setAccountOpen}
        title={tr("我的收音机")}
        description={
          me.data
            ? tr("{{v0}} · {{v1}}", {
                v0: me.data.username,
                v1: me.data.role === "admin" ? tr("管理员") : tr("听众"),
              })
            : ""
        }
      >
        {me.data && (
          <div className="account-summary">
            <Heart size={24} />
            <p>
              {tr("已收藏")}
              {favorites.data?.length || 0}
              {tr("个电台")}
            </p>
            <button className="secondary" onClick={() => void logout()}>
              <LogOut size={16} />
              {tr("退出登录")}
            </button>
          </div>
        )}
      </Modal>
      <Modal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title={tr("外观与连接")}
        description={tr("收音机外观与播放方式。")}
      >
        <fieldset className="theme-options">
          <legend>{tr("收音机主题")}</legend>
          <label className={theme === "walnut" ? "chosen" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === "walnut"}
              onChange={() => setTheme("walnut")}
            />
            <span className="theme-preview walnut-preview" />
            <strong>{tr("胡桃木")}</strong>
            <small>
              <TransientCopy>{tr("温暖的模拟时光")}</TransientCopy>
            </small>
          </label>
          <label className={theme === "vitreous" ? "chosen" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === "vitreous"}
              onChange={() => setTheme("vitreous")}
            />
            <span className="theme-preview vitreous-preview" />
            <strong>{tr("琉璃夜色")}</strong>
            <small>
              <TransientCopy>{tr("青紫光影，玻璃质感")}</TransientCopy>
            </small>
          </label>
          <label className={theme === "led" ? "chosen" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === "led"}
              onChange={() => setTheme("led")}
            />
            <span className="theme-preview led-preview" />
            <strong>{tr("光阵立方")}</strong>
            <small>
              <TransientCopy>{tr("三面 LED，点亮声音")}</TransientCopy>
            </small>
          </label>
          <label className={theme === "soft" ? "chosen" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === "soft"}
              onChange={() => setTheme("soft")}
            />
            <span className="theme-preview soft-preview" />
            <strong>{tr("云白拟态")}</strong>
            <small>
              <TransientCopy>{tr("轻柔机身，圆形调谐")}</TransientCopy>
            </small>
          </label>
        </fieldset>
        <div className="connection-status">
          <Cable size={22} />
          <div>
            <strong>
              {settings.data?.proxy_configured
                ? tr("服务端代理已配置")
                : tr("服务端使用直接连接")}
            </strong>
            <p>{tr("代理地址与凭据由部署者管理。")}</p>
          </div>
        </div>
        <div className="proxy-test">
          <button
            className="secondary"
            disabled={!me.data || proxyTest.isPending}
            onClick={() => proxyTest.mutate()}
          >
            {proxyTest.isPending
              ? tr("正在测试…")
              : settings.data?.proxy_configured
                ? tr("测试代理连接")
                : tr("测试服务端连接")}
          </button>
          {!me.data && <p>{tr("登录后可测试连接。")}</p>}
          {proxyTest.data && (
            <p role="status">
              {proxyTest.data.mode === "proxy"
                ? tr("代理连接正常")
                : tr("服务端外网连接正常")}{" "}
              · {proxyTest.data.elapsed_ms} ms
            </p>
          )}
          {proxyTest.error && (
            <p className="form-error" role="alert">
              {tr(proxyTest.error.message)}
            </p>
          )}
        </div>
        <fieldset className="playback-options">
          <legend>{tr("默认播放方式")}</legend>
          <label>
            <input
              type="radio"
              name="connection"
              checked={!relayPreference}
              onChange={() => changePlaybackPreference(false)}
            />
            <span>
              <strong>{tr("浏览器直连")}</strong>
              <small>{tr("直接连接电台，支持普通音频和 HLS。")}</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="connection"
              checked={relayPreference}
              disabled={!me.data || !settings.data?.relay_enabled}
              onChange={() => changePlaybackPreference(true)}
            />
            <span>
              <strong>{tr("服务端中转")}</strong>
              <small>
                {!me.data
                  ? tr("登录后可用。")
                  : !settings.data?.relay_enabled
                    ? tr("此服务未启用中转。")
                    : tr("适合 HTTP 电台或浏览器无法连接的音源。")}
              </small>
            </span>
          </label>
        </fieldset>
        <p className="settings-note">
          {tr(
            "服务器播放支持 HTTP、HTTPS 和 HLS；HTTPS 页面上的 HTTP 音源会自动中转。",
          )}
        </p>
        <p className="app-version">
          {tr("版本")} {settings.data?.version || "—"}
        </p>
        <button className="primary" onClick={() => setSettingsOpen(false)}>
          {tr("完成")}
          <Check size={16} />
        </button>
      </Modal>
      {notice && (
        <div className="toast" role="status">
          {typeof notice === "string"
            ? tr(notice)
            : tr(notice.key, notice.values)}
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label={tr("关闭提示")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
