/**
 * The icon set.
 *
 * Inline SVG, not an icon font and not a package: the gateway may be air-gapped
 * (offlineAssets.test.ts forbids any external asset host), and a dozen glyphs do
 * not justify a dependency. Each is a 16×16 viewBox using `currentColor`, so an
 * icon takes its colour from the row it sits in and every theme works for free.
 *
 * Shapes follow VS Code's Codicons closely enough to be recognisable, because
 * the point of an icon here is that someone already knows what it means.
 */
export interface IconProps {
  /** Rendered size in px. 16 matches the tree row height. */
  size?: number;
  className?: string;
}

function svg(path: React.ReactNode, { size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: every icon in this app sits beside a text label or inside a
      // control with an aria-label, so announcing it would only add noise.
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {path}
    </svg>
  );
}

/** Activity bar: the scripting explorer. */
export const IconFiles = (p: IconProps) =>
  svg(
    <>
      <path d="M9.5 1.5H3.5v13h9V4.5z" />
      <path d="M9.5 1.5v3h3" />
    </>,
    p
  );

/** Activity bar: Web Dev. */
export const IconGlobe = (p: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.7 1.9 2.6 4 2.6 6.2S9.7 12.3 8 14.2C6.3 12.3 5.4 10.2 5.4 8S6.3 3.7 8 1.8z" />
    </>,
    p
  );

/**
 * Activity bar: named queries — a database cylinder.
 *
 * The one glyph everybody reads as "a database" without a label, which is what
 * an activity-bar icon has to be: an ellipse for the top and two arcs for the
 * bands, drawn in strokes like every other icon here so it takes the row's
 * colour and needs no theme of its own.
 */
export const IconDatabase = (p: IconProps) =>
  svg(
    <>
      <ellipse cx="8" cy="3.6" rx="5.4" ry="2" />
      <path d="M2.6 3.6v8.8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V3.6" />
      <path d="M2.6 8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2" />
    </>,
    p
  );

/** Activity bar: search. */
export const IconSearch = (p: IconProps) =>
  svg(
    <>
      <circle cx="6.8" cy="6.8" r="4.6" />
      <path d="M10.2 10.2 14 14" />
    </>,
    p
  );

/** Activity bar / tree: the console. */
export const IconTerminal = (p: IconProps) =>
  svg(
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M4 6l2.2 2L4 10M8.4 10.4h3.4" />
    </>,
    p
  );

/** A Python module in the project library. */
export const IconScript = (p: IconProps) =>
  svg(
    <>
      <path d="M9 1.6H4a1 1 0 0 0-1 1v10.8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.6z" />
      <path d="M9 1.6v4h4" />
      <path d="M5.6 9.2h4.8M5.6 11.4h3" />
    </>,
    p
  );

/** A package/folder in the tree. */
export const IconFolder = (p: IconProps) =>
  svg(<path d="M1.6 12.6V3.4h4.2l1.4 1.6h7.2v7.6a.8.8 0 0 1-.8.8H2.4a.8.8 0 0 1-.8-.8z" />, p);

/** Timer event script. */
export const IconClock = (p: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4V8l2.6 1.6" />
    </>,
    p
  );

/** Message handler. */
export const IconMail = (p: IconProps) =>
  svg(
    <>
      <rect x="1.6" y="3.4" width="12.8" height="9.2" rx="1" />
      <path d="m1.6 4.4 6.4 4.4 6.4-4.4" />
    </>,
    p
  );

/** Scheduled (cron) event script. */
export const IconCalendar = (p: IconProps) =>
  svg(
    <>
      <rect x="1.8" y="3" width="12.4" height="11.2" rx="1" />
      <path d="M1.8 6.4h12.4M5.2 1.6v2.8M10.8 1.6v2.8" />
    </>,
    p
  );

/** Tag change event script. */
export const IconTag = (p: IconProps) =>
  svg(
    <>
      <path d="M8.2 1.8H14v5.8l-6.4 6.4a1 1 0 0 1-1.4 0L1.8 9.6a1 1 0 0 1 0-1.4z" />
      <circle cx="11.2" cy="4.8" r="1" />
    </>,
    p
  );

/** Startup / shutdown / update — a lifecycle event. */
export const IconPower = (p: IconProps) =>
  svg(
    <>
      <path d="M8 1.8v6.4" />
      <path d="M11.9 4.1a5.5 5.5 0 1 1-7.8 0" />
    </>,
    p
  );

