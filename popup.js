const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const FEEDBACK_EMAIL = "utkarsh1486@gmail.com";

const SYSTEM_PROMPT = `
You are an image-reading compliance assistant. You will be shown a screenshot of an advertisement.
Your job has four steps.

STEP 1 — Is this an advertisement from the Government of India (a central ministry, department,
PSU, or an official campaign such as one hosted on mygov.in)? State this as "isGovtAd": true or
false. State-government and party-political ads that are NOT from a government body should be
marked false. If you are not reasonably confident it is an Indian government advertisement, mark
it false.

STEP 2 (only if isGovtAd is true) — Read all visible text in the image (OCR). Then check it
against this LIVE DIRECTORY of previously-seen government campaigns (JSON below — it grows over
time as more ads are analyzed). Decide ONE of two things:
  (a) It matches an existing entry (same underlying campaign, possibly a different creative/
      execution of it). If so, set "matchedKeyword" to that entry's exact "keyword" field value,
      copied verbatim, and use that entry's ministry/started/funding as ground truth.
  (b) It does not match anything in the directory. If so, set "matchedKeyword" to null, and set
      "suggestedKeyword" to a new short kebab-case slug for it (lowercase, hyphens, 3-6 words,
      must not collide with any existing keyword in the directory) so it can be added as a new
      entry. Infer ministry/started/goals/funding only from what is visibly stated in the ad —
      never invent details not shown.

LIVE DIRECTORY:
__CAMPAIGNS_JSON__

STEP 3 (only if isGovtAd is true) — Write a "summary" of at most 200 words, STRICTLY NEUTRAL AND
FACTUAL — state only what was started, which ministry/body it is from, what year, its stated
goal(s), and any funding information visible or matched. Do NOT use promotional adjectives from
the ad itself (e.g. "landmark", "historic", "tremendous", "proud") — report only what happened,
not how the ad frames it.

STEP 4 (only if isGovtAd is true) — Score compliance with the Supreme Court of India's CCRGA
guidelines (Common Cause vs. Union of India, 13 May 2015) using this STANDARDIZED rubric: five
fixed criteria, each scored independently from 0 to 20 (do not skip any, do not average — give
each its own integer). Return them as "scoreBreakdown", NOT as a single combined number — the
total is computed outside the model for consistency.
  - relevance (0-20): tied to constitutional/legal obligations or citizens' rights, not party identity
  - neutrality (0-20): avoids glorifying an individual political personality or the ruling party
  - accuracy (0-20): does not present pre-existing schemes as new; no misleading claims
  - attribution (0-20): clearly attributed to a specific government body, not a personal/political brand
  - costConsciousness (0-20): proportionate messaging, not primarily personality promotion
Also return a "violations" array: short, specific flags citing which criterion above was breached
and why. If a claimed violation would relate to a "National Advertising Policy" document, prefix
it with "[Not assessed — reference document not supplied]" rather than guessing at rules from a
document you have not been given.

Return ONLY valid JSON, no markdown fences, no prose outside the JSON, in exactly this shape:
{
  "isGovtAd": true,
  "extractedText": "<all OCR'd text from the image>",
  "matchedKeyword": "<exact existing keyword, or null>",
  "suggestedKeyword": "<new kebab-case slug, only if matchedKeyword is null, else null>",
  "ministry": "<ministry/body, or 'Unclear — not stated in ad'>",
  "started": "<timing, or 'Not stated in ad'>",
  "year": "<year, or 'Not stated in ad'>",
  "goals": "<1-2 sentence factual goal>",
  "funding": "<funding source, or 'Not stated in ad'>",
  "summary": "<neutral summary, max 200 words>",
  "scoreBreakdown": { "relevance": 0, "neutrality": 0, "accuracy": 0, "attribution": 0, "costConsciousness": 0 },
  "violations": ["<flag 1>", "<flag 2>"]
}
If isGovtAd is false, still return valid JSON with that field false and the others as empty
strings / null / empty array / zeroed breakdown — no need to fill them in.
`;

let currentImage = null; // { base64, mimeType }

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // data:mime;base64,xxxx
      const [, base64] = result.split(",");
      resolve({ base64, mimeType: file.type || "image/png", dataUrl: result });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showPreview(dataUrl) {
  const img = document.getElementById("preview");
  const text = document.getElementById("dropText");
  img.src = dataUrl;
  img.style.display = "block";
  text.style.display = "none";
}

function resetUI() {
  currentImage = null;
  document.getElementById("preview").style.display = "none";
  document.getElementById("dropText").style.display = "block";
  document.getElementById("result").style.display = "none";
  document.getElementById("result").innerHTML = "";
  document.getElementById("resetBtn").style.display = "none";
  setStatus("");
  chrome.storage.local.remove("pendingImage");
}

const DIRECTORY_KEY = "directory";

