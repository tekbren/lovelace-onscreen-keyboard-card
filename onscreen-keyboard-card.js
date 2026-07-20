// Lovelace On-Screen Keyboard
// https://github.com/tekbren/lovelace-onscreen-keyboard-card
//
// A pure page-level on-screen keyboard for Home Assistant dashboards on
// touchscreen kiosks. No dependencies, no build step - a single JS file
// loaded as a dashboard resource.
//
// Unlike OS-level virtual keyboards (onboard, matchbox-keyboard, etc.),
// which depend on the browser exposing a full accessibility tree (constant
// per-frame rendering cost, and unreliable in practice across Chromium
// versions/kiosk setups), this works purely via standard DOM focus events
// and only does anything while a text field is actually focused.
//
// Install: add as a dashboard resource (HACS, or manually via
// Settings -> Dashboards -> Resources -> "/local/onscreen-keyboard-card.js",
// type: JavaScript Module). Nothing to configure - it activates automatically
// on any focusable <input>/<textarea> anywhere on the page, including inside
// other custom cards' shadow DOM.
(function () {
  "use strict";

  var KB_ID = "lovelace-osk";
  if (document.getElementById(KB_ID)) return; // guard against double-injection

  var activeEl = null;
  var hideTimer = null;
  var shift = false;
  var numericMode = false;

  var ALPHA_ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["⇧", "z", "x", "c", "v", "b", "n", "m", "⌫"],
    ["123", ",", "SPACE", ".", "⏎"]
  ];
  var NUMERIC_ROWS = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'],
    ["#", "+", "=", "?", "!", "'", "⌫"],
    ["ABC", ",", "SPACE", ".", "⏎"]
  ];

  // The real focused element, drilling through nested shadow roots -
  // document.activeElement only ever reports the outermost shadow host, so
  // for an <input> inside a custom card's shadow DOM we have to follow the
  // activeElement chain down to the leaf.
  function deepActiveElement() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  function isTextInput(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (tag !== "INPUT") return false;
    var t = (el.type || "text").toLowerCase();
    var bad = ["button", "checkbox", "radio", "range", "color", "hidden", "submit", "file", "image", "reset"];
    return bad.indexOf(t) === -1 && !el.disabled && !el.readOnly;
  }

  function cancelHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function fireInputEvent(el) {
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }

  function insertText(str) {
    if (!activeEl) return;
    var start = activeEl.selectionStart;
    var end = activeEl.selectionEnd;
    if (start == null) start = activeEl.value.length;
    if (end == null) end = activeEl.value.length;
    var val = activeEl.value || "";
    activeEl.value = val.slice(0, start) + str + val.slice(end);
    var pos = start + str.length;
    try { activeEl.setSelectionRange(pos, pos); } catch (e) { /* not all input types support this */ }
    fireInputEvent(activeEl);
  }

  function backspace() {
    if (!activeEl) return;
    var start = activeEl.selectionStart;
    var end = activeEl.selectionEnd;
    if (start == null) start = activeEl.value.length;
    if (end == null) end = activeEl.value.length;
    var val = activeEl.value || "";
    if (start === end && start > 0) {
      activeEl.value = val.slice(0, start - 1) + val.slice(end);
      start = start - 1;
    } else {
      activeEl.value = val.slice(0, start) + val.slice(end);
    }
    try { activeEl.setSelectionRange(start, start); } catch (e) { /* ignore */ }
    fireInputEvent(activeEl);
  }

  function pressEnter() {
    if (!activeEl) return;
    var opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true };
    activeEl.dispatchEvent(new KeyboardEvent("keydown", opts));
    activeEl.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function showKeyboard() {
    kb.classList.add("open");
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      setTimeout(function () {
        activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 50);
    }
  }

  function hideKeyboard() {
    kb.classList.remove("open");
  }

  function keyLabel(k) {
    if (k === "SPACE") return "";
    return shift && k.length === 1 && /[a-z]/.test(k) ? k.toUpperCase() : k;
  }

  function handleKey(k) {
    if (k === "⇧") { shift = !shift; render(); return; }
    if (k === "⌫") { backspace(); return; }
    if (k === "⏎") { pressEnter(); return; }
    if (k === "SPACE") { insertText(" "); return; }
    if (k === "123") { numericMode = true; render(); return; }
    if (k === "ABC") { numericMode = false; render(); return; }
    var ch = shift && /[a-z]/.test(k) ? k.toUpperCase() : k;
    insertText(ch);
    if (shift) { shift = false; render(); }
  }

  var style = document.createElement("style");
  style.textContent = [
    "#" + KB_ID + "{position:fixed;left:0;right:0;bottom:0;",
    "transform:translateY(100%);transition:transform .18s ease-out;",
    "background:#1b1b1f;border-top:1px solid #3a3a3f;z-index:2147483647;",
    "padding:8px 8px calc(8px + env(safe-area-inset-bottom,0px));",
    "box-shadow:0 -4px 16px rgba(0,0,0,.4);",
    // touch-action:none makes touch pointerdown events cancelable, so the
    // preventDefault() below actually keeps focus on the real input. Without
    // it, Chromium (kiosk) delivers a non-cancelable pointerdown, preventDefault
    // is ignored, focus jumps to the tapped key, the field blurs, and the
    // keyboard stops registering taps. -webkit-tap-highlight-color hides the
    // grey flash on tap. Set on every keyboard element (touch-action isn't
    // inherited, so the container alone isn't enough).
    "-webkit-tap-highlight-color:transparent;}",
    "#" + KB_ID + " *{touch-action:none;}",
    "#" + KB_ID + ".open{transform:translateY(0);}",
    "#" + KB_ID + " .kb-topbar{display:flex;justify-content:flex-end;padding:2px 4px 6px;}",
    "#" + KB_ID + " .kb-hide{color:#9aa0a6;font-size:22px;background:none;border:none;padding:4px 10px;}",
    "#" + KB_ID + " .kb-row{display:flex;gap:6px;margin-bottom:6px;justify-content:center;}",
    "#" + KB_ID + " button.kb-key{flex:1 1 0;min-width:0;height:74px;font-size:30px;",
    "background:#3a3a3f;color:#f1f1f1;border:none;border-radius:8px;",
    "font-family:inherit;-webkit-user-select:none;user-select:none;}",
    "#" + KB_ID + " button.kb-key:active{background:#54545b;}",
    "#" + KB_ID + " button.kb-key.wide{flex:1.6 1 0;font-size:24px;}",
    "#" + KB_ID + " button.kb-key.space{flex:6 1 0;}",
    "#" + KB_ID + " button.kb-key.accent{background:#565660;}"
  ].join("");
  document.head.appendChild(style);

  var kb = document.createElement("div");
  kb.id = KB_ID;
  var topbar = document.createElement("div");
  topbar.className = "kb-topbar";
  var hideBtn = document.createElement("button");
  hideBtn.className = "kb-hide";
  hideBtn.textContent = "⌄ Hide";
  topbar.appendChild(hideBtn);
  kb.appendChild(topbar);
  var rowsContainer = document.createElement("div");
  kb.appendChild(rowsContainer);
  document.body.appendChild(kb);

  function render() {
    rowsContainer.innerHTML = "";
    var rows = numericMode ? NUMERIC_ROWS : ALPHA_ROWS;
    rows.forEach(function (row) {
      var rowEl = document.createElement("div");
      rowEl.className = "kb-row";
      row.forEach(function (k) {
        var btn = document.createElement("button");
        btn.className = "kb-key";
        if (k === "SPACE") btn.className += " kb-key space";
        else if (["⇧", "⌫", "⏎", "123", "ABC"].indexOf(k) !== -1) btn.className += " kb-key wide accent";
        btn.textContent = keyLabel(k);
        rowEl.appendChild(btn);
      });
      rowsContainer.appendChild(rowEl);
    });
  }
  render();

  // Handle key presses on pointerdown, NOT click. Two reasons:
  //  1. To stop the keyboard from stealing focus off the real input, the key
  //     press has to preventDefault() the down-event. On a touchscreen, a
  //     touchstart preventDefault also suppresses the synthetic click that
  //     would otherwise follow - so a click-based handler simply never fires
  //     on touch (and the field blurs, hiding the keyboard until the next
  //     tap). Acting on pointerdown sidesteps that entirely.
  //  2. pointerdown unifies mouse + touch + stylus in one path, so the same
  //     code registers a physical finger tap and a mouse click identically.
  kb.addEventListener("pointerdown", function (e) {
    // Keep focus on the real input - this is what makes insertText target
    // the right field instead of the button we just pressed.
    e.preventDefault();

    var btn = e.target.closest("button.kb-key");
    if (btn) {
      var idx = Array.prototype.indexOf.call(btn.parentNode.children, btn);
      var rowIdx = Array.prototype.indexOf.call(rowsContainer.children, btn.parentNode);
      var rows = numericMode ? NUMERIC_ROWS : ALPHA_ROWS;
      handleKey(rows[rowIdx][idx]);
      return;
    }
    if (e.target.closest(".kb-hide")) {
      hideKeyboard();
      if (activeEl) activeEl.blur();
      activeEl = null;
    }
  });

  // focusin/focusout are composed events, so they bubble through shadow DOM
  // boundaries - e.composedPath()[0] gives the real originating element even
  // when it's deep inside another custom card's shadow root (e.target would
  // be retargeted to the shadow host instead, losing the actual input).
  document.addEventListener("focusin", function (e) {
    var el = e.composedPath()[0];
    if (isTextInput(el)) {
      cancelHide();
      activeEl = el;
      showKeyboard();
    }
  });

  document.addEventListener("focusout", function (e) {
    var el = e.composedPath()[0];
    if (el === activeEl) {
      hideTimer = setTimeout(function () {
        hideKeyboard();
        activeEl = null;
      }, 150);
    }
  });

  // Fallback for the "keyboard only appears on the second tap" case: some
  // web-component text fields don't emit a focusin we catch on the very
  // first tap (focus lands on a wrapper, or a card re-render swallows it).
  // On any tap that finishes with a text input actually focused, make sure
  // the keyboard is up. Runs after focusin, so it only ever corrects a miss.
  document.addEventListener("pointerup", function () {
    var el = deepActiveElement();
    if (isTextInput(el)) {
      cancelHide();
      activeEl = el;
      showKeyboard();
    }
  });
})();
