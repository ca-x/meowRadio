import SourceValidationDialog from "./SourceValidationDialog";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Plus,
  Upload,
  Link2,
  RefreshCw,
  Trash2,
  FileJson,
  ChevronLeft,
  ChevronRight,
  X,
  BookOpen,
  Download,
  Radio,
  ScanLine,
} from "lucide-react";
import i18n, { tr } from "./i18n";
import { api, ApiError, type User } from "./api";
import useTheme from "./useTheme";
import {
  importSource,
  uploadSource,
  sourceAction,
  notifySourceChange,
  sourceExample,
  type PersonalSource,
  type PersonalPage,
  type SourceCapabilities,
} from "./personalSources";
import "./sources.css";

type Removal = {
  kind: "source" | "station" | "all";
  id?: string;
  name?: string;
};
export default function SourcesPage() {
  useTranslation();
  useTheme();
  const cache = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api<User>("/auth/me").catch((error) => {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }),
    retry: false,
  });
  const sources = useQuery({
    queryKey: ["personal-sources", me.data?.id],
    queryFn: () => api<PersonalSource[]>("/personal-sources"),
    enabled: !!me.data,
  });
  const capabilities = useQuery({
    queryKey: ["source-capabilities"],
    queryFn: () => api<SourceCapabilities>("/personal-sources/capabilities"),
    enabled: !!me.data,
  });
  const [open, setOpen] = useState(false),
    [guide, setGuide] = useState(false),
    [mode, setMode] = useState("url"),
    [label, setLabel] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [replacement, setReplacement] = useState<string | undefined>(),
    [expanded, setExpanded] = useState<string | null>(null),
    [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [removal, setRemoval] = useState<Removal | null>(null),
    [localError, setLocalError] = useState("");
  const [validationSource, setValidationSource] =
    useState<PersonalSource | null>(null);
  const [invalidImport, setInvalidImport] = useState<{
    records: Array<{
      name: string;
      index: number;
      line: number;
      url: string;
      reason: string;
    }>;
    valid_count: number;
    snapshot_token?: string;
    refresh?: PersonalSource;
  } | null>(null);
  const showInvalid = (error: Error, refresh?: PersonalSource) => {
    if (
      error instanceof ApiError &&
      Array.isArray(error.details?.invalid_records)
    )
      setInvalidImport({
        records: error.details.invalid_records as Array<{
          name: string;
          index: number;
          line: number;
          url: string;
          reason: string;
        }>,
        valid_count: Number(error.details.valid_count || 0),
        snapshot_token:
          typeof error.details.snapshot_token === "string"
            ? error.details.snapshot_token
            : undefined,
        refresh,
      });
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const stations = useQuery({
    queryKey: [
      "personal-stations",
      "manage",
      me.data?.id,
      expanded,
      page,
      search,
    ],
    queryFn: () =>
      api<PersonalPage>(
        `/personal-stations?${new URLSearchParams({ source_id: expanded || "", page: String(page), q: search })}`,
      ),
    enabled: !!me.data && !!expanded,
  });
  useEffect(() => {
    document.title = tr("个人电台源 · 阿喵收音机");
  }, [i18n.language]);
  useEffect(() => {
    if (stations.data && stations.data.page !== page)
      setPage(stations.data.page);
  }, [stations.data, page]);
  const changed = async (
    sourceId?: string,
    stationId?: string,
    all = false,
  ) => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["personal-sources"] }),
      cache.invalidateQueries({ queryKey: ["personal-stations"] }),
      cache.invalidateQueries({ queryKey: ["favorites"] }),
    ]);
    if (me.data)
      notifySourceChange({ owner: me.data.id, sourceId, stationId, all });
  };
  const add = useMutation({
    mutationFn: ({ discard = false }: { discard?: boolean } = {}) => {
      if (!me.data) throw new Error("请先登录");
      if (mode === "file") {
        if (!file) throw new Error("请选择 JSON 文件");
        return uploadSource(
          me.data.id,
          label,
          file,
          replacement,
          discard,
          discard ? invalidImport?.snapshot_token : undefined,
        );
      }
      return importSource(
        me.data.id,
        label,
        url,
        discard,
        discard ? invalidImport?.snapshot_token : undefined,
      );
    },
    onSuccess: async (source) => {
      setOpen(false);
      setFile(null);
      setReplacement(undefined);
      setLabel("");
      setUrl("");
      await changed(source.id);
      setInvalidImport(null);
      setValidationSource(source);
    },
    onError: (error) => showInvalid(error),
  });
  const refresh = useMutation({
    mutationFn: ({
      source,
      discard = false,
    }: {
      source: PersonalSource;
      discard?: boolean;
    }) =>
      sourceAction(
        me.data!.id,
        `/personal-sources/${source.id}/refresh${discard ? `?discard_invalid=true&snapshot_token=${encodeURIComponent(invalidImport?.snapshot_token || "")}` : ""}`,
        "POST",
      ),
    onSuccess: async (source) => {
      await changed(source.id);
      setInvalidImport(null);
      setValidationSource(source);
    },
    onError: (error, variables) => showInvalid(error, variables.source),
  });
  const remove = useMutation({
    mutationFn: (item: Removal) =>
      sourceAction(
        me.data!.id,
        item.kind === "all"
          ? "/personal-sources"
          : item.kind === "source"
            ? `/personal-sources/${item.id}`
            : `/personal-stations/${item.id}`,
      ),
    onSuccess: async (_result, item) => {
      setRemoval(null);
      if (item.kind !== "station") {
        setExpanded(null);
        setPage(0);
      }
      await changed(
        item.kind === "source" ? item.id : undefined,
        item.kind === "station" ? item.id : undefined,
        item.kind === "all",
      );
    },
  });
  function newSource() {
    setMode("url");
    setReplacement(undefined);
    setLabel("");
    setUrl("");
    setFile(null);
    setLocalError("");
    add.reset();
    setOpen(true);
  }
  function replace(source: PersonalSource) {
    setMode("file");
    setReplacement(source.id);
    setLabel(source.label);
    setFile(null);
    setLocalError("");
    add.reset();
    setOpen(true);
  }
  function example() {
    const object = URL.createObjectURL(
      new Blob([sourceExample], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = object;
    a.download = "meowradio-source-example.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(object), 1000);
  }
  if (me.isSuccess && !me.data)
    return <Navigate to="/login?returnTo=%2Fsources" replace />;
  return (
    <div className="sources-page">
      <header className="sources-header">
        <Link className="brand" to="/">
          <img src="/branding/logo-256.webp" width={38} height={38} alt="" />
          <span>{tr("阿喵收音机")}</span>
        </Link>
        <Link className="login-back" to="/">
          <ArrowLeft size={16} />
          {tr("返回收听")}
        </Link>
      </header>
      <main>
        <div className="sources-heading">
          <div>
            <h1>{tr("个人电台源")}</h1>
            <p>{tr("按账号保存订阅、电台与备用线路。")}</p>
          </div>
          <div>
            <button className="secondary" onClick={() => setGuide(true)}>
              <BookOpen size={16} />
              {tr("格式说明")}
            </button>
            <button className="primary" onClick={newSource} disabled={!me.data}>
              <Plus size={17} />
              {tr("添加电台源")}
            </button>
          </div>
        </div>
        {capabilities.data && !capabilities.data.available && (
          <div className="source-status" role="status">
            {tr(
              "服务端尚未安装 FFmpeg。可以先导入，安装并重启服务后即可播放个人源。",
            )}
          </div>
        )}
        {(me.error || sources.error || refresh.error) && (
          <div className="form-error" role="alert">
            {tr((me.error || sources.error || refresh.error)!.message)}
            <button
              className="text-button"
              onClick={() => {
                void me.refetch();
                void sources.refetch();
              }}
            >
              {tr("重试")}
            </button>
          </div>
        )}
        {sources.isPending ? (
          <p role="status">{tr("正在加载电台源…")}</p>
        ) : !sources.data?.length ? (
          <div className="sources-empty">
            <Radio size={32} />
            <h2>{tr("还没有个人电台源")}</h2>
            <p>{tr("填写网络地址，或上传包含电台列表的 JSON 文件。")}</p>
            <button className="secondary" onClick={newSource}>
              {tr("添加电台源")}
            </button>
          </div>
        ) : (
          <>
            <div className="sources-overview">
              <span>
                {tr("{{sources}} 个源 · {{stations}} 个电台", {
                  sources: sources.data.length,
                  stations: sources.data.reduce(
                    (sum, item) => sum + item.station_count,
                    0,
                  ),
                })}
              </span>
              <button
                className="text-button danger-text"
                onClick={() => {
                  remove.reset();
                  setRemoval({ kind: "all" });
                }}
              >
                {tr("全部删除")}
              </button>
            </div>
            <ul className="sources-list">
              {sources.data.map((source) => (
                <li key={source.id}>
                  <div className="source-row">
                    <span className="source-kind" aria-hidden="true">
                      {source.kind === "url" ? (
                        <Link2 size={20} />
                      ) : (
                        <FileJson size={20} />
                      )}
                    </span>
                    <button
                      className="source-title"
                      onClick={() => {
                        setExpanded(expanded === source.id ? null : source.id);
                        setPage(0);
                        setSearch("");
                      }}
                      aria-expanded={expanded === source.id}
                    >
                      <strong>{source.label}</strong>
                      <span>
                        {source.kind === "url"
                          ? tr("网络地址")
                          : tr("上传文件")}{" "}
                        ·{" "}
                        {tr("{{count}} 个电台", {
                          count: source.station_count,
                        })}
                      </span>
                    </button>
                    <div className="source-actions">
                      <button
                        className="icon-button"
                        aria-label={tr("检测 {{name}}", { name: source.label })}
                        title={tr("检查地址")}
                        onClick={() => setValidationSource(source)}
                      >
                        <ScanLine size={18} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={tr("更新 {{name}}", { name: source.label })}
                        title={tr("更新")}
                        disabled={refresh.isPending || add.isPending}
                        onClick={() =>
                          source.kind === "url"
                            ? refresh.mutate({ source })
                            : replace(source)
                        }
                      >
                        {source.kind === "url" ? (
                          <RefreshCw size={18} />
                        ) : (
                          <Upload size={18} />
                        )}
                      </button>
                      <button
                        className="icon-button"
                        aria-label={tr("删除电台源 {{name}}", {
                          name: source.label,
                        })}
                        title={tr("删除")}
                        onClick={() => {
                          remove.reset();
                          setRemoval({
                            kind: "source",
                            id: source.id,
                            name: source.label,
                          });
                        }}
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                  {expanded === source.id && (
                    <div className="source-stations">
                      <label className="source-search">
                        <span className="sr-only">{tr("搜索此源电台")}</span>
                        <input
                          value={search}
                          onChange={(e) => {
                            setSearch(e.target.value);
                            setPage(0);
                          }}
                          placeholder={tr("搜索此源电台")}
                        />
                      </label>
                      {stations.isPending ? (
                        <p role="status">{tr("正在加载电台")}</p>
                      ) : stations.isError ? (
                        <p className="form-error" role="alert">
                          {tr(stations.error.message)}
                        </p>
                      ) : (
                        <>
                          <ul>
                            {stations.data.items.map((station) => (
                              <li key={station.id}>
                                <div>
                                  <strong>{station.name}</strong>
                                  <small>{station.tags || tr("未分类")}</small>
                                </div>
                                <button
                                  className="icon-button"
                                  aria-label={tr("删除个人电台 {{name}}", {
                                    name: station.name,
                                  })}
                                  onClick={() => {
                                    remove.reset();
                                    setRemoval({
                                      kind: "station",
                                      id: station.id,
                                      name: station.name,
                                    });
                                  }}
                                >
                                  <Trash2 size={16} />
                                </button>
                              </li>
                            ))}
                          </ul>
                          <div className="pagination">
                            <span>
                              {tr(
                                "第 {{page}} / {{pages}} 页 · {{count}} 个电台",
                                {
                                  page: (stations.data.page || 0) + 1,
                                  pages: Math.max(
                                    1,
                                    Math.ceil(stations.data.total / 24),
                                  ),
                                  count: stations.data.total,
                                },
                              )}
                            </span>
                            <div>
                              <button
                                className="icon-button"
                                aria-label={tr("上一页")}
                                disabled={!page || stations.isFetching}
                                onClick={() => setPage((p) => p - 1)}
                              >
                                <ChevronLeft size={18} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={tr("下一页")}
                                disabled={
                                  (page + 1) * 24 >= stations.data.total ||
                                  stations.isFetching
                                }
                                onClick={() => setPage((p) => p + 1)}
                              >
                                <ChevronRight size={18} />
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!add.isPending) setOpen(value);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal source-modal">
            <Dialog.Title>
              {replacement ? tr("更新文件源") : tr("添加电台源")}
            </Dialog.Title>
            <Dialog.Description>
              {tr("导入后只对当前账号可见。更新成功后保留仍存在电台的收藏。")}
            </Dialog.Description>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setLocalError("");
                add.mutate({});
              }}
            >
              <label>
                {tr("源名称")}
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={250}
                  required
                  disabled={add.isPending}
                />
              </label>
              <Tabs.Root value={mode} onValueChange={setMode}>
                <Tabs.List
                  className="settings-tab-list"
                  aria-label={tr("导入方式")}
                >
                  <Tabs.Trigger
                    value="url"
                    disabled={!!replacement || add.isPending}
                  >
                    {tr("网络地址")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="file" disabled={add.isPending}>
                    {tr("上传文件")}
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="url">
                  <label>
                    {tr("订阅或电台地址")}
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      inputMode="url"
                      autoComplete="off"
                      required={mode === "url"}
                      placeholder="https://…"
                      disabled={add.isPending}
                    />
                  </label>
                  <p className="source-help">
                    {tr("支持 JSON 订阅地址、单个音频地址或电台播放页。")}
                  </p>
                </Tabs.Content>
                <Tabs.Content value="file">
                  <label className="source-file">
                    <Upload size={24} />
                    <span>{file?.name || tr("选择 JSON 文件")}</span>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".json,application/json"
                      required={mode === "file"}
                      disabled={add.isPending}
                      onChange={(e) => {
                        const next = e.target.files?.[0] || null;
                        if (next && next.size > 5 * 1024 * 1024) {
                          setLocalError("订阅文件不能超过 5 MiB");
                          setFile(null);
                          e.target.value = "";
                          return;
                        }
                        setFile(next);
                        setLocalError("");
                        if (next && !label)
                          setLabel(next.name.replace(/\.json$/i, ""));
                      }}
                    />
                  </label>
                  <p className="source-help">
                    {tr("单个文件最多 5 MiB、5000 个电台。")}
                  </p>
                </Tabs.Content>
              </Tabs.Root>
              {(add.error || localError) && (
                <p role="alert" className="form-error">
                  {tr(localError || add.error!.message)}
                </p>
              )}
              <button className="primary" disabled={add.isPending || !me.data}>
                {add.isPending ? tr("正在导入…") : tr("导入")}
              </button>
            </form>
            <Dialog.Close
              className="modal-close icon-button"
              disabled={add.isPending}
              aria-label={tr("关闭")}
            >
              <X size={20} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!removal}
        onOpenChange={(value) => {
          if (!value && !remove.isPending) setRemoval(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <Dialog.Title>{tr("删除个人源内容")}</Dialog.Title>
            <Dialog.Description>
              {removal?.kind === "all"
                ? tr("删除所有个人电台源及对应收藏？系统电台收藏不受影响。")
                : tr("删除 {{name}} 及其对应收藏？此操作无法撤销。", {
                    name: removal?.name,
                  })}
            </Dialog.Description>
            {remove.error && (
              <p className="form-error" role="alert">
                {tr(remove.error.message)}
              </p>
            )}
            <div className="source-dialog-actions">
              <Dialog.Close className="secondary" disabled={remove.isPending}>
                {tr("取消")}
              </Dialog.Close>
              <button
                className="danger-button"
                disabled={remove.isPending}
                onClick={() => removal && remove.mutate(removal)}
              >
                {remove.isPending ? tr("正在删除…") : tr("确认删除")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {validationSource && me.data && (
        <SourceValidationDialog
          key={validationSource.id}
          source={validationSource}
          userId={me.data.id}
          onClose={() => setValidationSource(null)}
          onCleared={() => changed(validationSource.id)}
        />
      )}
      <Dialog.Root
        open={!!invalidImport}
        onOpenChange={(value) => {
          if (!value && !add.isPending && !refresh.isPending)
            setInvalidImport(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal source-validation-modal">
            <Dialog.Title>{tr("发现无效播放地址")}</Dialog.Title>
            <Dialog.Description>
              {tr(
                "以下地址格式无效。清除后继续导入，其余有效备用地址和对应收藏会保留。",
              )}
            </Dialog.Description>
            <ul className="invalid-address-list">
              {invalidImport?.records.map((row, i) => (
                <li key={i}>
                  <strong>
                    {row.name ||
                      tr("第 {{number}} 个电台", { number: row.index })}{" "}
                    · {tr("线路 {{number}}", { number: row.line })}
                  </strong>
                  <code>{row.url}</code>
                  <span>{tr(row.reason)}</span>
                </li>
              ))}
            </ul>
            <p className="source-help">
              {tr(
                "清理后保留 {{count}} 个电台；没有有效地址的电台及对应收藏会移除。",
                { count: invalidImport?.valid_count || 0 },
              )}
            </p>
            <div className="source-dialog-actions">
              <Dialog.Close
                className="secondary"
                disabled={add.isPending || refresh.isPending}
              >
                {tr("取消")}
              </Dialog.Close>
              <button
                className="danger-button"
                disabled={add.isPending || refresh.isPending}
                onClick={() =>
                  invalidImport?.refresh
                    ? refresh.mutate({
                        source: invalidImport.refresh,
                        discard: true,
                      })
                    : add.mutate({ discard: true })
                }
              >
                {tr("清除无效地址并继续")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={guide} onOpenChange={setGuide}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal source-guide">
            <Dialog.Title>{tr("电台源格式说明")}</Dialog.Title>
            <Dialog.Description>
              {tr("文件和订阅接口均使用 UTF-8 编码的 JSON 数组。")}
            </Dialog.Description>
            <dl>
              <dt>name</dt>
              <dd>{tr("电台名称，必填；同一源内同名条目会合并备用线路。")}</dd>
              <dt>categories</dt>
              <dd>
                {tr(
                  "可选的分类路径数组，例如国内电台 / 央广；一个电台可属于多个分类。",
                )}
              </dd>
              <dt>urls</dt>
              <dd>
                {tr(
                  "必填的播放地址数组，按顺序尝试；支持字符串或包含 url、headers 的对象。",
                )}
              </dd>
            </dl>
            <pre>{sourceExample}</pre>
            <p>
              {tr(
                "支持 HTTP(S)、HLS、FLV、RTMP(S)、RTSP(S)、MMS、MMST、MMSH；网页和接口地址先解析为媒体流，再通过服务器播放。",
              )}
            </p>
            <p>
              {tr(
                "兼容地址后的 -headers 和 -reuse 参数；它们只作为配置解析，不会执行命令。请求头支持 User-Agent、Referer、Origin、Accept。",
              )}
            </p>
            <p>
              {tr(
                "个人源需要服务端 FFmpeg；Docker 已包含，二进制部署可安装 FFmpeg 或设置 MEOW_FFMPEG。失效地址或需要授权的内容会报告错误。",
              )}
            </p>
            <button className="secondary" onClick={example}>
              <Download size={16} />
              {tr("下载示例 JSON")}
            </button>
            <Dialog.Close
              className="modal-close icon-button"
              aria-label={tr("关闭")}
            >
              <X size={20} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