async function seedDirectoryIfNeeded() {
  const existing = await chrome.storage.local.get(DIRECTORY_KEY);
  if (existing[DIRECTORY_KEY] && existing[DIRECTORY_KEY].length) return;
  const res = await fetch(chrome.runtime.getURL("campaigns.json"));
  const data = await res.json();
  const seeded = data.campaigns.map(c => ({ ...c, creativesSeen: [] }));
  await chrome.storage.local.set({ [DIRECTORY_KEY]: seeded });
}

async function loadDirectory() {
  await seedDirectoryIfNeeded();
  const stored = await chrome.storage.local.get(DIRECTORY_KEY);
  return stored[DIRECTORY_KEY] || [];
}

async function saveDirectory(dir) {
  await chrome.storage.local.set({ [DIRECTORY_KEY]: dir });
}

// After a result comes back, either append this creative to the matched entry
// or create a brand-new directory entry from what the model inferred.
async function updateDirectory(result) {
  const dir = await loadDirectory();
  const creative = {
    extractedText: result.extractedText,
    summary: result.summary,
    total: totalScore(result.scoreBreakdown),
    analyzedAt: new Date().toISOString()
  };

  if (result.matchedKeyword) {
    const entry = dir.find(c => c.keyword === result.matchedKeyword);
    if (entry) {
      entry.creativesSeen = entry.creativesSeen || [];
      entry.creativesSeen.push(creative);
      await saveDirectory(dir);
      return { action: "appended", keyword: entry.keyword, count: entry.creativesSeen.length };
    }
  }

  // No match — create a new entry.
  let keyword = (result.suggestedKeyword || "unnamed-campaign").toLowerCase().replace(/[^a-z0-9-]/g, "");
  let candidate = keyword;
  let n = 2;
  while (dir.some(c => c.keyword === candidate)) {
    candidate = `${keyword}-${n++}`;
  }
  dir.push({
    keyword: candidate,
    url: "",
    when_it_was_started: result.started,
    ministry: result.ministry,
    year: result.year,
    goals: result.goals,
    funding_information: result.funding,
    summary: result.summary,
    creativesSeen: [creative]
  });
  await saveDirectory(dir);
  return { action: "created", keyword: candidate };
}

function totalScore(breakdown) {
  if (!breakdown) return 0;
  return (
    (breakdown.relevance || 0) +
    (breakdown.neutrality || 0) +
    (breakdown.accuracy || 0) +
    (breakdown.attribution || 0) +
    (breakdown.costConsciousness || 0)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGeminiOnce(prompt, base64, mimeType) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64 } }
          ]
        }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function callGemini(base64, mimeType) {
  const dir = await loadDirectory();
  const campaignsJson = JSON.stringify(dir.map(({ creativesSeen, ...rest }) => rest)); // keep prompt lean
  const prompt = SYSTEM_PROMPT.replace("__CAMPAIGNS_JSON__", campaignsJson);

  const maxAttempts = 4;
  const delays = [1000, 2000, 4000]; // backoff between attempts

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await callGeminiOnce(prompt, base64, mimeType);
    } catch (err) {
      const retryable = err.status === 503 || err.status === 429 || err.status === 500;
      const isLastAttempt = attempt === maxAttempts - 1;
      if (!retryable || isLastAttempt) throw err;
      setStatus(`Gemini is busy — retrying (${attempt + 1}/${maxAttempts - 1})...`);
      await sleep(delays[attempt]);
    }
  }
}

function scoreClass(score) {
  if (score >= 70) return "green";
  if (score >= 40) return "amber";
  return "red";
}

function renderNoMatch() {
  document.getElementById("result").innerHTML = `
    <div class="error-box">
      Sorry, this input does not match with our records for Indian government advertisements.
      Think there's a mistake? Email feedback to
      <a href="mailto:${FEEDBACK_EMAIL}">${FEEDBACK_EMAIL}</a>
    </div>`;
  document.getElementById("result").style.display = "block";
  document.getElementById("resetBtn").style.display = "block";
}

const CRITERIA_LABELS = {
  relevance: "Relevance",
  neutrality: "Neutrality",
  accuracy: "Accuracy",
  attribution: "Attribution",
  costConsciousness: "Cost-consciousness"
};

