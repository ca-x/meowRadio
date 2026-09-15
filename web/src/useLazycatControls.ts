import { useEffect, useRef } from "react";
import type { MediaSessionPlugin } from "@lazycatcloud/sdk/dist/extentions/mediasession/definitions";
import type { Station } from "./api";
import "./lazycat.css";

export type LazycatControlsOptions = {
  station: Station | null;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
};

type HostWindow = Window & {
  webkit?: { messageHandlers?: { ScriptHandlers?: { postMessage?: unknown } } };
  lzc_window?: { SetStatusBarColor?: (color: string) => unknown };
  lzc_tab?: { SetControlViewVisibility?: (visible: boolean) => unknown };
};

// Host APIs can throw synchronously or reject on older client versions.
function safeCall(call: () => unknown) {
  try {
    void Promise.resolve(call()).catch(() => {});
  } catch {
    // The browser player remains available when a client capability fails.
  }
}

function setHostMeta(name: string, content: string) {
  let meta = document.head.querySelector<HTMLMetaElement>(
    `meta[name="${name}"]`,
  );
  const previous = meta?.getAttribute("content");
  const created = !meta;
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
  const element = meta;
  return () => {
    if (created) element.remove();
    else if (previous == null) element.removeAttribute("content");
    else element.content = previous;
  };
}

function setupChrome(platform: "ios" | "android") {
  const root = document.documentElement;
  const host = window as HostWindow;
  const previousPlatform = root.getAttribute("data-lazycat-webshell");
  root.dataset.lazycatWebshell = platform;
  const restore = [setHostMeta("lzcapp-disable-dark", "true")];
  let restoreColors: Array<() => void> = [];
  if (platform === "ios") {
    // Keep the native close button and status area available.
    restore.push(setHostMeta("lzcapp-navigation-bar-scheme", "statusBarOnly"));
  } else {
    safeCall(() => host.lzc_tab?.SetControlViewVisibility?.(true));
  }
  const updateColor = () => {
    const canvas = getComputedStyle(root).getPropertyValue("--canvas").trim();
    const color = /^#[\da-f]{3,8}$/i.test(canvas)
      ? canvas
      : root.dataset.color === "dark"
        ? "#101315"
        : "#eeeae3";
    if (platform === "android") {
      safeCall(() => host.lzc_window?.SetStatusBarColor?.(color));
    } else {
      restoreColors.forEach((dispose) => dispose());
      // Both variants reflect the app's selected mode, including manual overrides.
      restoreColors = [
        setHostMeta("lzcapp-state-bar-color", color),
        setHostMeta("lzcapp-state-bar-color-dark", color),
      ];
    }
  };
  updateColor();
  const observer = new MutationObserver(updateColor);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color"],
  });
  return () => {
    observer.disconnect();
    restoreColors.forEach((dispose) => dispose());
    restore.forEach((dispose) => dispose());
    if (previousPlatform == null) root.removeAttribute("data-lazycat-webshell");
    else root.setAttribute("data-lazycat-webshell", previousPlatform);
  };
}

function updateSession(
  session: MediaSessionPlugin,
  options: LazycatControlsOptions,
) {
  const { station, status } = options;
  safeCall(() =>
    session.setMetadata(
      station
        ? {
            title: station.name,
            artist: station.country || "meowRadio",
            album: "meowRadio",
          }
        : {},
    ),
  );
  safeCall(() =>
    session.setPlaybackState({
      playbackState: !station
        ? "none"
        : status === "playing"
          ? "playing"
          : "paused",
    }),
  );
  // Live radio has no finite duration or seek position to publish.
}

export default function useLazycatControls(options: LazycatControlsOptions) {
  const latest = useRef<LazycatControlsOptions | null>(options);
  const session = useRef<MediaSessionPlugin | null>(null);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    // Avoid importing SDK modules (which initialize bridges) in ordinary browsers.
    // These SDK UA markers are only a prefilter; official SDK checks below decide.
    if (!/Lazycat_10[13]/.test(navigator.userAgent)) return;
    const host = window as HostWindow;
    if (
      navigator.userAgent.includes("Lazycat_103") &&
      typeof host.webkit?.messageHandlers?.ScriptHandlers?.postMessage !==
        "function"
    )
      return;

    let disposed = false;
    let restoreChrome: (() => void) | undefined;
    let media: MediaSessionPlugin | undefined;
    const actions = ["play", "pause", "nexttrack", "previoustrack"] as const;
    void (async () => {
      const { default: base } =
        await import("@lazycatcloud/sdk/dist/extentions/base");
      if (disposed) return;
      const platform = base.isIosWebShell()
        ? "ios"
        : base.isAndroidWebShell()
          ? "android"
          : null;
      if (!platform) return;
      restoreChrome = setupChrome(platform);
      if (platform !== "android") return;
      const sdk =
        await import("@lazycatcloud/sdk/dist/extentions/mediasession/index");
      if (disposed || !sdk.isMediaSessionAvailable()) return;
      media = sdk.MediaSession;
      session.current = media;
      for (const action of actions) {
        safeCall(() =>
          media!.setActionHandler({ action }, () => {
            const current = latest.current;
            if (disposed || !current) return;
            const running =
              current.status === "playing" || current.status === "loading";
            if (action === "play" && !running) current.onPlay();
            if (action === "pause" && running) current.onPause();
            if (action === "nexttrack") current.onNext();
            if (action === "previoustrack") current.onPrevious();
          }),
        );
      }
      if (latest.current) updateSession(media, latest.current);
    })().catch(() => {});
    return () => {
      disposed = true;
      latest.current = null;
      session.current = null;
      restoreChrome?.();
      if (media) {
        // SDK accepts null and clears its Android action callback map as well.
        for (const action of actions)
          safeCall(() => media!.setActionHandler({ action }, null));
        safeCall(() => media!.setPlaybackState({ playbackState: "none" }));
        safeCall(() => media!.setMetadata({}));
      }
    };
  }, []);
  useEffect(() => {
    if (session.current) updateSession(session.current, options);
  }, [options.station, options.status]);
}
