// popup.js

const togEnabled = document.getElementById("togEnabled");
const togOpacity = document.getElementById("togOpacity");
const subToggles = document.getElementById("subToggles");
const togFixes   = document.getElementById("togFixes");
const togMoas    = document.getElementById("togMoas");
const togFbos    = document.getElementById("togFbos");
const togVfrs    = document.getElementById("togVfrs");
const searchBox  = document.getElementById("searchBox");
const searchResults = document.getElementById("searchResults");
const togShowBtn = document.getElementById("togShowBtn");
const togLabelSize = document.getElementById("togLabelSize");
const btnLabelDefault = document.getElementById("btnLabelDefault");
const togScaleDot = document.getElementById("togScaleDot");
const togFixColor = document.getElementById("togFixColor");
const btnFixColorDefault = document.getElementById("btnFixColorDefault");
const fixColorPreview = document.getElementById("fixColorPreview");
const togTextColor = document.getElementById("togTextColor");
const textColorPreview = document.getElementById("textColorPreview");
const togTextSameAsWpt = document.getElementById("togTextSameAsWpt");
const btnVisualSettings = document.getElementById("btnVisualSettings");
const visualSettingsModal = document.getElementById("visualSettingsModal");
const btnCloseVisual = document.getElementById("btnCloseVisual");
const togHidePopup = document.getElementById("togHidePopup");

// ── Hide/show quick-access button with popup lifecycle ──────────────────────
// Use a port — Chrome auto-disconnects when the popup closes for any reason
(async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      const port = chrome.tabs.connect(tabs[0].id, { name: "wpt_popup_alive" });
      // Errors on disconnect are expected; silently ignore
      port.onDisconnect.addListener(() => {});
    }
  } catch(_) {}
})();

// ── Visual Settings modal open/close ─────────────────────────────────────────
btnVisualSettings.addEventListener("click", () => {
  visualSettingsModal.style.display = "block";
});
btnCloseVisual.addEventListener("click", () => {
  visualSettingsModal.style.display = "none";
});
visualSettingsModal.addEventListener("click", (e) => {
  if (e.target === visualSettingsModal) visualSettingsModal.style.display = "none";
});
btnVisualSettings.addEventListener("mouseover", () => {
  btnVisualSettings.style.background = "#30363d";
});
btnVisualSettings.addEventListener("mouseout", () => {
  btnVisualSettings.style.background = "#21262d";
});
// ── Ensure content scripts are injected ──────────────────────────────────────
async function ensureContentScripts(tabId) {
  try {
    // Try sending a ping; if the bridge is alive it will respond
    await chrome.tabs.sendMessage(tabId, { __wpt_source: "popup", type: "WPT_PING" });
  } catch (_) {
    // Content script not present — inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content_bridge.js"]
      });
      // Give the bridge a moment to inject content_main.js
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      /* console.warn("[WPT] Cannot inject content script:", e); */
    }
  }
}

// ── Restore saved toggle states ───────────────────────────────────────────────
chrome.storage.local.get(["wpt_enabled", "wpt_showFixes", "wpt_showMoas", "wpt_showFbos", "wpt_showVfrs", "wpt_opacity", "wpt_showBtn", "wpt_labelSize", "wpt_scaleDot", "wpt_hlProcs", "wpt_hidePopup", "wpt_fixColor", "wpt_textColor", "wpt_textSameAsWpt"], (data) => {
  if (data.wpt_enabled !== undefined) {
    togEnabled.checked = data.wpt_enabled;
    updateSubTogglesVisuals(data.wpt_enabled);
  }
  if (data.wpt_showFixes !== undefined) togFixes.checked = data.wpt_showFixes;
  if (data.wpt_showMoas  !== undefined) togMoas.checked  = data.wpt_showMoas;
  if (data.wpt_showFbos  !== undefined) togFbos.checked  = data.wpt_showFbos;
  if (data.wpt_showVfrs  !== undefined) togVfrs.checked  = data.wpt_showVfrs;
  if (data.wpt_opacity   !== undefined) togOpacity.value = data.wpt_opacity;
  if (data.wpt_showBtn !== undefined) togShowBtn.checked = data.wpt_showBtn;
  if (data.wpt_labelSize !== undefined) togLabelSize.value = data.wpt_labelSize;
  if (data.wpt_scaleDot !== undefined) togScaleDot.checked = data.wpt_scaleDot;
  if (data.wpt_hlProcs  !== undefined) togHlProcs.checked = data.wpt_hlProcs;
  if (data.wpt_hidePopup !== undefined) togHidePopup.checked = data.wpt_hidePopup;
  if (data.wpt_fixColor !== undefined) {
    togFixColor.value = data.wpt_fixColor;
    fixColorPreview.style.background = data.wpt_fixColor;
  }
  if (data.wpt_textColor !== undefined) {
    togTextColor.value = data.wpt_textColor;
    textColorPreview.style.background = data.wpt_textColor;
  }
  if (data.wpt_textSameAsWpt !== undefined) {
    togTextSameAsWpt.checked = data.wpt_textSameAsWpt;
    togTextColor.disabled = data.wpt_textSameAsWpt;
    togTextColor.style.opacity = data.wpt_textSameAsWpt ? "0.4" : "1";
  }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local") {
    if (changes.wpt_enabled !== undefined) {
      togEnabled.checked = changes.wpt_enabled.newValue;
      updateSubTogglesVisuals(changes.wpt_enabled.newValue);
    }
    if (changes.wpt_opacity !== undefined) {
      togOpacity.value = changes.wpt_opacity.newValue;
    }
  }
});

