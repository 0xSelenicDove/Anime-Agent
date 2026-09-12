import { Trash2, X } from "lucide-react";
import type { Track } from "../types";
import { formatTime } from "../types";
import { useTranslation } from "../i18n";

interface QueueListProps {
  queue: Track[];
  currentId?: string;
  onPlay(track: Track): void;
  /** 从队列移除（普通歌单的 X 按钮） */
  onRemove?(index: number): void;
  /** 删除缓存文件（仅缓存歌单的 Trash2 按钮，后端拒删正在播放的曲） */
  onDeleteTrack?(track: Track): void;
}

export default function QueueList({
  queue,
  currentId,
  onPlay,
  onRemove,
  onDeleteTrack,
}: QueueListProps) {
  const { t } = useTranslation();
  if (queue.length === 0) {
    return <div className="panel-empty">{t("music.queueEmpty")}</div>;
  }
  return (
    <ul className="queue">
      {queue.map((track, i) => {
        const active = track.encryptedId === currentId;
        const disabled = !track.visible;
        return (
          <li
            key={`${track.encryptedId}-${i}`}
            className={[
              "queue-item",
              active ? "is-active" : "",
              disabled ? "is-disabled" : "",
            ].join(" ")}
            onDoubleClick={() => !disabled && onPlay(track)}
          >
            <span className="queue-indicator">
              {active && (
                <span className="eq">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </span>
            <button
              type="button"
              className="queue-main"
              disabled={disabled}
              onClick={() => onPlay(track)}
              title={disabled ? t("music.trackDisabledHint") : track.name}
            >
              <span className="queue-name">{track.name}</span>
              <span className="queue-artist">
                {track.artists.join(" / ")}
              </span>
            </button>
            {disabled && <span className="queue-tag">{t("music.unavailableTag")}</span>}
            <span className="queue-duration">
              {formatTime(track.durationMs ?? 0)}
            </span>
            {onDeleteTrack ? (
              <button
                type="button"
                className="icon-btn queue-remove queue-delete"
                title={t("music.deleteCache")}
                onClick={() => onDeleteTrack(track)}
              >
                <Trash2 size={14} />
              </button>
            ) : onRemove ? (
              <button
                type="button"
                className="icon-btn queue-remove"
                title={t("music.removeFromQueue")}
                onClick={() => onRemove(i)}
              >
                <X size={14} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
