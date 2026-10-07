/* Page chrome for the workbench: the draft chip, the checks panel, the YAML preview, and the import and template dialogs.
 * Presentational: all state flows in through props from the Designer. */

import type { RefObject } from "react";
import { Banner, Button, Dialog, TextArea, useDismissable } from "../components";
import { Icon } from "../icons";
import { CloseButton, PathLabel } from "./ui";
import { locateIssue, whereLabel, type Where } from "./locate";
import { TEMPLATES, type Template } from "./model";
import type { DraftStatus } from "./save";
import type { Advice } from "./types";

/* ---------------- the draft chip ---------------- */

/** Where the draft stands against mesh.yaml, in two words, beside the page title. */
export function DraftChip({ status }: { status: DraftStatus }): React.JSX.Element {
  const tone = status.kind === "unsaved" || status.kind === "restored" ? "warn" : status.kind === "clean" ? "ok" : "neutral";
  return <span className={`pill ${tone}`} role="status" title={status.detail}>{status.label}</span>;
}

/* ---------------- the checks ---------------- */

export interface ChecksButtonProps {
  checking: boolean;
  valid: boolean;
  offline: boolean;
  errors: number;
  notes: number;
  open: boolean;
  onToggle: () => void;
  btnRef: RefObject<HTMLButtonElement | null>;
}

/** The verdict, as a button that opens the list: what the server says about the draft, as one word and a count. */
export function ChecksButton({ checking, valid, offline, errors, notes, open, onToggle, btnRef }: ChecksButtonProps): React.JSX.Element {
  const tone = checking ? "neutral" : offline ? "warn" : valid ? (notes ? "warn" : "ok") : "bad";
  const text = checking ? "Checking" : offline ? "Check failed" : valid ? (notes ? `Valid, ${notes} ${notes === 1 ? "note" : "notes"}` : "Valid") : `${errors} ${errors === 1 ? "error" : "errors"}`;
  return (
    <button
      type="button" ref={btnRef} className={`pill no-dot ms-verdict ${tone}`} aria-expanded={open} aria-haspopup="dialog"
      title="What the server says about this draft, and where to fix it" onClick={onToggle}
    >
      <Icon name={tone === "bad" || tone === "warn" ? "alert" : "check"} size={14} />
      {text}
    </button>
  );
}

function IssueList({ items, kind, seats, onGo }: { items: string[]; kind: "error" | "note"; seats: string[]; onGo: (w: Where) => void }): React.JSX.Element {
  return (
    <ul className="ms-issues">
      {items.map((text) => {
        const where = locateIssue(text, seats);
        return (
          <li key={text} className={`ms-issue ${kind}`}>
            <Icon name={kind === "error" ? "alert" : "info"} size={16} />
            <span className="ms-issue-text">{text}</span>
            {where.editable
              ? <Button variant="small" onClick={() => onGo(where)}>{whereLabel(where)}</Button>
              : <span className="ms-issue-note">Edit mesh.yaml directly. The Designer has no field for this.</span>}
          </li>
        );
      })}
    </ul>
  );
}

export interface ChecksPanelProps {
  checking: boolean;
  valid: boolean;
  offline: boolean;
  errors: string[];
  notes: Advice[];
  seats: string[];
  onGo: (w: Where) => void;
  onYaml: () => void;
  onClose: () => void;
  rootRef: RefObject<HTMLDivElement | null>;
}

export function ChecksPanel({ checking, valid, offline, errors, notes, seats, onGo, onYaml, onClose, rootRef }: ChecksPanelProps): React.JSX.Element {
  const status = checking
    ? "Checking the draft."
    : offline
      ? "Could not reach the server. This is the last result, and your edits are kept."
      : valid
        ? `No errors. The server accepts this mesh.${notes.length ? ` ${notes.length} ${notes.length === 1 ? "note is" : "notes are"} worth a look.` : ""}`
        : `${errors.length} ${errors.length === 1 ? "error" : "errors"}. Fix ${errors.length === 1 ? "it" : "them"} to save.`;
  return (
    <div className="ms-pop ms-checks" role="dialog" aria-label="Checks" ref={rootRef} tabIndex={-1}>
      <div className="ms-pop-head">
        <h3>Checks</h3>
        <CloseButton label="Close the checks" onClick={onClose} />
      </div>
      <p className={`ms-pop-status${!checking && !valid && !offline ? " bad" : ""}`} role="status">{status}</p>
      {!valid && !offline && !checking && errors.length ? (
        <section aria-label="Errors">
          <h4>Errors</h4>
          <IssueList items={errors} kind="error" seats={seats} onGo={onGo} />
        </section>
      ) : null}
      {notes.length ? (
        <section aria-label="Notes">
          <h4>Notes</h4>
          <p className="ms-hint">These do not block a save. They are things the server thinks are worth a look.</p>
          <IssueList items={notes.map((n) => n.msg)} kind="note" seats={seats} onGo={onGo} />
        </section>
      ) : null}
      <div className="ms-pop-foot">
        <span className="ms-hint">The server checks the draft as you edit.</span>
        <Button variant="small" icon="files" onClick={onYaml}>View YAML</Button>
      </div>
    </div>
  );
}

