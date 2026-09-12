import { Loader2, Play, SearchX } from "lucide-react";
import type { Track } from "../types";
import { formatTime } from "../types";
import { useTranslation } from "../i18n";

interface SearchResultsProps {
  results: Track[];
  isSearching: boolean;
  query: string;
  currentId?: string;
  onPlay(track: Track): void;
}

export default function SearchResults({
  results,
  isSearching,
  query,
  currentId,
  onPlay,
}: SearchResultsProps) {
  const { t } = useTranslation();
  if (isSearching) {
    return (
      <div className="panel-empty">
        <Loader2 size={18} className="spin" />
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="panel-empty panel-empty-col">
        <SearchX size={22} />
        <span>{t("music.noSearchResults", { query })}</span>
      </div>
    );
  }
  return (
    <ul className="queue">
      {results.map((track, i) => {
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
          >
            <button
              type="button"
              className="icon-btn result-play"
              disabled={disabled}
              onClick={() => onPlay(track)}
              title={disabled ? t("music.trackDisabledHint") : t("music.play")}
            >
              <Play size={14} fill="currentColor" />
            </button>
            <div className="queue-main as-static">
              <span className="queue-name">{track.name}</span>
              <span className="queue-artist">
                {track.artists.join(" / ")}
                {track.album ? ` · ${track.album}` : ""}
              </span>
            </div>
            {disabled && <span className="queue-tag">{t("music.unavailableTag")}</span>}
            <span className="queue-duration">
              {formatTime(track.durationMs ?? 0)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