function renderResult(r, dirUpdate) {
  const total = totalScore(r.scoreBreakdown);
  const cls = scoreClass(total);
  const breakdownRows = Object.entries(r.scoreBreakdown || {})
    .map(([key, val]) => `
      <div class="crit-row">
        <span>${CRITERIA_LABELS[key] || key}</span>
        <span>${val}/20</span>
      </div>`)
    .join("");

  const dirNote =
    dirUpdate?.action === "created"
      ? `New directory entry created: <code>${dirUpdate.keyword}</code>`
      : dirUpdate?.action === "appended"
      ? `Added as creative #${dirUpdate.count} of existing entry <code>${dirUpdate.keyword}</code>`
      : "";

  document.getElementById("result").innerHTML = `
    <div class="score-row">
      <span class="score ${cls}">${total}</span>
      <span class="score-max">/ 100 — CCRGA Compliance</span>
    </div>
    <div class="crit-box">${breakdownRows}</div>
    <div class="summary-box">${r.summary}</div>
    <div class="field"><b>Ministry:</b> ${r.ministry}</div>
    <div class="field"><b>Started:</b> ${r.started} &nbsp;•&nbsp; <b>Year:</b> ${r.year}</div>
    <div class="field"><b>Goals:</b> ${r.goals}</div>
    <div class="field"><b>Funding:</b> ${r.funding}</div>
    ${
      r.violations && r.violations.length
        ? `<div class="field" style="margin-top:8px;"><b>Flags:</b></div>
           <ul class="violations">${r.violations.map(v => `<li>${v}</li>`).join("")}</ul>`
        : ""
    }
    ${dirNote ? `<div class="field" style="margin-top:8px; opacity:0.7;">${dirNote}</div>` : ""}
    <button class="reset" id="copyBtn" style="margin-top:10px;">📋 Copy report for Gem</button>
  `;
  document.getElementById("result").style.display = "block";
  document.getElementById("resetBtn").style.display = "block";

  document.getElementById("copyBtn").addEventListener("click", () => copyForGem(r, total));
}

function copyForGem(r, total) {
  const lines = [
    `CCRGA Compliance Report`,
    `Total score: ${total}/100`,
    ...Object.entries(r.scoreBreakdown || {}).map(
      ([key, val]) => `- ${CRITERIA_LABELS[key] || key}: ${val}/20`
    ),
    ``,
    `Ministry: ${r.ministry}`,
    `Started: ${r.started}`,
    `Year: ${r.year}`,
    `Goals: ${r.goals}`,
    `Funding: ${r.funding}`,
    ``,
    `Summary: ${r.summary}`,
    ``,
    `Flags:`,
    ...(r.violations && r.violations.length ? r.violations.map(v => `- ${v}`) : ["- None flagged"]),
    ``,
    `Extracted ad text: "${r.extractedText}"`
  ];
  navigator.clipboard.writeText(lines.join("\n"));
  const btn = document.getElementById("copyBtn");
  const original = btn.textContent;
  btn.textContent = "Copied! Paste into the Gem to discuss further.";
  setTimeout(() => (btn.textContent = original), 2000);
}

async function analyzeImage() {
  if (!currentImage) return;
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "PASTE_YOUR_KEY_HERE") {
    setStatus("No API key set — add yours to config.js.");
    return;
  }

  setStatus("Reading the ad and checking CCRGA compliance...");
  try {
    const result = await callGemini(currentImage.base64, currentImage.mimeType);
    if (!result.isGovtAd) {
      setStatus("");
      renderNoMatch();
    } else {
      setStatus("Updating directory...");
      const dirUpdate = await updateDirectory(result);
      setStatus("");
      renderResult(result, dirUpdate);
    }
  } catch (err) {
    console.error(err);
    if (err.status === 503 || err.status === 429) {
      setStatus("Gemini is still busy after retrying — wait a few seconds and try again.");
    } else {
      setStatus("Something went wrong: " + err.message);
    }
  }
}

async function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Please drop an image file.");
    return;
  }
  const { base64, mimeType, dataUrl } = await fileToBase64(file);
  currentImage = { base64, mimeType };
  showPreview(dataUrl);
  analyzeImage();
}

// --- wire up UI ---
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", e => handleFile(e.target.files[0]));

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

document.getElementById("resetBtn").addEventListener("click", resetUI);

document.getElementById("resetDirLink").addEventListener("click", async e => {
  e.preventDefault();
  if (!confirm("Wipe everything the tool has learned and reload the original demo directory?")) return;
  await chrome.storage.local.remove(DIRECTORY_KEY);
  await seedDirectoryIfNeeded();
  setStatus("Directory reset to shipped defaults.");
});

document.getElementById("activateBtn").addEventListener("click", async () => {
  setStatus("Activating on this tab...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setStatus("Couldn't find the active tab.");
      return;
    }

    async function sendActivate() {
      return chrome.tabs.sendMessage(tab.id, { type: "CCRGA_ACTIVATE" });
    }

    try {
      await sendActivate();
    } catch (e) {
      // Content script wasn't injected yet (e.g. page loaded before install) — inject it now.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await sendActivate();
    }

    // Close the popup so the user can click directly on the page.
    window.close();
  } catch (err) {
    console.error(err);
    setStatus("Couldn't activate on this page: " + err.message);
  }
});

// On open, check for an image captured via the right-click context menu.
chrome.storage.local.get("pendingImage", data => {
  if (data.pendingImage) {
    currentImage = { base64: data.pendingImage.base64, mimeType: data.pendingImage.mimeType };
    showPreview(data.pendingImage.dataUrl);
    analyzeImage();
    chrome.action.setBadgeText({ text: "" });
  }
});