function updateSubTogglesVisuals(isEnabled) {
  subToggles.style.opacity = isEnabled ? "1" : "0.4";
  subToggles.style.pointerEvents = isEnabled ? "auto" : "none";
}

// ── Toggle handlers ───────────────────────────────────────────────────────────
async function sendToggle(key, value) {
  chrome.storage.local.set({ [`wpt_${key}`]: value });
  // Send to content script via tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    await ensureContentScripts(tabs[0].id);
    chrome.tabs.sendMessage(tabs[0].id, {
      __wpt_source: "popup",
      type: "WPT_TOGGLE",
      key,
      value
    }).catch(() => {}); // Silently ignore if still can't connect
  } catch (e) {
    /* console.warn("[WPT] Toggle send error:", e); */
  }
}

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
  
  if (e.shiftKey && e.key.toLowerCase() === 's') {
    togEnabled.checked = !togEnabled.checked;
    togEnabled.dispatchEvent(new Event("change"));
  }
});

togEnabled.addEventListener("change", () => {
  sendToggle("enabled", togEnabled.checked);
  updateSubTogglesVisuals(togEnabled.checked);
});
togOpacity.addEventListener("input", () => sendToggle("opacity", parseFloat(togOpacity.value)));
togFixes.addEventListener("change", () => sendToggle("showFixes", togFixes.checked));
togMoas.addEventListener("change",  () => sendToggle("showMoas",  togMoas.checked));
togFbos.addEventListener("change",  () => sendToggle("showFbos",  togFbos.checked));
togVfrs.addEventListener("change",  () => sendToggle("showVfrs",  togVfrs.checked));
togShowBtn.addEventListener("change", () => sendToggle("showBtn", togShowBtn.checked));
togLabelSize.addEventListener("input", () => sendToggle("labelSize", parseFloat(togLabelSize.value)));
btnLabelDefault.addEventListener("click", () => {
  togLabelSize.value = 1.0;
  sendToggle("labelSize", 1.0);
});
togScaleDot.addEventListener("change", () => sendToggle("scaleDot", togScaleDot.checked));
togHlProcs.addEventListener("change", () => sendToggle("hlProcs", togHlProcs.checked));
togHidePopup.addEventListener("change", () => sendToggle("hidePopup", togHidePopup.checked));
togFixColor.addEventListener("input", () => {
  fixColorPreview.style.background = togFixColor.value;
  sendToggle("fixColor", togFixColor.value);
  // Sync text color if "same as waypoint" is checked
  if (togTextSameAsWpt.checked) {
    togTextColor.value = togFixColor.value;
    textColorPreview.style.background = togFixColor.value;
    sendToggle("textColor", togFixColor.value);
  }
});
btnFixColorDefault.addEventListener("click", () => {
  togFixColor.value = "#3fb950";
  fixColorPreview.style.background = "#3fb950";
  sendToggle("fixColor", "#3fb950");
  if (togTextSameAsWpt.checked) {
    togTextColor.value = "#3fb950";
    textColorPreview.style.background = "#3fb950";
    sendToggle("textColor", "#3fb950");
  }
});
togTextColor.addEventListener("input", () => {
  textColorPreview.style.background = togTextColor.value;
  sendToggle("textColor", togTextColor.value);
});
togTextSameAsWpt.addEventListener("change", () => {
  const checked = togTextSameAsWpt.checked;
  chrome.storage.local.set({ wpt_textSameAsWpt: checked });
  togTextColor.disabled = checked;
  togTextColor.style.opacity = checked ? "0.4" : "1";
  if (checked) {
    togTextColor.value = togFixColor.value;
    textColorPreview.style.background = togFixColor.value;
    sendToggle("textColor", togFixColor.value);
  }
});