export const IconPlay = (p: IconProps) => svg(<path d="M4.4 2.6 13 8l-8.6 5.4z" />, p);
export const IconStop = (p: IconProps) => svg(<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1" />, p);
export const IconPlus = (p: IconProps) => svg(<path d="M8 3.2v9.6M3.2 8h9.6" />, p);
export const IconTrash = (p: IconProps) =>
  svg(
    <>
      <path d="M2.6 4.2h10.8M6 4.2V2.8h4v1.4M4 4.2l.7 9.2a.8.8 0 0 0 .8.8h5a.8.8 0 0 0 .8-.8l.7-9.2" />
    </>,
    p
  );
export const IconClose = (p: IconProps) => svg(<path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />, p);
/**
 * Discard an override — a counter-clockwise arrow, VS Code's "discard changes".
 *
 * Deliberately NOT the trash can: discarding an override removes the local copy
 * and the script keeps working, inherited from the parent. The same glyph for
 * both would say the two actions have the same consequence, and they do not.
 */
export const IconRevert = (p: IconProps) =>
  svg(
    <>
      <path d="M3.1 6.6h3.6V3" />
      <path d="M3.4 6.4a5.4 5.4 0 1 1-.7 3.6" />
    </>,
    p
  );
export const IconSplit = (p: IconProps) =>
  svg(
    <>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1" />
      <path d="M8 2.6v10.8" />
    </>,
    p
  );
export const IconExternal = (p: IconProps) =>
  svg(
    <>
      <path d="M9.4 2.4H13.6v4.2" />
      <path d="M13.6 2.4 7.6 8.4" />
      <path d="M12 9.2v3.6a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8H7" />
    </>,
    p
  );
export const IconList = (p: IconProps) =>
  svg(<path d="M5.4 4h8.2M5.4 8h8.2M5.4 12h8.2M2.4 4h.01M2.4 8h.01M2.4 12h.01" />, p);
export const IconChevronRight = (p: IconProps) => svg(<path d="M6 3.5 10.5 8 6 12.5" />, p);
export const IconChevronDown = (p: IconProps) => svg(<path d="M3.5 6 8 10.5 12.5 6" />, p);

/** The icon for a script resource type, by typeId. */
/* ---- Layout controls -----------------------------------------------------
 *
 * VS Code's four title-bar glyphs, in its own order: customise layout, then the
 * primary side bar, the panel and the secondary side bar. Each is the same
 * rounded rectangle with the region in question filled, which is what makes the
 * set legible at 16px without labels — the filled part IS the answer to "which
 * edge does this toggle".
 */
const FRAME = <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4" />;

export const IconLayout = (p: IconProps) =>
  svg(
    <>
      {FRAME}
      <path d="M1.6 6.2h12.8M6.2 6.2v7.2" />
    </>,
    p
  );

export const IconSideBarLeft = (p: IconProps) =>
  svg(
    <>
      {FRAME}
      <path d="M6 2.6v10.8" />
      <path d="M1.6 2.6h4.4v10.8H1.6z" fill="currentColor" stroke="none" opacity="0.85" />
    </>,
    p
  );

export const IconPanelBottom = (p: IconProps) =>
  svg(
    <>
      {FRAME}
      <path d="M1.6 9.6h12.8" />
      <path d="M1.6 9.6h12.8v3.8H1.6z" fill="currentColor" stroke="none" opacity="0.85" />
    </>,
    p
  );

export const IconSideBarRight = (p: IconProps) =>
  svg(
    <>
      {FRAME}
      <path d="M10 2.6v10.8" />
      <path d="M10 2.6h4.4v10.8H10z" fill="currentColor" stroke="none" opacity="0.85" />
    </>,
    p
  );

/** Panel chrome: grow the panel to fill the editor area, and put it back. */
export const IconChevronUp = (p: IconProps) => svg(<path d="M3.5 10 8 5.5 12.5 10" />, p);

/** A tick, for the layout menu's checked items. */
export const IconCheck = (p: IconProps) => svg(<path d="M3.2 8.4 6.4 11.6 12.8 4.6" />, p);

/**
 * A problem marker: a triangle with a bang in it.
 *
 * One glyph for every severity, coloured by the row's own class rather than by
 * a prop — the estate rule is that a status colour is a CSS variable on a class,
 * never a hex value handed to a component.
 */
export const IconAlert = (p: IconProps) =>
  svg(
    <>
      <path d="M8 2.4 14.6 13.4H1.4z" />
      <path d="M8 6.4v3.1" />
      <path d="M8 11.5v.1" />
    </>,
    p
  );

export function iconForType(typeId: string, props: IconProps = {}) {
  switch (typeId) {
    case 'timer':
      return <IconClock {...props} />;
    case 'message':
      return <IconMail {...props} />;
    case 'scheduled':
      return <IconCalendar {...props} />;
    case 'tag-change':
      return <IconTag {...props} />;
    case 'startup':
    case 'shutdown':
    case 'update':
      return <IconPower {...props} />;
    case 'webdev':
      return <IconGlobe {...props} />;
    case 'named-query':
      return <IconDatabase {...props} />;
    default:
      return <IconScript {...props} />;
  }
}


/** Bottom panel: the test runner. A flask, which is what every runner uses. */
export const IconFlask = (p: IconProps) =>
  svg(
    <>
      <path d="M6.4 1.8v4.1L3 12.1a1.4 1.4 0 0 0 1.2 2.1h7.6a1.4 1.4 0 0 0 1.2-2.1L9.6 5.9V1.8" />
      <path d="M5.4 1.8h5.2" />
      <path d="M4.6 10.2h6.8" />
    </>,
    p
  );

/**
 * The console laid out in ROWS — editor above, output below.
 *
 * A pair beside {@link IconColumns}, and the two must read as a pair at 14px:
 * one box divided the short way, one divided the long way. Distinct from
 * {@link IconSplit}, which is about moving a document between editor panes
 * rather than about an orientation.
 */
export const IconRows = (p: IconProps) =>
  svg(
    <>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1" />
      <path d="M1.6 8h12.8" />
    </>,
    p
  );

/** The console laid out in COLUMNS — editor left, output right. */
export const IconColumns = (p: IconProps) =>
  svg(
    <>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1" />
      <path d="M8 2.6v10.8" />
    </>,
    p
  );
