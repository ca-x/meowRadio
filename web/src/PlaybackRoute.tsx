import * as Tooltip from "@radix-ui/react-tooltip";
import { Cable } from "lucide-react";
import { tr } from "./i18n";
import "./playback-route.css";
export default function PlaybackRoute({
  relay,
  proxyConfigured,
  directAllowed,
  onChange,
}: {
  relay: boolean;
  proxyConfigured: boolean;
  directAllowed: boolean;
  onChange: (relay: boolean) => void;
}) {
  const required = relay && !directAllowed;
  const description = required
    ? tr("HTTPS 页面上的 HTTP 电台需要服务器中转。")
    : relay
      ? proxyConfigured
        ? tr("中转已开启，服务器使用出站代理。点击切换为直连。")
        : tr("中转已开启。点击切换为浏览器直连。")
      : tr("浏览器直连。点击开启本次服务器中转。");
  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="playback-route-toggle icon-button"
            aria-label={tr("服务器中转")}
            aria-pressed={relay}
            aria-disabled={required}
            onClick={() => {
              if (!required) onChange(!relay);
            }}
          >
            <Cable size={19} aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="playback-route-tip" sideOffset={8}>
            {description}
            <Tooltip.Arrow className="playback-route-tip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