// ── Area Selection ───────────────────────────────────────────────────────────
const btnSelectArea = document.getElementById("btnSelectArea");
btnSelectArea.addEventListener("click", async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    await ensureContentScripts(tabs[0].id);
    // Fire and forget — don't await since popup will close
    chrome.tabs.sendMessage(tabs[0].id, {
      __wpt_source: "popup",
      type: "WPT_START_SELECTION"
    });
    // Small delay to ensure message is dispatched before popup closes
    setTimeout(() => window.close(), 150);
  } catch (e) {
    /* console.error("[WPT] Failed to start area selection:", e); */
  }
});
btnSelectArea.addEventListener("mouseover", () => {
  btnSelectArea.style.borderColor = "#58a6ff";
});
btnSelectArea.addEventListener("mouseout", () => {
  btnSelectArea.style.borderColor = "#30363d";
});

// ── Search Mode (3-way: all / view / airport) ────────────────────────────────
const searchSectionTitle = document.getElementById("searchSectionTitle");
const targetWaypoints = document.getElementById("targetWaypoints");
const targetAirports = document.getElementById("targetAirports");
const modeAll = document.getElementById("modeAll");
const modeView = document.getElementById("modeView");
const modeAirport = document.getElementById("modeAirport");
const icaoRow = document.getElementById("icaoRow");
const icaoInput = document.getElementById("icaoInput");
const icaoStatus = document.getElementById("icaoStatus");
const modeBtns = [modeAll, modeView, modeAirport];

let searchMode = "all"; // "all" | "view" | "airport"
let searchTarget = "waypoints"; // "waypoints" | "airports"
let airportIcao = "";   // current ICAO for airport mode
let airportFixCount = 0;

const MODE_COLORS = { all: "#3fb950", view: "#58a6ff", airport: "#f07178" };

function setSearchTarget(target) {
  searchTarget = target === "airports" ? "airports" : "waypoints";

  const searchingAirports = searchTarget === "airports";
  searchSectionTitle.textContent = searchingAirports ? "Search Airport" : "Search Waypoint";
  targetWaypoints.style.background = searchingAirports ? "transparent" : "#f0f6fc";
  targetWaypoints.style.color = searchingAirports ? "#8b949e" : "#0d1117";
  targetAirports.style.background = searchingAirports ? "#f0f6fc" : "transparent";
  targetAirports.style.color = searchingAirports ? "#0d1117" : "#8b949e";

  modeAirport.style.display = searchingAirports ? "none" : "";
  if (searchingAirports && searchMode === "airport") setSearchMode("all");
  else setSearchMode(searchMode);
  searchBox.placeholder = searchingAirports ? "Type airport code or name" : "Type fix ident";
}

function setSearchMode(mode) {
  searchMode = mode;
  chrome.storage.local.set({ wpt_searchMode: mode });
  modeBtns.forEach(btn => {
    btn.style.background = "transparent";
    btn.style.color = "#8b949e";
  });
  const activeBtn = mode === "all" ? modeAll : mode === "view" ? modeView : modeAirport;
  activeBtn.style.background = MODE_COLORS[mode];
  activeBtn.style.color = "#0d1117";

  // Clear previous search when switching modes
  searchBox.value = "";
  searchResults.innerHTML = "";
  document.body.classList.remove("searching");
  chrome.storage.local.set({ wpt_lastSearch: "" });

  // Show/hide ICAO input
  icaoRow.style.display = mode === "airport" ? "block" : "none";

  // Show/hide search box: in airport mode, only show if valid ICAO loaded
  if (mode === "airport") {
    const hasValid = airportIcao && airportFixCount > 0;
    searchBox.style.display = hasValid ? "" : "none";
    searchBox.placeholder = hasValid ? `Search in ${airportIcao}` : "";
    if (airportIcao) loadAirportFixes();
  } else {
    searchBox.style.display = "";
    searchBox.placeholder = searchTarget === "airports" ? "Type airport code or name" : "Type fix ident";
  }
}

