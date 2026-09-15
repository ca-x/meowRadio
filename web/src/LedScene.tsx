import PlaybackVisual from "./PlaybackVisual";
import { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { useState } from "react";
const play = [
  "000000000",
  "001000000",
  "001100000",
  "001110000",
  "001111000",
  "001110000",
  "001100000",
  "001000000",
  "000000000",
];
const pause = [
  "000000000",
  "001101100",
  "001101100",
  "001101100",
  "001101100",
  "001101100",
  "001101100",
  "001101100",
  "000000000",
];
const heart = [
  "000000000",
  "011000110",
  "111101111",
  "111111111",
  "011111110",
  "001111100",
  "000111000",
  "000010000",
  "000000000",
];
const ring = [
  "000000000",
  "000111000",
  "001000100",
  "010000010",
  "010010010",
  "010000010",
  "001000100",
  "000111000",
  "000000000",
];
export default function LedScene({
  playing,
  saved,
  moving,
  volume,
}: {
  playing: boolean;
  saved: boolean;
  moving: boolean;
  volume: number;
}) {
  useTranslation();
  const [view, setView] = useState<"2d" | "3d">(() => {
    try {
      return localStorage.getItem("meow-led-view") === "2d" ? "2d" : "3d";
    } catch {
      return "3d";
    }
  });
  function change(value: "2d" | "3d") {
    setView(value);
    try {
      localStorage.setItem("meow-led-view", value);
    } catch {
      /* unavailable storage */
    }
  }
  return (
    <div className={`led-scene view-${view} ${playing ? "is-playing" : ""}`}>
      <div
        className="led-scene-controls"
        role="group"
        aria-label={tr("LED 视角")}
      >
        <span>MR–03</span>
        <div>
          <button aria-pressed={view === "2d"} onClick={() => change("2d")}>
            2D
          </button>
          <button aria-pressed={view === "3d"} onClick={() => change("3d")}>
            3D
          </button>
        </div>
      </div>
      <div className="led-stage" aria-hidden="true">
        <div className="led-floor" />
        <div className="led-floor-light" />
        <div className="led-cube">
          {(["front", "right", "top"] as const).map((face) => {
            const pattern =
              face === "front"
                ? playing
                  ? play
                  : pause
                : face === "right"
                  ? saved
                    ? heart
                    : ring
                  : ring;
            return (
              <div className={`led-face led-${face}`} key={face}>
                {Array.from(
                  {
                    length: 81,
                  },
                  (_, i) => (
                    <i
                      className={`led-pixel ${pattern[Math.floor(i / 9)][i % 9] === "1" ? "lit" : ""}`}
                      key={i}
                    >
                      <b />
                    </i>
                  ),
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="led-caption">
        <span className={playing ? "active" : ""} />
        {playing ? tr("正在收听") : tr("待机")}
        <PlaybackVisual variant="led" running={moving} volume={volume} />
      </div>
    </div>
  );
}
