/**
 * The overview ruler — a mark per problem, beside the editor.
 *
 * The Designer puts a narrow strip down the right of the code area with a mark
 * in line with every line that has a problem; hovering one shows the message.
 * Nigel asked for that here (03/09/2026) and for one thing the Designer does not
 * do: **be able to take the text away**, to paste into a search or a message.
 *
 * Why this and not the Problems panel, which already existed: a defect
 * indicator you have to go and find has failed. Problems lists only documents
 * open as TABS, and it lives in a panel that starts collapsed — so a broken
 * line reported perfectly by the language server showed nothing at all until
 * you went looking ("it said no problems in the open script"). The ruler is
 * always on screen next to the code it describes.
 *
 * **Position is proportional to the document, not to the viewport.** The whole
 * point is to see a problem that is scrolled off screen — a ruler that only
 * marked visible lines would tell you what the squiggles already do.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { lspUri, type LspClient, type LspDiagnostic } from '../api/lspClient';
import { type OpenDoc } from '../workspace/documents';
import { copyText } from './clipboard';
import './ProblemRuler.css';

export interface ProblemRulerProps {
  /** The document being shown. Null hides the ruler entirely. */
  doc: OpenDoc | null;
  lsp?: LspClient | null;
  /** Move the caret to a problem and, where the workspace offers it, reveal it. */
  onSelect: (line: number, character: number) => void;
  /**
   * Where a line sits, as a percentage of the ruler, measured from the editor's
   * own layout. Absent — or returning null — falls back to spreading the line
   * count evenly, which is only right when the document fills the pane.
   */
  offsetOfLine?: (line: number) => number | null;
  /**
   * Bumped by the editor whenever its layout changes (a resize, a scroll, an
   * edit). The ruler has no other way to know that `offsetOfLine` would now
   * answer differently, because the function's identity does not change.
   */
  layoutVersion?: number;
}

/** LSP DiagnosticSeverity → the word used in the class and the label. */
export function severityName(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    default:
      return 'hint';
  }
}

/**
 * Where a mark sits, as a percentage of the ruler's height.
 *
 * The FALLBACK only — used when the editor cannot be measured (a test, or a
 * view that has not laid out yet). It spreads the line count evenly over the
 * ruler, which is wrong whenever the document does not fill the editor: a
 * 28-line script in an 819px pane occupies about 530px of it, so line 28 was
 * drawn at the bottom of the ruler while the code it described sat two thirds
 * up. Nigel, 04/09/2026: "it seems to just appear randomly."
 *
 * `geometryOffset` below is the real answer and is used whenever a view exists.
 */
export function markOffset(line: number, lineCount: number): number {
  if (lineCount <= 1) return 0;
  const ratio = Math.min(1, Math.max(0, line / (lineCount - 1)));
  return Math.round(ratio * 10000) / 100;
}

/**
 * Where a mark sits, from the editor's OWN layout.
 *
 * `top` is the line's offset within the content, and the denominator is the
 * taller of the content and the visible pane:
 *
 * - a document SHORTER than the pane divides by the pane height, so a mark
 *   lands exactly beside the line it describes;
 * - a document TALLER than the pane divides by the content height, so the ruler
 *   represents the whole file — which is the point of having one, and is what
 *   both VS Code and the Designer do.
 *
 * Returns null when the geometry is not usable yet, so the caller can fall back
 * rather than divide by zero.
 */
export function geometryOffset(
  top: number,
  contentHeight: number,
  paneHeight: number
): number | null {
  const span = Math.max(contentHeight, paneHeight);
  if (!Number.isFinite(top) || !Number.isFinite(span) || span <= 0) return null;
  const ratio = Math.min(1, Math.max(0, top / span));
  return Math.round(ratio * 10000) / 100;
}

/** The worst severity in a set — the one a merged mark should take. */
export function worstSeverity(diagnostics: LspDiagnostic[]): number {
  return diagnostics.reduce(
    (worst, d) => Math.min(worst, d.severity ?? 4),
    4
  );
}