targetWaypoints.addEventListener("click", () => setSearchTarget("waypoints"));
targetAirports.addEventListener("click", () => setSearchTarget("airports"));
modeAll.addEventListener("click", () => setSearchMode("all"));
modeView.addEventListener("click", () => setSearchMode("view"));
modeAirport.addEventListener("click", () => setSearchMode("airport"));

// ── ICAO input handling ──────────────────────────────────────────────────────
let _icaoTimer = null;
icaoInput.addEventListener("input", () => {
  clearTimeout(_icaoTimer);
  const icao = icaoInput.value.trim().toUpperCase();
  chrome.storage.local.set({ wpt_airportIcao: icao });
  if (icao.length >= 3) {
    _icaoTimer = setTimeout(() => {
      airportIcao = icao;
      loadAirportFixes();
    }, 300);
  } else {
    icaoStatus.textContent = "";
    searchResults.innerHTML = "";
    airportIcao = "";
    airportFixCount = 0;
    searchBox.style.display = "none";
  }
});

async function loadAirportFixes() {
  icaoStatus.textContent = "Loading…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "SEARCH_AIRPORT", icao: airportIcao });
    airportFixCount = res.count || 0;
    if (airportFixCount === 0) {
      icaoStatus.textContent = "No waypoints found for this ICAO";
      searchResults.innerHTML = "";
      searchBox.style.display = "none";
    } else {
      icaoStatus.textContent = `${airportFixCount} waypoints found`;
      searchBox.style.display = "";
      searchBox.placeholder = `Search in ${airportIcao}`;
      // Show all if no search query
      const q = searchBox.value.trim();
      if (!q) {
        const fixes = res.fixes || [];
        document.body.classList.add("searching");
        renderResults(fixes);
      }
    }
  } catch (e) {
    icaoStatus.textContent = "Error loading airport data";
  }
}

// ── Restore search mode ──────────────────────────────────────────────────────
chrome.storage.local.get(["wpt_searchMode", "wpt_airportIcao", "wpt_lastSearch"], (data) => {
  if (data.wpt_airportIcao) {
    airportIcao = data.wpt_airportIcao;
    icaoInput.value = airportIcao;
  }
  searchMode = data.wpt_searchMode || "all";
  setSearchTarget("waypoints");
  const lastQ = data.wpt_lastSearch || "";
  if (lastQ) {
    searchBox.value = lastQ;
    document.body.classList.add("searching");
    doSearch(lastQ);
  }
});

// ── Helper: get current map bbox from content script ─────────────────────────
async function getMapBbox() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return null;
    await ensureContentScripts(tabs[0].id);
    const res = await chrome.tabs.sendMessage(tabs[0].id, {
      __wpt_source: "popup",
      type: "WPT_GET_BBOX"
    });
    return res && res.bbox ? res.bbox : null;
  } catch (e) {
    return null;
  }
}


let _searchTimer = null;

searchBox.addEventListener("input", () => {
  clearTimeout(_searchTimer);
  const q = searchBox.value.trim();
  // Persist search query so it survives popup close/reopen
  chrome.storage.local.set({ wpt_lastSearch: q });
  if (!q) {
    searchResults.innerHTML = "";
    document.body.classList.remove("searching");
    // In airport mode with ICAO set, show all fixes again
    if (searchMode === "airport" && airportIcao) loadAirportFixes();
    return;
  }
  document.body.classList.add("searching");
  _searchTimer = setTimeout(() => doSearch(q), 250);
});

async function doSearch(q) {
  searchResults.innerHTML = `<div class="no-results">Searching…</div>`;
  try {
    let fixes = [];

    if (searchTarget === "airports") {
      const searchMsg = { type: "SEARCH_AIRPORTS", query: q };
      if (searchMode === "view") {
        const bbox = await getMapBbox();
        if (bbox) searchMsg.bbox = bbox;
      }
      const res = await chrome.runtime.sendMessage(searchMsg);
      fixes = res.airports || [];
    } else if (searchMode === "airport") {
      // Search within airport fixes
      if (!airportIcao) {
        searchResults.innerHTML = `<div class="no-results">Enter an ICAO code first</div>`;
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: "SEARCH_AIRPORT", icao: airportIcao, query: q.toUpperCase()
      });
      fixes = res.fixes || [];
    } else {
      // All Available or Current View
      const searchMsg = { type: "SEARCH_FIX", query: q.toUpperCase() };
      if (searchMode === "view") {
        const bbox = await getMapBbox();
        if (bbox) searchMsg.bbox = bbox;
      }
      const res = await chrome.runtime.sendMessage(searchMsg);
      fixes = res.fixes || [];
    }

    renderResults(fixes);
  } catch (e) {
    searchResults.innerHTML = `<div class="no-results">Error searching</div>`;
  }
}

