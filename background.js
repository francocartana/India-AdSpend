chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ccrga-check",
    title: "Check this ad with CCRGA Checker",
    contexts: ["image"]
  });
});

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function captureImageToStorage(srcUrl) {
  const res = await fetch(srcUrl);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const mimeType = blob.type || "image/png";

  await chrome.storage.local.set({
    pendingImage: { dataUrl: `data:${mimeType};base64,${base64}`, mimeType, base64 }
  });

  if (chrome.action.openPopup) {
    try {
      await chrome.action.openPopup();
      return;
    } catch (e) {
      // fall through to badge
    }
  }
  chrome.action.setBadgeText({ text: "1" });
  chrome.action.setBadgeBackgroundColor({ color: "#e0762c" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CCRGA_IMAGE_CLICKED" && msg.src) {
    captureImageToStorage(msg.src).catch(err =>
      console.error("CCRGA Checker: could not fetch clicked image.", err)
    );
  }
  return false;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "ccrga-check" || !info.srcUrl) return;
  try {
    await captureImageToStorage(info.srcUrl);
  } catch (err) {
    console.error("CCRGA Checker: could not fetch right-clicked image.", err);
  }
});
