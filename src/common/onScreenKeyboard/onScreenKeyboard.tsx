import "./onScreenKeyboard.css";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Touchscreen keyboard for the shop-floor Pi, which has no physical keyboard.
 *
 * Mounted once at the app root. It watches for focus landing on any text or
 * number field anywhere in the app and slides up; Enter (or Done) submits and
 * dismisses it. Built in-app rather than shelling out to matchbox/onboard so it
 * works on any Pi image without an extra package, and so it matches the app's
 * own styling and hit-target sizes.
 */

type Layout = "text" | "numeric";

const ROWS_TEXT = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l", "-"],
    ["z", "x", "c", "v", "b", "n", "m", ".", "/"],
];

const ROWS_NUMERIC = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    [".", "0", "-"],
];

function isEditable(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    const type = (el as HTMLInputElement).type;
    return ["text", "password", "number", "search", "tel", "email", "url"].includes(type);
}

/**
 * React tracks input state internally, so assigning .value is ignored. Go
 * through the native setter and fire a bubbling input event, which is what
 * React's onChange actually listens for.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
}

function OnScreenKeyboard() {
    const [target, setTarget] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
    const [shift, setShift] = useState(false);
    const closingRef = useRef<number | null>(null);

    useEffect(() => {
        function onFocusIn(e: FocusEvent) {
            const el = e.target as Element;
            if (!isEditable(el)) return;
            if (closingRef.current) {
                window.clearTimeout(closingRef.current);
                closingRef.current = null;
            }
            setTarget(el);
        }
        function onFocusOut(e: FocusEvent) {
            if (!isEditable(e.target as Element)) return;
            // Tapping a key blurs the field for an instant; wait to see whether
            // focus comes straight back before dismissing.
            closingRef.current = window.setTimeout(() => setTarget(null), 120);
        }
        document.addEventListener("focusin", onFocusIn);
        document.addEventListener("focusout", onFocusOut);
        return () => {
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("focusout", onFocusOut);
        };
    }, []);

    const close = useCallback(() => {
        target?.blur();
        setTarget(null);
    }, [target]);

    const press = useCallback(
        (key: string) => {
            if (!target) return;
            const value = target.value ?? "";
            if (key === "back") {
                setNativeValue(target, value.slice(0, -1));
                return;
            }
            if (key === "clear") {
                setNativeValue(target, "");
                return;
            }
            if (key === "space") {
                setNativeValue(target, value + " ");
                return;
            }
            if (key === "enter") {
                // Let whatever the field is wired to (form submit, Save button
                // handlers) see a real Enter before the keyboard goes away.
                target.dispatchEvent(
                    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
                );
                target.form?.requestSubmit?.();
                close();
                return;
            }
            setNativeValue(target, value + (shift ? key.toUpperCase() : key));
        },
        [target, shift, close]
    );

    if (!target) return null;

    const layout: Layout = target instanceof HTMLInputElement && target.type === "number" ? "numeric" : "text";
    const rows = layout === "numeric" ? ROWS_NUMERIC : ROWS_TEXT;

    return (
        <div
            className={`osk osk-${layout}`}
            // Keep focus in the field: without this the browser blurs it the
            // moment a key is pressed and the typing goes nowhere.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
        >
            <div className="osk-rows">
                {rows.map((row, i) => (
                    <div className="osk-row" key={i}>
                        {row.map((k) => (
                            <button type="button" className="osk-key" key={k} onClick={() => press(k)}>
                                {shift ? k.toUpperCase() : k}
                            </button>
                        ))}
                    </div>
                ))}
                <div className="osk-row">
                    {layout === "text" && (
                        <button
                            type="button"
                            className={`osk-key osk-wide ${shift ? "osk-active" : ""}`}
                            onClick={() => setShift((s) => !s)}
                        >
                            Shift
                        </button>
                    )}
                    {layout === "text" && (
                        <button type="button" className="osk-key osk-space" onClick={() => press("space")}>
                            space
                        </button>
                    )}
                    <button type="button" className="osk-key osk-wide" onClick={() => press("back")}>
                        ⌫
                    </button>
                    <button type="button" className="osk-key osk-wide" onClick={() => press("clear")}>
                        Clear
                    </button>
                    <button type="button" className="osk-key osk-enter" onClick={() => press("enter")}>
                        Enter
                    </button>
                </div>
            </div>
        </div>
    );
}

export default OnScreenKeyboard;