function getRootProcs(fix) {
  if (!fix || !fix.procs || !fix.procs.length) return [];
  const seen = new Set();
  return fix.procs.filter(p => {
    if (!p.proc) return false;
    if (!p.csvProc) {
      if (!p.proc.startsWith(fix.ident)) return false;
      const num = p.proc.substring(fix.ident.length).trim();
      if (num.length === 0 || !/\d/.test(num)) return false;
    }
    const key = `${p.type || ""}|${p.proc}`.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getProcTypeLabel(rootProcs) {
  const hasSid = rootProcs.some(p => p.type === 'SID');
  const hasStar = rootProcs.some(p => p.type === 'STAR');
  return hasSid && hasStar ? 'SID/STAR' : hasSid ? 'SID' : 'STAR';
}

function shouldCollapseProcSearchLabel(rootProcs) {
  return rootProcs.length > 1 || rootProcs.some(p => p.csvProc);
}

function getProcCopyText(fix) {
  const rootProcs = getRootProcs(fix);
  if (!rootProcs.length) return null;
  if (fix.type !== "fix") return null;
  const p = rootProcs[0];
  if (p.csvProc) {
    return fix.name ? fix.name.toUpperCase() : fix.ident.toUpperCase();
  }
  const num = p.proc.replace(fix.ident, '').trim();
  const map = {'0':'ZERO','1':'ONE','2':'TWO','3':'THREE','4':'FOUR','5':'FIVE','6':'SIX','7':'SEVEN','8':'EIGHT','9':'NINE'};
  const numWords = num.split('').map(c => map[c] || c).join('');
  const displayName = fix.name ? fix.name.toUpperCase() : fix.ident.toUpperCase();
  return `${displayName} ${numWords}`;
}

function nearbyAirportStyle(airport) {
  if (!airport || !airport.airportType) return null;
  if (airport.airportType === "heliport") {
    return airport.isHospital
      ? { identColor: "#ff7b72", typeColor: "#ff7b72", label: "HSP" }
      : { identColor: "#a5d6ff", typeColor: "#58a6ff", label: "HPD" };
  }
  if (airport.airportType === "large_airport") {
    return { identColor: "#FED8B1", typeColor: "#58a6ff", label: "LRG" };
  }
  if (airport.airportType === "medium_airport") {
    return { identColor: "#FED8B1", typeColor: "#3fb950", label: "MED" };
  }
  return { identColor: "#FED8B1", typeColor: "#8b949e", label: "SML" };
}

function renderResults(fixes) {
  if (!fixes.length) {
    searchResults.innerHTML = `<div class="no-results">No results found</div>`;
    return;
  }

  const hlProcs = togHlProcs.checked;
  const fixColor = togFixColor.value;

  searchResults.innerHTML = fixes.map(f => {
    const airportStyle = nearbyAirportStyle(f);
    let color = airportStyle ? airportStyle.identColor : f.type === "vfr" ? "#9966CC" : f.type === "vor" ? "#58a6ff" : f.type === "ndb" ? "#f85149" : f.type === "moa" ? "rgba(230, 130, 255, 0.9)" : f.type === "fbo" ? "#DFFF00" : f.type === "airport" ? fixColor : fixColor;
    let isMythic = false;
    let pLabel = f.ident;
    let pMeta = "";

    const rootProcs = getRootProcs(f);

    if (hlProcs && rootProcs.length > 0 && f.type === "fix") {
      const hasSid = rootProcs.some(p => p.type === 'SID');
      color = hasSid ? "#ff9e22" : "#00cfcf";
      isMythic = true;
    }

    if (rootProcs.length > 0 && f.type === "fix") {
      const p = rootProcs[0];
      const typeText = shouldCollapseProcSearchLabel(rootProcs) ? getProcTypeLabel(rootProcs) : p.type;
      if (shouldCollapseProcSearchLabel(rootProcs)) {
        pLabel = f.ident;
      } else {
        const num = p.proc.replace(f.ident, '').trim();
        pLabel = `${f.ident} ${num}`;
      }
      pMeta = `<span style="font-size: 10px; margin-left: 4px; color: ${isMythic ? color : '#8b949e'}">- ${typeText}</span>`;
    }

    if (f.type === "fbo") pLabel = pLabel.toUpperCase();

    const nameStr = (f.name && f.type !== "fbo") ? ` <span style="color:#8b949e;font-weight:normal">(${f.name})</span>` : "";
    const airportStr = f.airport ? airportStyle
      ? `<span style="color:#8b949e;font-size:10px;margin-left:5px;">(${f.airport})</span>`
      : `<span style="color:#3fb950;font-size:10px;margin-left:5px;background:#0d2b12;border-radius:3px;padding:1px 4px;">${f.airport}</span>` : "";
    
    const procCopyText = getProcCopyText(f);
    let defaultCopy = (f.ident || "").toUpperCase();
    if (f.type === "fbo") {
      defaultCopy = f.ident.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substring(1).toLowerCase());
    } else if (f.type === "moa") {
      defaultCopy = f.name ? f.name.replace(/\s*MOA$/i, "").replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim().toLowerCase() : f.ident;
    } else if (f.type === "vfr") {
      defaultCopy = f.name ? f.name.toUpperCase() : f.ident.toUpperCase();
    } else if (f.type === "airport") {
      defaultCopy = f.ident.toUpperCase();
    } else if (f.name) {
      defaultCopy = f.name.toUpperCase();
    }
    const copyVal = procCopyText ? procCopyText : defaultCopy;

    return `
    <div class="result-item" data-lat="${f.lat}" data-lon="${f.lon}" data-ident="${f.ident}" data-copy="${copyVal ? copyVal.replace(/"/g, '&quot;') : f.ident}">
      <div>
        <div class="result-ident" style="color:${color}">${pLabel}${pMeta}${nameStr}${airportStr}</div>
        <div class="result-coords">${f.lat.toFixed(4)}° / ${f.lon.toFixed(4)}°</div>
      </div>
      <span class="result-type"${airportStyle ? ` style="color:${airportStyle.typeColor};border:1px solid ${airportStyle.typeColor}44;"` : ""}>${airportStyle ? airportStyle.label : typeLabel(f.type)}</span>
    </div>
  `}).join("");

  searchResults.querySelectorAll(".result-item").forEach((el, index) => {
    const result = fixes[index];
    el.addEventListener("click", async () => {
      const lat = parseFloat(el.dataset.lat);
      const lon = parseFloat(el.dataset.lon);
      const ident = el.dataset.ident;
      const copyTxt = el.dataset.copy;
      
      if (copyTxt) {
        try { await navigator.clipboard.writeText(copyTxt); } catch(e) {}
      }

      // Pan the map to this fix
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) return;
        await ensureContentScripts(tabs[0].id);
        chrome.tabs.sendMessage(tabs[0].id, {
          __wpt_source: "popup",
          type: "WPT_FLY_TO",
          lat, lon, ident,
          zoom: 12
        }).catch(() => {});
      } catch (e) {
        /* console.warn("[WPT] FlyTo error:", e); */
      }
      window.close();
    });

    // Highlight waypoint on map when hovering search result
    el.addEventListener("mouseenter", async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          __wpt_source: "popup",
          type: "WPT_HIGHLIGHT",
          ident: el.dataset.ident,
          airport: result && result.airportType ? {
            icao: result.ident,
            name: result.name,
            lat: result.lat,
            lon: result.lon,
            type: result.airportType,
            isHospital: !!result.isHospital
          } : null
        }).catch(() => {});
      } catch (e) {}
    });
    el.addEventListener("mouseleave", async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          __wpt_source: "popup",
          type: "WPT_HIGHLIGHT",
          ident: null
        }).catch(() => {});
      } catch (e) {}
    });
  });
}

function typeColor(t) {
  return t === "vfr" ? "#9966CC" : t === "vor" ? "#58a6ff" : t === "ndb" ? "#f85149" : t === "moa" ? "rgba(230, 130, 255, 0.9)" : t === "fbo" ? "#F5F5DC" : t === "airport" ? "#3fb950" : "#3fb950";
}

function typeLabel(t) {
  return t === "vfr" ? "VFR" : t === "vor" ? "VOR" : t === "ndb" ? "NDB" : t === "moa" ? "MOA" : t === "fbo" ? "FBO" : t === "airport" ? "APT" : "FIX";
}
