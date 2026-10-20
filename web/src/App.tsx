import PersonalFilters from "./PersonalFilters";
import {
  SOURCE_CHANGE,
  type SourceChange,
  type PersonalPage,
  type PersonalSource,
} from "./personalSources";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import RecordingSettings from "./RecordingSettings";
import RecordingLibrary from "./RecordingLibrary";
import ProfileSettings from "./ProfileSettings";
import type { RecordedAudio } from "./useRecording";
import "./user-menu.css";
import * as Tabs from "@radix-ui/react-tabs";
import { receiverThemes } from "./receiverThemes";
import TransientCopy from "./TransientCopy";
import i18n, { tr, setLanguage } from "./i18n";
import { useTranslation } from "react-i18next";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";
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
  Disc3,
  ListMusic,
  LayoutGrid,
  Sparkles,
} from "lucide-react";
import { api, rawApi, ApiError } from "./api";
import type {
  Station,
  User,
  Settings,
  FavoritesSummary,
  FavoritesPage,
  Exploration,
} from "./api";
import type { SceneVisibility } from "./StationScene";
import Player from "./Player";
import AccountForm from "./AccountForm";
import useTheme from "./useTheme";
import { Link, useNavigate } from "react-router-dom";
import { requiresRelay } from "./playback";
import { readBrowseState, saveBrowseState } from "./browseState";
import StationSearch from "./StationSearch";
import StationFilters, { DEFAULT_FILTERS, filterCount } from "./StationFilters";
import type { Filters } from "./StationFilters";
import type { WorldView } from "./StationWorld";
import "./station-world.css";
import { countGenres, genreIndex } from "./stationGenres";
const EMPTY_STATIONS: Station[] = [];
const StationWorld = lazy(() => import("./StationWorld"));
function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal ${className}`}>
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [pauseRequest, setPauseRequest] = useState(0);
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
      setProfileOpen(false);
      setRecordingsOpen(false);
    }
  }, [active]);
  const [tab, setTab] = useState("discover");
  const [view, setView] = useState<"list" | WorldView>(() => {
    try {
      const saved = localStorage.getItem("meow-directory-view");
      return saved === "globe" || saved === "nebula" ? saved : "list";
    } catch {
      return "list";
    }
  });
  const [pageSize, setPageSize] = useState(() => {
    try {
      const size = Number(localStorage.getItem("meow-page-size"));
      return [24, 100, 500, 1000].includes(size) ? size : 24;
    } catch {
      return 24;
    }
  });
  const [worldGenre, setWorldGenre] = useState<number | null>(null);
  const [visibleCountries, setVisibleCountries] = useState<
    string[] | undefined
  >();
  const [detailCountries, setDetailCountries] = useState<string[]>([]);
  const [detailGenres, setDetailGenres] = useState<string[]>([]);
  const [drillGenre, setDrillGenre] = useState<string | null>(null);
  const worldNodes = useRef<Station[]>([]);
  const [autoDetail, setAutoDetail] = useState(0);
  const [drillDetail, setDrillDetail] = useState(0);
  const [worldScope, setWorldScope] = useState(0);
  const lastCameraKey = useRef("");
  const lastDrillKey = useRef("");
  const worldDetail = Math.max(autoDetail, drillDetail);
  const requestedGenres = drillGenre ? [drillGenre] : detailGenres;
  const onWorldVisibility = useCallback(
    (visibility: SceneVisibility) => {
      setVisibleCountries((previous) =>
        previous?.join(",") === visibility.countries.join(",")
          ? previous
          : visibility.countries,
      );
      if (lastCameraKey.current === visibility.cameraKey) return;
      lastCameraKey.current = visibility.cameraKey;
      const distance = visibility.distance;
      if (view === "nebula" && drillGenre === "*" && distance > 5.5) {
        setDrillGenre(null);
        setDrillDetail(0);
      }
      const detail =
        view === "globe"
          ? distance < 2.4
            ? 3
            : distance < 3
              ? 2
              : distance < 3.8
                ? 1
                : 0
          : distance < 2.7
            ? 3
            : distance < 3
              ? 2
              : distance < 4
                ? 1
                : 0;
      setAutoDetail(detail);
      setDetailCountries(visibility.countries.slice(0, 6).sort());
      const visible = new Set(visibility.ids);
      setDetailGenres(
        worldNodes.current
          .filter(
            (node) => node.cluster?.kind === "genre" && visible.has(node.id),
          )
          .map((node) => node.cluster!.key)
          .slice(0, 6)
          .sort(),
      );
    },
    [view, drillGenre],
  );
  useEffect(() => {
    setVisibleCountries(undefined);
    setDetailCountries([]);
    setDetailGenres([]);
    setDrillGenre(null);
    setAutoDetail(0);
    setDrillDetail(0);
    lastCameraKey.current = "";
    lastDrillKey.current = "";
  }, [view, tab]);
  useEffect(() => {
    try {
      localStorage.setItem("meow-page-size", String(pageSize));
    } catch {
      /* no storage */
    }
  }, [pageSize]);
  useEffect(() => {
    try {
      localStorage.setItem("meow-directory-view", view);
    } catch {
      /* no storage */
    }
  }, [view]);
  const [savedBrowse] = useState(readBrowseState);
  const [search, setSearch] = useState(savedBrowse.query);
  const [query, setQuery] = useState(savedBrowse.query);
  const [filters, setFilters] = useState<Filters>(savedBrowse.filters);
  const { tag, country, language, sort, codec, bitrateMin } = filters;
  const [page, setPage] = useState(savedBrowse.page);
  const [favoritesPage, setFavoritesPage] = useState(0);
  const [personalPage, setPersonalPage] = useState(0);
  const [personalSource, setPersonalSource] = useState("");
  const [personalCategory, setPersonalCategory] = useState("");
  useEffect(() => setFavoritesPage(0), [me.data?.id]);
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
    setDrillGenre(null);
    setWorldScope((value) => value + 1);
    setDrillDetail(0);
    setQuery(value);
    setPage(0);
    setFavoritesPage(0);
    setPersonalPage(0);
  }, []);
  const clearFilters = () => {
    setDrillGenre(null);
    setWorldScope((value) => value + 1);
    setDrillDetail(0);
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
      pageSize,
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
          offset: String(page * pageSize),
          limit: String(pageSize),
        })}`,
        "GET",
        undefined,
        signal,
      ),
    enabled:
      setup.data?.initialized === true && tab === "discover" && view === "list",
  });
  const favorites = useQuery({
    queryKey: ["favorites", "summary", me.data?.id],
    queryFn: () => api<FavoritesSummary>("/favorites/summary"),
    enabled: !!me.data,
  });
  const favoriteStations = useQuery({
    queryKey: [
      "favorites",
      "page",
      me.data?.id,
      query,
      favoritesPage,
      pageSize,
    ],
    queryFn: ({ signal }) =>
      api<FavoritesPage>(
        `/favorites/page?${new URLSearchParams({ q: query, page: String(favoritesPage), page_size: String(pageSize) })}`,
        "GET",
        undefined,
        signal,
      ),
    enabled: !!me.data && tab === "favorites" && active && view === "list",
  });
  useEffect(() => {
    if (favoriteStations.data && favoriteStations.data.page !== favoritesPage)
      setFavoritesPage(favoriteStations.data.page);
  }, [favoriteStations.data, favoritesPage]);
  const personalSources = useQuery({
    queryKey: ["personal-sources", me.data?.id],
    queryFn: () => api<PersonalSource[]>("/personal-sources"),
    enabled: !!me.data && tab === "personal",
  });
  const personalStations = useQuery({
    queryKey: [
      "personal-stations",
      "browse",
      me.data?.id,
      query,
      personalPage,
      personalSource,
      personalCategory,
      pageSize,
    ],
    queryFn: ({ signal }) =>
      api<PersonalPage>(
        `/personal-stations?${new URLSearchParams({ q: query, page: String(personalPage), page_size: String(pageSize), ...(personalSource ? { source_id: personalSource } : {}), category: personalCategory })}`,
        "GET",
        undefined,
        signal,
      ),
    enabled: !!me.data && tab === "personal" && active && view === "list",
  });
  const worldStations = useQuery({
    queryKey: [
      tab === "favorites"
        ? "favorites"
        : tab === "personal"
          ? "personal-stations"
          : "stations",
      "explore",
      worldScope,
      tab === "discover" ? null : me.data?.id,
      query,
      tag,
      country,
      language,
      sort,
      codec,
      bitrateMin,
      personalSource,
      personalCategory,
      view,
      tab === "discover" ? worldDetail : 0,
      tab === "discover" && worldDetail > 0 && !country && view === "globe"
        ? detailCountries
        : [],
      tab === "discover" && worldDetail > 0 && view === "nebula"
        ? requestedGenres
        : [],
    ],
    queryFn: async ({ signal }) => {
      if (tab === "personal") {
        const result = await api<PersonalPage>(
          `/personal-stations/explore?${new URLSearchParams({ q: query, ...(personalSource ? { source_id: personalSource } : {}), category: personalCategory })}`,
          "GET",
          undefined,
          signal,
        );
        return {
          items: result.items,
          total: result.total,
          complete: true,
          cameraScope: String(worldScope),
        };
      }
      if (tab === "favorites") {
        const result = await api<Station[]>(
          "/favorites",
          "GET",
          undefined,
          signal,
        );
        const needle = query.toLowerCase();
        const items = result.filter((station) =>
          `${station.name} ${station.tags} ${station.country}`
            .toLowerCase()
            .includes(needle),
        );
        return {
          items,
          total: items.length,
          complete: true,
          cameraScope: String(worldScope),
        };
      }
      const result = await api<Exploration>(
        `/stations/explore?${new URLSearchParams({ q: query, tag, country, language, sort, codec, bitrate_min: String(bitrateMin), view, detail: String(worldDetail), countries: worldDetail > 0 && !country && view === "globe" ? detailCountries.join(",") : "", genres: worldDetail > 0 && view === "nebula" ? requestedGenres.join(",") : "" })}`,
        "GET",
        undefined,
        signal,
      );
      return { ...result, cameraScope: String(worldScope) };
    },
    staleTime: 600_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[0] ===
        (tab === "favorites"
          ? "favorites"
          : tab === "personal"
            ? "personal-stations"
            : "stations") &&
      previousQuery?.queryKey[2] === worldScope &&
      previousQuery?.queryKey[3] === (tab === "discover" ? null : me.data?.id)
        ? previous
        : undefined,
    enabled:
      active &&
      view !== "list" &&
      setup.data?.initialized === true &&
      (tab === "discover" || !!me.data),
  });
  useEffect(
    () => setWorldGenre(null),
    [
      tab,
      query,
      tag,
      country,
      language,
      codec,
      bitrateMin,
      personalSource,
      personalCategory,
    ],
  );
  const allWorldStations = worldStations.data?.items || EMPTY_STATIONS;
  worldNodes.current = allWorldStations;
  const worldGenreCounts = useMemo(
    () => countGenres(allWorldStations),
    [allWorldStations],
  );
  useEffect(() => {
    if (worldGenre !== null && worldGenreCounts[worldGenre] === 0)
      setWorldGenre(null);
  }, [worldGenre, worldGenreCounts]);
  const filteredWorldStations = useMemo(
    () =>
      view === "nebula" && worldGenre !== null
        ? allWorldStations.filter(
            (station) => genreIndex(station) === worldGenre,
          )
        : allWorldStations,
    [view, worldGenre, allWorldStations],
  );
  useEffect(() => {
    if (personalStations.data && personalStations.data.page !== personalPage)
      setPersonalPage(personalStations.data.page);
  }, [personalStations.data, personalPage]);
  useEffect(() => {
    const update = async (change: SourceChange) => {
      if (change.owner !== me.data?.id) return;
      void cache.invalidateQueries({ queryKey: ["personal-sources"] });
      void cache.invalidateQueries({ queryKey: ["personal-stations"] });
      void cache.invalidateQueries({ queryKey: ["favorites"] });
      if (!selected?.personal) return;
      const id = selected.id;
      if (change.all || change.stationId === id) {
        setSelected((current) => (current?.id === id ? null : current));
        return;
      }
      if (change.sourceId === selected.source_id) {
        try {
          await api(`/personal-stations/${id}`);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404)
            setSelected((current) => (current?.id === id ? null : current));
        }
      }
    };
    const event = (event: Event) =>
      void update((event as CustomEvent<SourceChange>).detail);
    window.addEventListener(SOURCE_CHANGE, event);
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(SOURCE_CHANGE)
        : null;
    if (channel)
      channel.onmessage = (message) =>
        void update(message.data as SourceChange);
    return () => {
      window.removeEventListener(SOURCE_CHANGE, event);
      channel?.close();
    };
  }, [me.data?.id, selected, cache]);
  const savedIds = new Set(favorites.data?.ids || []);
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
      userId,
    }: {
      station: Station;
      saved: boolean;
      userId: number;
    }) =>
      station.personal
        ? api(
            `/favorites/${station.id}`,
            saved ? "DELETE" : "PUT",
            undefined,
            undefined,
            { "X-Meow-Owner": String(userId) },
          )
        : api(`/favorites/${station.id}`, saved ? "DELETE" : "PUT"),
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
    if (station.cluster) return;
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
    setProfileOpen(false);
    setRecordingsOpen(false);
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
      setPersonalPage(0);
      setPersonalSource("");
      setPersonalCategory("");
      setProfileOpen(false);
      setRecordingsOpen(false);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const selectStation = (station: Station) => {
    setSelected(station);
    setSelection((v) => v + 1);
  };
  const chooseProxy = (station: Station, remember = false) => {
    if (station.cluster) return;
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
    if (station.cluster) {
      const cluster = station.cluster;
      const key = `${cluster.kind}:${cluster.key}`;
      const sameCluster = lastDrillKey.current === key;
      if (sameCluster && drillDetail >= 8) {
        setNotice("请按国家或关键词缩小范围，继续探索电台");
        return;
      }
      setDrillDetail((previous) =>
        sameCluster ? Math.min(8, previous + 1) : 1,
      );
      lastDrillKey.current = key;
      if (cluster.kind === "country") {
        setDrillGenre(null);
        setFilters((previous) => ({ ...previous, country: cluster.key }));
      } else {
        setDrillGenre(cluster.key);
        setFilters((previous) => ({
          ...previous,
          tag: cluster.key === "*" ? "" : cluster.key,
        }));
        setDetailGenres([cluster.key]);
      }
      return;
    }
    if (relayPreference || requiresRelay(station)) {
      chooseProxy(station);
      return;
    }
    setRelay(false);
    selectStation(station);
  };
  const changePlaybackPreference = (value: boolean) => {
    // Defaults apply to the next station; the player toggle controls this stream.
    setRelayPreference(value);
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
    view !== "list"
      ? filteredWorldStations
      : tab === "favorites"
        ? favoriteStations.data?.items || []
        : tab === "personal"
          ? personalStations.data?.items || []
          : stations.data || [];
  const currentQuery =
    view !== "list"
      ? worldStations
      : tab === "favorites"
        ? favoriteStations
        : tab === "personal"
          ? personalStations
          : stations;
  const currentPage =
    tab === "favorites"
      ? (favoriteStations.data?.page ?? favoritesPage)
      : tab === "personal"
        ? (personalStations.data?.page ?? personalPage)
        : page;
  const favoritePageCount = Math.max(
    1,
    Math.ceil((favoriteStations.data?.total || 0) / pageSize),
  );
  const personalPageCount = Math.max(
    1,
    Math.ceil((personalStations.data?.total || 0) / pageSize),
  );
  const changePage = (next: number) => {
    if (tab === "favorites") setFavoritesPage(next);
    else if (tab === "personal") setPersonalPage(next);
    else setPage(next);
  };
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
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="account-button"
                aria-label={
                  me.data?.nickname || me.data?.username || tr("用户菜单")
                }
              >
                {me.data?.avatar_url ? (
                  <img
                    className="account-avatar"
                    src={me.data.avatar_url}
                    alt=""
                  />
                ) : (
                  <UserRound size={18} />
                )}
                <span>
                  {me.data?.nickname || me.data?.username || tr("登录 / 注册")}
                </span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="user-menu"
                sideOffset={8}
                align="end"
              >
                <DropdownMenu.Item
                  onSelect={() =>
                    me.data ? setProfileOpen(true) : navigate("/login")
                  }
                >
                  <UserRound size={17} />
                  {tr("个人选项")}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => setSettingsOpen(true)}>
                  <Settings2 size={17} />
                  {tr("系统设置")}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() =>
                    me.data ? setRecordingsOpen(true) : navigate("/login")
                  }
                >
                  <Disc3 size={17} />
                  {tr("录音管理")}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() =>
                    navigate(
                      me.data ? "/sources" : "/login?returnTo=%2Fsources",
                    )
                  }
                >
                  <ListMusic size={17} />
                  {tr("个人电台源")}
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                {me.data ? (
                  <DropdownMenu.Item
                    className="menu-signout"
                    onSelect={() => void logout()}
                  >
                    <LogOut size={17} />
                    {tr("退出登录")}
                  </DropdownMenu.Item>
                ) : (
                  <DropdownMenu.Item onSelect={() => navigate("/login")}>
                    <UserRound size={17} />
                    {tr("登录 / 注册")}
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
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
          ownerKey={me.data ? String(me.data.id) : undefined}
          pauseRequest={pauseRequest}
          onRequestRelay={() => selected && chooseProxy(selected)}
          onRecorded={async (file: RecordedAudio) => {
            if (!me.data || file.ownerKey !== String(me.data.id))
              throw new Error("账号已切换，请将本次录音下载到本机。");
            const params = new URLSearchParams({
              title:
                file.stationName.slice(0, 120) +
                " · " +
                new Date().toLocaleString(),
              station_id: file.stationId,
              station_name: file.stationName.slice(0, 250),
              duration_seconds: String(file.durationSeconds),
            });
            await rawApi(
              "/recordings?" + params,
              file.blob,
              file.mimeType,
              file.ownerKey,
            );
            await cache.invalidateQueries({
              queryKey: ["recordings", me.data.id],
            });
          }}
          onOpenRecordings={() => {
            setRecordingsOpen(true);
            setSettingsOpen(false);
            setProfileOpen(false);
          }}
          theme={theme}
          station={selected}
          stations={visible.filter((station) => !station.cluster)}
          favorites={favorites.data?.presets || []}
          favoritesCount={favorites.data?.ids.length || 0}
          onSelect={choose}
          relay={relay}
          proxyConfigured={settings.data?.proxy_configured}
          onRouteChange={(value) => {
            if (!selected) return;
            if (value || requiresRelay(selected)) chooseProxy(selected);
            else {
              setRelay(false);
              selectStation(selected);
            }
          }}
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
                }}
              >
                <Globe2 size={18} />
                {tr("系统电台")}
              </button>
              <button
                role="tab"
                aria-selected={tab === "personal"}
                onClick={() => setTab("personal")}
              >
                <ListMusic size={18} />
                {tr("个人电台")}
              </button>
              <button
                role="tab"
                aria-selected={tab === "favorites"}
                onClick={() => {
                  setTab("favorites");
                }}
              >
                <Heart size={18} />
                {tr("我的收藏")}
                {me.data && (
                  <span className="count">
                    {favorites.data?.ids.length || 0}
                  </span>
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
              {tab === "personal" && active && me.data && (
                <PersonalFilters
                  userId={me.data.id}
                  sources={personalSources.data || []}
                  sourceId={personalSource}
                  category={personalCategory}
                  onApply={(source, category) => {
                    setDrillGenre(null);
                    setWorldScope((value) => value + 1);
                    setPersonalSource(source);
                    setPersonalCategory(category);
                    setPersonalPage(0);
                  }}
                />
              )}
              {tab === "discover" && active && (
                <StationFilters
                  value={filters}
                  visibleCountries={
                    view === "list" ||
                    (view === "nebula" && !visibleCountries?.length)
                      ? undefined
                      : visibleCountries
                  }
                  onApply={(next) => {
                    setDrillGenre(null);
                    setWorldScope((value) => value + 1);
                    setDrillDetail(0);
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
          <div className="directory-toolbar">
            <div
              className="directory-view-switch"
              role="group"
              aria-label={tr("电台视图")}
            >
              <button
                type="button"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <LayoutGrid size={16} />
                {tr("列表")}
              </button>
              <button
                type="button"
                aria-pressed={view === "globe"}
                onClick={() => setView("globe")}
              >
                <Globe2 size={16} />
                {tr("地球")}
              </button>
              <button
                type="button"
                aria-pressed={view === "nebula"}
                onClick={() => setView("nebula")}
              >
                <Sparkles size={16} />
                {tr("星云")}
              </button>
            </div>
            {view === "list" && (
              <label className="directory-page-size">
                {tr("每页数量")}
                <select
                  aria-label={tr("每页数量")}
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(0);
                    setFavoritesPage(0);
                    setPersonalPage(0);
                  }}
                >
                  {[24, 100, 500, 1000].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="search-progress" role="status" aria-live="polite">
            {currentQuery.isFetching
              ? view !== "list" && currentQuery.isPending
                ? tr("正在加载视野内的电台…")
                : view === "list" &&
                    tab === "discover" &&
                    stations.isPlaceholderData
                  ? tr("正在搜索，暂时显示上一次结果…")
                  : tr("正在寻找电台…")
              : currentQuery.isSuccess
                ? view !== "list"
                  ? worldStations.data?.total != null
                    ? tr("目录收录 {{v0}} 个电台 · 按视野展开", {
                        v0: worldStations.data.total,
                      })
                    : tr("已加载 {{v0}} 个节点", {
                        v0: allWorldStations.length,
                      })
                  : tr("{{v0}} {{v1}} 个电台", {
                      v0:
                        tab === "favorites"
                          ? tr("收藏中匹配")
                          : tab === "personal"
                            ? tr("个人源中匹配")
                            : view === "list"
                              ? tr("本页找到")
                              : tr("找到"),
                      v1:
                        view !== "list"
                          ? visible.length
                          : tab === "favorites"
                            ? favoriteStations.data?.total || 0
                            : tab === "personal"
                              ? personalStations.data?.total || 0
                              : visible.length,
                    })
                : ""}
          </p>
          {(tab === "favorites" || tab === "personal") && !me.data ? (
            <div className="empty-state">
              <Heart size={30} />
              <h3>
                {tab === "personal"
                  ? tr("登录后查看个人电台")
                  : tr("登录后查看收藏")}
              </h3>
              <p>{tr("登录后，收藏会跟随你的账号保存。")}</p>
              <button
                className="primary"
                onClick={() =>
                  me.data ? setProfileOpen(true) : navigate("/login")
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
          ) : tab === "personal" && !visible.length ? (
            <div className="empty-state">
              <ListMusic size={30} />
              <h3>{tr("没有匹配的个人电台")}</h3>
              <p>{tr("导入个人源，或调整搜索与分类筛选。")}</p>
              <div className="empty-actions">
                <button
                  className="primary"
                  onClick={() => navigate("/sources")}
                >
                  {tr("管理个人电台源")}
                </button>
                {(query || personalSource || personalCategory) && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setSearch("");
                      commitSearch("");
                      setPersonalSource("");
                      setPersonalCategory("");
                    }}
                  >
                    {tr("清除筛选条件")}
                  </button>
                )}
              </div>
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
          ) : view !== "list" ? (
            <Suspense
              fallback={
                <div className="empty-state" role="status">
                  {tr("正在展开声音地图…")}
                </div>
              }
            >
              <StationWorld
                view={view}
                active={active}
                stations={allWorldStations}
                selectedId={selected?.id}
                savedIds={savedIds}
                onChoose={choose}
                onChooseProxy={chooseProxy}
                onSave={toggleSave}
                saving={save.isPending}
                onList={() => setView("list")}
                genreCounts={worldGenreCounts}
                genreFilter={worldGenre}
                onGenreFilter={setWorldGenre}
                onVisibility={onWorldVisibility}
                cameraScope={worldStations.data?.cameraScope}
              />
            </Suspense>
          ) : (
            <div className="station-grid" aria-busy={currentQuery.isFetching}>
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
                        {s.country ||
                          (s.personal
                            ? s.source_name || tr("个人源")
                            : tr("世界电台"))}
                        <span className="separator"> / </span>
                        {s.tags.split(",").filter(Boolean)[0] || "Radio"}
                      </span>
                      <span className="station-quality">
                        {s.codec || "AUDIO"}
                        {s.personal && (
                          <span
                            className="personal-source-badge"
                            title={s.source_name}
                          >
                            {tr("个人源")}
                          </span>
                        )}
                        {s.bitrate ? ` · ${s.bitrate} kbps` : ""}
                        {s.id === selected?.id ? tr(" · 已选台") : ""}
                      </span>
                    </span>
                  </button>
                  <div className="station-actions">
                    <button
                      className="proxy-play icon-button"
                      aria-label={tr("本次经服务器收听 {{v0}}", {
                        v0: s.name,
                      })}
                      title={tr("仅本次经服务器中转，不更改默认方式")}
                      onClick={() => chooseProxy(s)}
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
          {view === "list" &&
            !currentQuery.isError &&
            (tab === "discover" || !!me.data) && (
              <div className="pagination">
                <span>
                  {currentQuery.isFetching
                    ? tr("正在加载电台")
                    : tab === "favorites"
                      ? tr("第 {{page}} / {{pages}} 页 · 共 {{total}} 个收藏", {
                          page: currentPage + 1,
                          pages: favoritePageCount,
                          total: favoriteStations.data?.total || 0,
                        })
                      : tab === "personal"
                        ? tr("第 {{page}} / {{pages}} 页 · {{count}} 个电台", {
                            page: currentPage + 1,
                            pages: personalPageCount,
                            count: personalStations.data?.total || 0,
                          })
                        : tr("第 {{v0}} 页 · {{v1}} 个频道", {
                            v0: currentPage + 1,
                            v1: visible.length,
                          })}
                </span>
                <div>
                  <button
                    className="icon-button"
                    aria-label={tr("上一页")}
                    disabled={currentPage === 0 || currentQuery.isFetching}
                    onClick={() => changePage(currentPage - 1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={tr("下一页")}
                    disabled={
                      currentQuery.isFetching ||
                      (tab === "favorites"
                        ? currentPage + 1 >= favoritePageCount
                        : tab === "personal"
                          ? currentPage + 1 >= personalPageCount
                          : visible.length < pageSize ||
                            currentPage >= Math.floor(10000 / pageSize))
                    }
                    onClick={() => changePage(currentPage + 1)}
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
        open={profileOpen && !!me.data}
        onOpenChange={setProfileOpen}
        title={tr("个人选项")}
        description={tr("个人资料与账号安全。")}
      >
        {me.data && (
          <ProfileSettings
            key={me.data.id}
            user={me.data}
            onUpdate={(user) => cache.setQueryData(["me"], user)}
          />
        )}
      </Modal>
      <Modal
        className="settings-modal"
        open={recordingsOpen}
        onOpenChange={setRecordingsOpen}
        title={tr("录音管理")}
        description={tr("试听、重命名或下载自己的录音。")}
      >
        <RecordingLibrary
          userId={me.data?.id}
          enabled={recordingsOpen}
          onPlay={() => setPauseRequest((v) => v + 1)}
          onSignIn={() => {
            setRecordingsOpen(false);
            navigate("/login");
          }}
        />
      </Modal>
      <Modal
        className="settings-modal"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title={tr("系统设置")}
        description={tr("外观与播放偏好保存在此浏览器，部署状态由管理员配置。")}
      >
        <Tabs.Root defaultValue="themes" className="settings-tabs">
          <Tabs.List className="settings-tab-list" aria-label={tr("设置分类")}>
            <Tabs.Trigger value="themes">{tr("主题")}</Tabs.Trigger>
            <Tabs.Trigger value="connection">{tr("设置")}</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="themes" className="settings-tab-panel">
            <fieldset className="theme-options">
              <legend className="sr-only">{tr("收音机主题")}</legend>
              {receiverThemes.map((item) => (
                <label
                  key={item.id}
                  className={theme === item.id ? "chosen" : ""}
                >
                  <input
                    type="radio"
                    name="theme"
                    checked={theme === item.id}
                    onChange={() => setTheme(item.id)}
                  />
                  <span
                    className={`theme-preview ${item.id}-preview`}
                    aria-hidden="true"
                  />
                  <strong>{tr(item.name)}</strong>
                  <small>
                    <TransientCopy>{tr(item.description)}</TransientCopy>
                  </small>
                </label>
              ))}
            </fieldset>
          </Tabs.Content>
          <Tabs.Content value="connection" className="settings-tab-panel">
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
            <h3 className="settings-section-title">{tr("录制参数")}</h3>
            <RecordingSettings />
          </Tabs.Content>
        </Tabs.Root>
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
