import { useId } from "react";
import { useTranslation } from "react-i18next";
import { tr } from "./i18n";
import {
  recordingBitrates,
  recordingDurations,
  supportedRecordingFormats,
  useRecordingPreferences,
} from "./recordingPreferences";
import { recordingAvailable } from "./useRecording";
import "./recording.css";

export default function RecordingSettings() {
  useTranslation();
  const [preferences, update] = useRecordingPreferences();
  const id = useId();
  const formats = supportedRecordingFormats();
  return (
    <div className="recording-settings">
      <p>
        {tr(
          "录制正在播放的电台，停止后自动保存到个人录音库，也可下载到本机。设置将在下次录制时生效。",
        )}
      </p>
      {!recordingAvailable() && (
        <p role="status">
          {tr("此浏览器暂不支持电台录制，请使用最新版 Chrome 或 Firefox。")}
        </p>
      )}
      <label htmlFor={`${id}-format`}>{tr("录制格式")}</label>
      <select
        id={`${id}-format`}
        value={preferences.mime}
        disabled={!formats.length}
        onChange={(event) => update({ mime: event.target.value })}
      >
        {!formats.length && <option value="">{tr("暂无可用格式")}</option>}
        {formats.map((format) => (
          <option key={format.mime} value={format.mime}>
            {format.label}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-bitrate`}>{tr("目标码率")}</label>
      <select
        id={`${id}-bitrate`}
        value={preferences.bitrate}
        onChange={(event) => update({ bitrate: Number(event.target.value) })}
      >
        {recordingBitrates.map((bitrate) => (
          <option key={bitrate} value={bitrate}>
            {bitrate} kbps
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-duration`}>{tr("最长录制时长")}</label>
      <select
        id={`${id}-duration`}
        value={preferences.maxMinutes}
        onChange={(event) => update({ maxMinutes: Number(event.target.value) })}
      >
        {recordingDurations.map((minutes) => (
          <option key={minutes} value={minutes}>
            {tr("{{count}} 分钟", { count: minutes })}
          </option>
        ))}
      </select>
      <p>
        {tr(
          "录制需通过服务器播放；换台或停止播放时会自动结束。单次最多 100 MiB，实际码率由浏览器决定。",
        )}
      </p>
    </div>
  );
}
