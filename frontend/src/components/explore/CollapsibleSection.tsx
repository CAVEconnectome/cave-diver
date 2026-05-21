import { useEffect, useState, type ReactNode } from "react";

interface Props {
  /** Section title shown on the header bar. */
  title: string;
  /** Whether the section's action surface is meaningful right now. When
   *  false the header is grayed, non-interactive, and children are not
   *  rendered. Hover hint comes from ``disabledHint``. */
  enabled: boolean;
  /** Tooltip shown on the disabled header — typically tells the user
   *  what condition would enable it (e.g. "make a selection first"). */
  disabledHint?: string;
  /** Optional short tag rendered on the right of the header, e.g. a
   *  count of seeds or a status marker. Hidden when disabled. */
  badge?: string;
  /** Optional interactive element rendered on the right side of the
   *  header — typically a small button that fires a related action
   *  (e.g. a section-level "find cells" trigger for Build Selection).
   *  Clicks inside this node are swallowed at the header's level so
   *  they don't collapse / expand the section. Hidden when disabled. */
  headerAction?: ReactNode;
  /** Optional condensed view rendered below the header when the
   *  section is enabled and collapsed. Lets a closed section still
   *  communicate its current state (e.g. "minnie65_public · umap")
   *  without forcing the user to expand the controls. */
  summary?: ReactNode;
  /** Initial open state when first enabled. Closed by default so the
   *  user opens the panel when they're ready to act, rather than the
   *  rail jumping at them the moment they click a cell. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Rail-section primitive with a disabled / collapsed / open tri-state.
 *
 * The rail design principle this enforces: surfaces never vanish based
 * on data state. A user learns where "grow selection" lives once and
 * always finds it there — sometimes grayed out, sometimes open, but
 * never gone. Compared to conditionally mounting the whole panel based
 * on ``selectionBag.length > 0``, this keeps the visual rhythm stable
 * and signals action availability via state change instead of presence
 * change.
 *
 * When ``enabled`` flips false while open, the section auto-collapses
 * (its contents are no longer actionable, so showing them is
 * misleading). Re-enabling does NOT auto-open — the user has to click
 * to bring it back, matching the "don't pop content under the user's
 * cursor" rule.
 */
export function CollapsibleSection({
  title,
  enabled,
  disabledHint,
  badge,
  headerAction,
  summary,
  defaultOpen = false,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  // Auto-collapse when the section loses its actionable status. The
  // converse — auto-open on re-enable — is intentionally NOT done; the
  // rail shouldn't expand under the user's cursor without an explicit
  // click.
  useEffect(() => {
    if (!enabled && open) setOpen(false);
  }, [enabled, open]);

  const toggleable = enabled;

  return (
    <section
      className={`rail-section${enabled ? "" : " disabled"}${open ? " open" : ""}`}
    >
      {/* Header is a flex wrap so the toggle button can sit beside an
          optional ``headerAction`` slot. The toggle stays its own
          <button> rather than nesting interactive elements inside it
          (which would fight on focus, ARIA, and click semantics);
          ``headerAction`` is a sibling that doesn't trigger collapse
          when clicked. */}
      <div className="rail-section-header-wrap">
        <button
          type="button"
          className="rail-section-header"
          onClick={() => toggleable && setOpen((v) => !v)}
          disabled={!enabled}
          title={
            !enabled
              ? disabledHint
              : open
                ? `Collapse ${title}`
                : `Expand ${title}`
          }
          aria-expanded={open}
        >
          <span className="rail-section-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="rail-section-title">{title}</span>
          {enabled && badge && (
            <span className="rail-section-badge">{badge}</span>
          )}
        </button>
        {enabled && headerAction && (
          <span
            className="rail-section-header-action"
            // Defensive: even though siblings don't bubble into the
            // toggle button, an inner element using a wrapper click
            // handler could still propagate up the section. Stop here.
            onClick={(e) => e.stopPropagation()}
          >
            {headerAction}
          </span>
        )}
      </div>
      {enabled && !open && summary && (
        <div className="rail-section-summary">{summary}</div>
      )}
      {enabled && open && (
        <div className="rail-section-body">{children}</div>
      )}
    </section>
  );
}