/* ---------------- YAML preview ---------------- */

export interface YamlSlideProps {
  yaml: string | null;
  path: string;
  /** The last check failed, so what is shown is the last version that passed. */
  invalid: boolean;
  /** The last check could not reach the server. */
  stale: boolean;
  onCopy: () => void;
  onClose: () => void;
}

/** The file Save writes, on demand, beside the canvas. It is the server's own rendering of the payload, so it is the exact text. */
export function YamlSlide({ yaml, path, invalid, stale, onCopy, onClose }: YamlSlideProps): React.JSX.Element {
  const ref = useDismissable<HTMLDivElement>(true, onClose);
  return (
    <div className="ms-slide" role="dialog" aria-label="YAML preview" ref={ref} tabIndex={-1}>
      <div className="ms-slide-head">
        <h3>YAML</h3>
        <CloseButton label="Close the YAML preview" onClick={onClose} />
      </div>
      <div className="ms-slide-meta">
        {path ? <PathLabel path={path} /> : null}
        <Button variant="small" icon="copy" onClick={onCopy}>Copy</Button>
      </div>
      <p className="ms-hint">This is the file Save changes writes. Comments in the existing file are not kept; the old file is kept in .mesh-versions first.</p>
      {invalid || stale ? (
        <Banner tone="warn" title={invalid ? "The draft has errors." : "Could not re-check."}>
          {invalid ? "Showing the last version that passed." : "This may be out of date."}
        </Banner>
      ) : null}
      <pre className="yaml-pane" tabIndex={0} aria-label="YAML text">{yaml ?? "Waiting for the first check."}</pre>
    </div>
  );
}

/* ---------------- dialogs ---------------- */

export interface ImportDialogProps {
  text: string;
  setText: (v: string) => void;
  error: string;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}

export function ImportDialog({ text, setText, error, busy, onApply, onCancel }: ImportDialogProps): React.JSX.Element {
  return (
    <Dialog
      title="Import YAML" labelId="ms-import-title" wide onClose={onCancel}
      onSubmit={(e) => { e.preventDefault(); if (text.trim() && !busy) onApply(); }}
      actions={(
        <>
          <Button variant="soft" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!text.trim() || busy}>{busy ? "Reading…" : "Import"}</Button>
        </>
      )}
    >
      <p className="ms-hint">Paste the text of a mesh.yaml. It replaces the draft, and you can undo it. Nothing is saved.</p>
      <TextArea mono rows={10} spellCheck={false} placeholder="version: 1&#10;mesh:&#10;  id: my-mesh" aria-label="YAML to import" value={text} onChange={(e) => setText(e.target.value)} />
      {error ? <p className="ms-hint bad" role="alert">{error}</p> : null}
    </Dialog>
  );
}

export interface TemplateDialogProps {
  /** Unsaved changes the replacement would discard, so the dialog can say so. */
  unsaved: number;
  onPick: (t: Template) => void;
  onCancel: () => void;
}

export function TemplateDialog({ unsaved, onPick, onCancel }: TemplateDialogProps): React.JSX.Element {
  return (
    <Dialog title="Start from a template" labelId="ms-tpl-title" wide onClose={onCancel} actions={<Button variant="soft" onClick={onCancel}>Cancel</Button>}>
      <p className="ms-hint">
        A template replaces the draft with a small team to edit.{" "}
        {unsaved ? <b>It discards your {unsaved} unsaved {unsaved === 1 ? "change" : "changes"}. You can undo it right after.</b> : "You can undo it right after."}
      </p>
      <div className="ms-templates stacked">
        {TEMPLATES.map((t) => (
          <button key={t.key} type="button" className="ms-template" onClick={() => onPick(t)}>
            <b>{t.name}</b>
            <span>{t.desc}</span>
            <em>{t.seats} {t.seats === 1 ? "seat" : "seats"}</em>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
