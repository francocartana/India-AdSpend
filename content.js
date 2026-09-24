(function () {
  if (window.__ccrgaContentLoaded) return; // avoid double-injection
  window.__ccrgaContentLoaded = true;

  let active = false;
  let toast = null;
  let hoverTarget = null;

  const style = document.createElement("style");
  style.textContent = `
    .ccrga-hover-outline {
      outline: 3px solid #e0762c !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }
    #ccrga-toast {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: #0b1636;
      color: #eef1f8;
      border: 2px solid #e0762c;
      border-radius: 12px;
      padding: 8px 16px;
      font: 13px -apple-system, sans-serif;
      z-index: 2147483647;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      pointer-events: none;
    }
  `;
  document.documentElement.appendChild(style);

  function findImage(el) {
    if (!el) return null;
    if (el.tagName === "IMG") return el;
    const closestImg = el.closest ? el.closest("img") : null;
    if (closestImg) return closestImg;
    // Fallback: some ad units use a CSS background-image on a div/a.
    const bg = window.getComputedStyle(el).backgroundImage;
    if (bg && bg.startsWith('url("') ) {
      return { __bgElement: el, src: bg.slice(5, -2) };
    }
    return null;
  }

  function onMouseOver(e) {
    const img = findImage(e.target);
    if (img) {
      hoverTarget = img.__bgElement || img;
      hoverTarget.classList.add("ccrga-hover-outline");
    }
  }
  function onMouseOut() {
    if (hoverTarget) {
      hoverTarget.classList.remove("ccrga-hover-outline");
      hoverTarget = null;
    }
  }

  function onClick(e) {
    const img = findImage(e.target);
    if (!img) return; // not an image, let the click pass through normally
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    chrome.runtime.sendMessage({ type: "CCRGA_IMAGE_CLICKED", src: img.src });
    deactivate();
  }

  function onKeydown(e) {
    if (e.key === "Escape") deactivate();
  }

  function activate() {
    if (active) return;
    active = true;
    document.body.style.cursor = "crosshair";
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeydown, true);

    toast = document.createElement("div");
    toast.id = "ccrga-toast";
    toast.textContent = "CCRGA Checker active — click any ad image to analyze it. Press Esc to cancel.";
    document.body.appendChild(toast);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    document.body.style.cursor = "";
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeydown, true);
    onMouseOut();
    if (toast) {
      toast.remove();
      toast = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "CCRGA_ACTIVATE") {
      activate();
      sendResponse({ ok: true });
    } else if (msg.type === "CCRGA_DEACTIVATE") {
      deactivate();
      sendResponse({ ok: true });
    } else if (msg.type === "CCRGA_PING") {
      sendResponse({ ok: true });
    }
    return true;
  });
})();
