/**
 * The folder picker.
 *
 * A browser `<input type=file webkitdirectory>` hands back a sandboxed name, never the real path the host has to stat, so
 * the HOST lists directories and this walks them. Typing a path stays the fast way for someone who knows it.
 *
 * It only chooses: it never writes, never registers. The caller does that with the path it is handed, after saying what
 * it is about to write and where.
 *
 * Keyboard first: the path field has focus on open; Enter lists what is typed; the arrow keys walk the folders, Enter
 * opens one, Backspace or Left goes up, Escape closes.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, useDismissable } from "./components";
import { Icon } from "./icons";
import { api } from "./api";
import { folderName } from "./projectsmodel";
import "./projects.css";

interface BrowseEntry {
  name: string;
  path: string;
  hasMesh: boolean;
}

interface Listing {
  path: string;
  parent: string | null;
  hasMesh: boolean;
  entries: BrowseEntry[];
  error?: string;
}

/** The host's `error` for an unreadable folder is a system message; say what it means. */
function listingProblem(error: string): string {
  if (/ENOENT/.test(error)) return "That folder does not exist.";
  if (/ENOTDIR/.test(error)) return "That path is a file, not a folder.";
  if (/EACCES|EPERM/.test(error)) return "This host is not allowed to read that folder.";
  return `This host could not read that folder (${error.slice(0, 120)}).`;
}

export function FolderPicker({ initialPath, title = "Choose a folder", confirmLabel = "Use this folder", onChoose, onClose }: {
  /** Where to start; the host's own starting point (the projects directory, or the home folder) when empty. */
  initialPath?: string;
  title?: string;
  confirmLabel?: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [dir, setDir] = useState<Listing | null>(null);
  const [typed, setTyped] = useState(initialPath?.trim() ?? "");
  const [loading, setLoading] = useState(true);
  /** A refusal that leaves the previous listing on screen: a folder outside the projects directory, a host that did not answer. */
  const [refused, setRefused] = useState("");
  const dialogRef = useDismissable<HTMLDivElement>(true, onClose);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const seq = useRef(0);
  const dead = useRef(false);
  /** The person navigated with the keyboard from the list, so focus goes back to the list when the next one lands. */
  const refocus = useRef(false);

  const browse = useCallback(async (path: string | null, fromList = false) => {
    const mine = ++seq.current;
    setLoading(true);
    setRefused("");
    refocus.current = fromList;
    let res: Awaited<ReturnType<typeof api>> | null;
    try {
      res = await api("GET", `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    } catch {
      res = null;
    }
    // Answers can arrive out of order when someone walks quickly; only the latest counts. And the dialog may be gone.
    if (dead.current || mine !== seq.current) return;
    setLoading(false);
    if (res === null || res.status === 0) {
      setRefused("The host did not answer. Check that it is still running, then try again.");
      return;
    }
    const json = res.json;
    if (res.status === 403) {
      setRefused(typeof json?.reason === "string" ? json.reason : typeof json?.error === "string" ? json.error : "This host will not list that folder.");
      return;
    }
    if (res.status !== 200 || !json || typeof json.path !== "string") {
      setRefused(`The host answered ${res.status}. Try again.`);
      return;
    }
    setDir({
      path: json.path,
      parent: typeof json.parent === "string" ? json.parent : null,
      hasMesh: json.hasMesh === true,
      entries: Array.isArray(json.entries) ? json.entries : [],
      error: typeof json.error === "string" ? json.error : undefined,
    });
    setTyped(json.path);
  }, []);

  useEffect(() => {
    dead.current = false;
    void browse(initialPath?.trim() || null);
    return () => {
      dead.current = true;
    };
    // Opened once, at the path it was given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After walking from the list, the next list gets the focus: otherwise it falls to <body> when the row that had it is replaced.
  useEffect(() => {
    if (loading || !refocus.current) return;
    refocus.current = false;
    (listRef.current?.querySelector<HTMLButtonElement>("button") ?? inputRef.current)?.focus();
  }, [loading, dir]);

  const rows = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];

  const onListKey = (e: React.KeyboardEvent): void => {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[Math.min(at + 1, all.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at <= 0) inputRef.current?.focus();
      else all[at - 1]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      all[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      all[all.length - 1]?.focus();
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && dir?.parent) {
      e.preventDefault();
      void browse(dir.parent, true);
    }
  };

  const listed = dir !== null && typed.trim() === dir.path;
  const usable = listed && !loading && !dir.error;
  const problem = dir?.error ? listingProblem(dir.error) : "";

  return (
    <div className="proj-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title" ref={dialogRef}>
      <div className="proj-picker-head">
        <h2 id="picker-title">{title}</h2>
        <p className="muted">Type a path and press Enter, or walk the folders: arrow keys to move, Enter to open one, Backspace to go up.</p>
      </div>
      <div className="proj-picker-path">
        <input
          ref={inputRef}
          className="txt mono"
          aria-label="Folder path"
          value={typed}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void browse(typed.trim() || null);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              rows()[0]?.focus();
            }
          }}
        />
        <Button variant="soft" title="List this folder" onClick={() => void browse(typed.trim() || null)}>List</Button>
      </div>
      {dir && !listed && !loading && typed.trim() ? <p className="proj-picker-hint">Press Enter to list this folder. The button below acts on the folder that is listed.</p> : null}
      {refused ? <div className="proj-picker-err" role="alert">{refused}</div> : null}
      {problem ? <div className="proj-picker-err" role="alert">{problem}</div> : null}
      <ul className="proj-picker-list" ref={listRef} onKeyDown={onListKey} aria-label={dir ? `Folders in ${dir.path}` : "Folders"} aria-busy={loading}>
        {dir?.parent ? (
          <li>
            <button type="button" className="proj-picker-row up" onClick={() => void browse(dir.parent, true)}>
              <Icon name="arrow-up" size={16} />
              <span className="proj-picker-name">Up to {folderName(dir.parent)}</span>
            </button>
          </li>
        ) : null}
        {(dir?.entries ?? []).map((e) => (
          <li key={e.path}>
            <button type="button" className="proj-picker-row" onClick={() => void browse(e.path, true)}>
              <Icon name="folder" size={16} />
              <span className="proj-picker-name" title={e.name}>{e.name}</span>
              {e.hasMesh ? <em>mesh.yaml</em> : null}
            </button>
          </li>
        ))}
        {dir && !dir.entries.length && !dir.error ? <li className="muted proj-picker-empty">No folders inside this one.</li> : null}
        {!dir && loading ? <li className="muted proj-picker-empty" role="status">Listing…</li> : null}
      </ul>
      <div className="proj-picker-foot">
        <div className="proj-picker-here" title={dir?.path}>
          <span className="path-start mono"><bdi>{dir?.path ?? "…"}</bdi></span>
          {dir?.hasMesh ? <em>mesh.yaml here</em> : null}
        </div>
        <div className="proj-picker-acts">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!usable} onClick={() => dir && onChoose(dir.path)}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The picker as a modal over whatever is behind it: a scrim that closes it, and the picker above. */
export function FolderPickerModal(props: React.ComponentProps<typeof FolderPicker>): React.JSX.Element {
  return (
    <>
      <div className="pj-scrim pj-scrim-top" aria-hidden="true" onClick={props.onClose} />
      <FolderPicker {...props} />
    </>
  );
}
