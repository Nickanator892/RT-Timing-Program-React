import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import "./anchoredList.css"

/**
 * A pop-up list that stays on screen.
 *
 * The native <select> popup this replaced opened downward off the bottom of the
 * bench panel with no way to scroll it, which put half the timer modes out of
 * reach (Randy, 2026-09-08). Every list that opens from a control low on the
 * timing page has that problem, so the fix lives here rather than in any one
 * of them: measure the room on each side of the anchor, open into whichever
 * side has more, and clamp to the viewport so a list too tall to fit SCROLLS
 * instead of running off-screen.
 */

export interface AnchoredItem {
    key: string | number;
    label: string;
    selected?: boolean;
}

// Breathing room kept between the list and the edge of the screen, so the last
// row never sits flush against the bezel.
const EDGE_MARGIN = 12;
// Gap between the anchor and the list.
const ANCHOR_GAP = 6;
// Never squeeze the list below about two rows - smaller is easier to miss than
// to use. If neither side has this much room the list still scrolls; it just
// overlaps its anchor.
const MIN_PANEL_HEIGHT = 160;

// Anchored by hand rather than by the browser: `top` when it opens downward,
// `bottom` when it opens upward, so the upward case never needs the panel's own
// height measured first.
type Placement = {
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
};

interface Props {
    anchorRef: React.RefObject<HTMLElement | null>;
    items: AnchoredItem[];
    onPick: (key: string | number) => void;
    onClose: () => void;
    ariaLabel: string;
    /** Extra class on the panel, for per-caller colouring. */
    className?: string;
    /** Shown in place of the list when there is nothing to pick. */
    emptyText?: string;
}

function AnchoredList({ anchorRef, items, onPick, onClose, ariaLabel, className, emptyText }: Props) {
    const [placement, setPlacement] = useState<Placement | null>(null);
    const [activeIndex, setActiveIndex] = useState(() => Math.max(0, items.findIndex((i) => i.selected)));
    const panelRef = useRef<HTMLUListElement>(null);

    const place = useCallback(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const r = anchor.getBoundingClientRect();

        const width = Math.max(r.width, 260);
        const left = Math.min(
            Math.max(EDGE_MARGIN, r.left),
            Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN)
        );

        const spaceBelow = window.innerHeight - r.bottom - ANCHOR_GAP - EDGE_MARGIN;
        const spaceAbove = r.top - ANCHOR_GAP - EDGE_MARGIN;

        if (spaceBelow >= spaceAbove) {
            setPlacement({ left, width, top: r.bottom + ANCHOR_GAP, maxHeight: Math.max(MIN_PANEL_HEIGHT, spaceBelow) });
        } else {
            setPlacement({ left, width, bottom: window.innerHeight - r.top + ANCHOR_GAP, maxHeight: Math.max(MIN_PANEL_HEIGHT, spaceAbove) });
        }
    }, [anchorRef]);

    useLayoutEffect(place, [place, items.length]);

    useEffect(() => {
        const onReflow = (e?: Event) => {
            // The capture-phase listener also hears the panel's OWN scrolling.
            // Re-placing on that produced a fresh placement object, which re-ran
            // the open-onto-selection effect below, which scrolled the current
            // choice back into view - so a finger dragging the list down watched
            // it bounce straight back to the top (Randy, 2026-09-09).
            if (e && panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
            place();
        };
        window.addEventListener("resize", onReflow);
        // Capture phase: the page itself scrolls, not the panel's parent.
        window.addEventListener("scroll", onReflow, true);
        return () => {
            window.removeEventListener("resize", onReflow);
            window.removeEventListener("scroll", onReflow, true);
        };
    }, [place]);

    // Open onto the current choice and bring it into view even when the list had
    // to be clamped - otherwise an entry near the end opens off-scroll, which is
    // the same complaint in a smaller box. Once, when the panel first lands:
    // a later re-placement must never yank a list the operator has scrolled.
    const openedOntoSelection = useRef(false);
    useEffect(() => {
        if (!placement || openedOntoSelection.current) return;
        openedOntoSelection.current = true;
        panelRef.current?.focus();
        panelRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }, [placement]);

    function onKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
        if (e.key === "Escape") {
            e.preventDefault();
            onClose();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const next = Math.min(items.length - 1, Math.max(0, activeIndex + (e.key === "ArrowDown" ? 1 : -1)));
            setActiveIndex(next);
            panelRef.current?.querySelectorAll<HTMLElement>(".anchored-option")[next]?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const item = items[activeIndex];
            if (item) onPick(item.key);
        }
    }

    return (
        <>
            {/* Tap anywhere off the list to dismiss it - more reliable under a
                finger than a document-level listener. */}
            <div className="anchored-backdrop" onPointerDown={onClose} />
            <ul
                ref={panelRef}
                className={"anchored-panel" + (className ? " " + className : "")}
                role="listbox"
                tabIndex={-1}
                aria-label={ariaLabel}
                onKeyDown={onKeyDown}
                style={{
                    left: placement?.left ?? 0,
                    width: placement?.width ?? "auto",
                    maxHeight: placement?.maxHeight ?? MIN_PANEL_HEIGHT,
                    ...(placement?.top !== undefined ? { top: placement.top } : {}),
                    ...(placement?.bottom !== undefined ? { bottom: placement.bottom } : {}),
                    visibility: placement ? "visible" : "hidden",
                }}
            >
                {items.length === 0 && <li className="anchored-empty">{emptyText ?? "Nothing to choose"}</li>}
                {items.map((item, i) => (
                    <li
                        key={item.key}
                        role="option"
                        aria-selected={!!item.selected}
                        data-selected={!!item.selected}
                        className={
                            "anchored-option" +
                            (item.selected ? " is-selected" : "") +
                            (i === activeIndex ? " is-active" : "")
                        }
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => onPick(item.key)}
                    >
                        {item.label}
                    </li>
                ))}
            </ul>
        </>
    )
}

export default AnchoredList