export default function ProblemRuler({
  doc, lsp, onSelect, offsetOfLine, layoutVersion = 0,
}: ProblemRulerProps) {
  const [diagnostics, setDiagnostics] = useState<LspDiagnostic[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  // Python only. A ruler beside a Web Dev HTML file would carry one mark per
  // line, every one of them the Jython parser objecting to markup.
  // Every document, not only the Python ones. From 1.14.0 a Web Dev stylesheet
  // or a named query's SQL publishes its own parser's diagnostics into the same
  // store (see syntaxLint), and gating this on Python left the ruler blank
  // beside a file that had a squiggle in it.
  const serverUri = doc ? lspUri(doc.project, doc.path, doc.scriptKey) : null;

  useEffect(() => {
    setDiagnostics([]);
    if (!lsp || !serverUri) return;
    // The client replays the last diagnostics it holds on subscribe, so a ruler
    // mounted after the server published still draws them. Without that, the
    // marks would only appear on the NEXT keystroke.
    return lsp.onDiagnostics(serverUri, setDiagnostics);
  }, [lsp, serverUri]);

  const lineCount = useMemo(
    () => (doc ? doc.text.split('\n').length : 0),
    [doc]
  );

  /**
   * One mark per LINE, not per diagnostic.
   *
   * A parser routinely reports several problems on one line, and three marks
   * stacked at identical offsets read as one mark with a dirty edge — while
   * making the tooltip show whichever happened to be on top. Merged, the mark
   * takes the worst severity and the tooltip lists all of them.
   */
  const marks = useMemo(() => {
    const byLine = new Map<number, LspDiagnostic[]>();
    for (const diagnostic of diagnostics) {
      const line = diagnostic.range.start.line;
      byLine.set(line, [...(byLine.get(line) ?? []), diagnostic]);
    }
    return [...byLine.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([line, group]) => ({
        line,
        group,
        severity: severityName(worstSeverity(group)),
        offset: offsetOfLine?.(line) ?? markOffset(line, lineCount),
        text: group.map((d) => d.message).join('\n'),
      }));
    // `layoutVersion` is a dependency deliberately: it is the only signal
    // that the editor's geometry moved under us, since the function's
    // identity does not change when the layout does.
  }, [diagnostics, lineCount, offsetOfLine, layoutVersion]);

  const copy = useCallback((key: string, text: string) => {
    // Through `copyText`, NOT `navigator.clipboard` directly: this gateway is
    // served over HTTP, where the async Clipboard API does not exist at all and
    // an optional call is a silent no-op. See clipboard.ts.
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    });
  }, []);

  if (!doc) return null;

  return (
    <div
      className="problem-ruler"
      role="group"
      aria-label={marks.length === 0
        ? 'No problems in this script'
        : `${marks.length} line(s) with problems`}
    >
      {marks.map((mark) => (
        <div
          key={mark.line}
          className="problem-ruler-slot"
          style={{ top: `${mark.offset}%` }}
        >
          <button
            type="button"
            className={`problem-ruler-mark is-${mark.severity}`}
            aria-label={`${mark.severity} on line ${mark.line + 1}: ${mark.text}`}
            onClick={() => onSelect(mark.line, mark.group[0].range.start.character)}
          />
          {/* The card is a sibling of the mark and shown on hovering the SLOT,
              so the pointer can travel from the mark onto the card without it
              closing — which is what makes the copy button reachable at all. */}
          <div className="problem-ruler-card" role="tooltip">
            <div className="problem-ruler-where">
              Line {mark.line + 1} · {mark.severity}
            </div>
            {mark.group.map((d, i) => (
              <p key={`${d.message}:${i}`} className="problem-ruler-message">
                {d.message}
              </p>
            ))}
            <button
              type="button"
              className="problem-ruler-copy"
              onClick={(event) => {
                event.stopPropagation();
                copy(String(mark.line), mark.text);
              }}
            >
              {copied === String(mark.line) ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
