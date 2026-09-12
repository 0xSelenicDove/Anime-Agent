import { useEffect, useState } from "react";
import {
  AlertCircle,
  FolderPlus,
  ListMusic,
  Loader2,
  Music2,
  PanelRightClose,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import type { MusicPlayerProps } from "../types";
import logo from "../assets/logo.png";
import decoBadge from "../assets/music2.png";
import { useTranslation } from "../i18n";
import LyricsView from "./LyricsView";
import ProgressBar from "./ProgressBar";
import QueueList from "./QueueList";
import SearchResults from "./SearchResults";
import VolumeControl from "./VolumeControl";

type PlayMode = "off" | "all" | "one" | "shuffle";

const MODE_LABEL_KEY: Record<PlayMode, string> = {
  off: "music.modeOnce",
  all: "music.modeAll",
  one: "music.modeOne",
  shuffle: "music.modeShuffle",
};
const MODE_NEXT: Record<PlayMode, PlayMode> = {
  off: "one",
  all: "one",
  one: "shuffle",
  shuffle: "off",
};
const MODE_ICON: Record<PlayMode, typeof Repeat> = {
  off: Repeat,
  all: Repeat,
  one: Repeat1,
  shuffle: Shuffle,
};

export default function MusicPlayer({
  state,
  actions,
  playlists,
  activePlaylistId,
  onSelectPlaylist,
  modeSet,
  onImportLocalTracks,
  onRemoveCachedTrack,
  searchResults,
  isSearching,
  onSearch,
  className,
}: MusicPlayerProps) {
  const { t } = useTranslation();
  const [showLyrics, setShowLyrics] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const track = state.currentTrack;
  const mode: PlayMode = state.playbackMode;

  const handleQueryChange = (value: string) => {
    setQuery(value);
    onSearch(value);
  };

  const clearQuery = () => {
    setQuery("");
    onSearch("");
  };

  // 键盘快捷键：空格播放/暂停，←→ 进度 ±5s，↑↓ 音量 ±5
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          actions.togglePlayPause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          actions.seek(state.positionMs - 5000);
          break;
        case "ArrowRight":
          e.preventDefault();
          actions.seek(state.positionMs + 5000);
          break;
        case "ArrowUp":
          e.preventDefault();
          actions.setVolume(state.volume + 5);
          break;
        case "ArrowDown":
          e.preventDefault();
          actions.setVolume(state.volume - 5);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, state.positionMs, state.volume]);

  const ModeIcon = MODE_ICON[mode];

  return (
    <section className={`mp ${className ?? ""}`}>
      <header className="mp-header">
        <div className="mp-brand">
          <img className="mp-brand-logo" src={logo} alt="logo" />
          <span className="mp-brand-name">Cyrene Music</span>
        </div>
        <nav className="mp-playlists" aria-label={t("music.playlistNavLabel")}>
          {playlists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              className={`playlist-chip ${
                pl.id === activePlaylistId ? "is-active" : ""
              }`}
              onClick={() => onSelectPlaylist(pl)}
            >
              {pl.name}
            </button>
          ))}
        </nav>
      </header>

      <div className="mp-body">
        <div className="mp-stage">
          <div className={`stage-view ${showLyrics ? "show-lyrics" : ""}`}>
            <button
              type="button"
              className="stage-disc-btn"
              onClick={() => setShowLyrics(true)}
              title={t("music.viewLyricsHint")}
            >
              <div
                className={`cover-disc ${state.isPlaying ? "is-spinning" : ""}`}
              >
                {track?.coverImgUrl ? (
                  <img
                    src={track.coverImgUrl}
                    alt={track.name}
                    draggable={false}
                  />
                ) : (
                  <div className="cover-fallback">
                    <Music2 size={56} />
                  </div>
                )}
                {state.isLoading && (
                  <div className="cover-loading">
                    <Loader2 size={28} className="spin" />
                  </div>
                )}
              </div>
            </button>
            <div
              className="stage-lyrics"
              onClick={() => setShowLyrics(false)}
              title={t("music.backToCoverHint")}
            >
              <LyricsView track={track} positionMs={state.positionMs} />
            </div>
          </div>
          <div className="stage-meta">
            <h2 className="stage-title">{track?.name ?? t("music.notPlaying")}</h2>
            <p className="stage-sub">
              {track
                ? `${track.artists.join(" / ")}${track.album ? ` · ${track.album}` : ""}`
                : t("music.pickFromPlaylist")}
            </p>
          </div>
        </div>

        <aside className={`mp-panel ${panelCollapsed ? "is-collapsed" : ""}`}>
          {panelCollapsed ? (
            <button
              type="button"
              className="panel-expand"
              onClick={() => setPanelCollapsed(false)}
              title={t("music.expandQueue")}
            >
              <ListMusic size={18} />
              <span className="panel-expand-count">{state.queue.length}</span>
            </button>
          ) : (
            <>
              <div className="panel-header">
                <span className="panel-title">{t("music.queueTitle")}</span>
                <span className="panel-count">{state.queue.length}</span>
                {modeSet === "cache" && onImportLocalTracks && (
                  <button
                    type="button"
                    className="icon-btn panel-import"
                    onClick={() => onImportLocalTracks()}
                    title={t("music.importLocalMusic")}
                  >
                    <FolderPlus size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn panel-collapse"
                  onClick={() => setPanelCollapsed(true)}
                  title={t("music.collapseQueue")}
                >
                  <PanelRightClose size={16} />
                </button>
              </div>

              <div className="panel-search">
                <Search size={14} className="panel-search-icon" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  placeholder={t("music.searchPlaceholder")}
                  className="panel-search-input"
                />
                {query && (
                  <button
                    type="button"
                    className="icon-btn panel-search-clear"
                    onClick={clearQuery}
                    title={t("music.clearSearch")}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              <div className="panel-content">
                {query ? (
                  <SearchResults
                    results={searchResults}
                    isSearching={isSearching}
                    query={query}
                    currentId={track?.encryptedId}
                    onPlay={actions.playTrack}
                  />
                ) : (
                  <QueueList
                    queue={state.queue}
                    currentId={track?.encryptedId}
                    onPlay={actions.playTrack}
                    onRemove={modeSet === "cache" ? undefined : actions.removeFromQueue}
                    onDeleteTrack={modeSet === "cache" ? onRemoveCachedTrack : undefined}
                  />
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      {state.error && (
        <div className="mp-error" role="alert">
          <AlertCircle size={14} />
          <span>{state.error}</span>
          <button
            type="button"
            className="mp-error-retry"
            onClick={() => track && actions.playTrack(track)}
          >
            {t("music.retry")}
          </button>
        </div>
      )}

      <footer className="mp-controls">
        <ProgressBar
          positionMs={state.positionMs}
          durationMs={state.durationMs}
          onSeek={actions.seek}
        />
        <div className="controls-row">
          <div className="controls-left">
            {/* 装饰图标（原收藏按钮，功能暂缓） */}
            <img className="deco-badge" src={decoBadge} alt="" draggable={false} />
          </div>
          <div className="controls-center">
            <button
              type="button"
              className={`icon-btn ${mode !== "off" ? "is-on" : ""}`}
              onClick={actions.cycleMode}
              title={t("music.modeToggleTitle", {
                label: t(MODE_LABEL_KEY[mode]),
                next: t(MODE_LABEL_KEY[MODE_NEXT[mode]]),
              })}
            >
              <ModeIcon size={17} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={actions.prev}
              title={t("music.prev")}
            >
              <SkipBack size={19} />
            </button>
            <button
              type="button"
              className="play-btn"
              onClick={actions.togglePlayPause}
              disabled={!track || state.isLoading}
              title={state.isPlaying ? t("music.pause") : t("music.play")}
            >
              {state.isLoading ? (
                <Loader2 size={20} className="spin" />
              ) : state.isPlaying ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" className="play-icon" />
              )}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={actions.next}
              title={t("music.next")}
            >
              <SkipForward size={19} />
            </button>
          </div>
          <div className="controls-right">
            <VolumeControl
              volume={state.volume}
              isMuted={state.isMuted}
              onSetVolume={actions.setVolume}
              onToggleMute={actions.toggleMute}
            />
          </div>
        </div>
      </footer>
    </section>
  );
}
