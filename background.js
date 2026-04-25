// background.js — ADSB Waypoints Extension
// Loads cifp.zip, parses all fixes/waypoints worldwide, serves them to the content script
// Uses IndexedDB to cache parsed data across service worker restarts (MV3)

importScripts("fflate.js", "sound_map.js");

// ─── State ────────────────────────────────────────────────────────────────────
let FIXES = [];          // [{ident, lat, lon, type, name, airport, procs}]
let FIX_PROCS = new Map(); // ident → [{proc, type:"SID"|"STAR", airport}]
let READY = false;
let LOADING = false;     // prevent double-loading

let MOAS = [];           // [{name, coords: [[[lon,lat]]], bbox: {minLat, maxLat, minLon, maxLon}}]
let MOAS_READY = false;
let MOAS_LOADING = false;

let FBOS = [];           // [{name, icao, lat, lon}]
let FBOS_READY = false;
let FBOS_LOADING = false;

const _routeCache = new Map(); // callsign → { ts, data } for adsbdb.com route lookups

// OurAirports name lookup (lazy-loaded)
let _ourAirportsMap = null;      // ICAO -> name, null = not loaded
let _ourAirportsList = null;     // [{icao, name, lat, lon, type, iata, city}] for nearby search
let _ourAirportsLoading = false;
let _ourAirportsWaiters = [];

function _parseOurAirportsCsv(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return { map: new Map(), list: [] };
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const iIdent = headers.indexOf('ident');
  const iGps   = headers.indexOf('gps_code');
  const iLocal = headers.indexOf('local_code');
  const iName  = headers.indexOf('name');
  const iLat   = headers.indexOf('latitude_deg');
  const iLon   = headers.indexOf('longitude_deg');
  const iType  = headers.indexOf('type');
  const iIata  = headers.indexOf('iata_code');
  const iCity  = headers.indexOf('municipality');
  const map = new Map();
  const list = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = [];
    let cur = '', inQ = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') { inQ = !inQ; }
      else if (line[c] === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += line[c];
    }
    cols.push(cur);
    const ident = (cols[iIdent] || '').trim().toUpperCase();
    const gps   = (cols[iGps]   || '').trim().toUpperCase();
    const local = (cols[iLocal] || '').trim().toUpperCase();
    const name  = (cols[iName]  || '').trim();
    if (!name) continue;
    if (ident) map.set(ident, name);
    if (gps && gps !== ident) map.set(gps, name);
    // Also index by FAA local_code (e.g. "1G0") — FlightAware URLs use these for smaller US airports
    if (local && local !== ident && local !== gps) map.set(local, name);
    // Build full list entry for nearby-airport lookups
    const lat = parseFloat(cols[iLat]);
    const lon = parseFloat(cols[iLon]);
    const aType = (cols[iType] || '').trim();
    if (!isNaN(lat) && !isNaN(lon) && (aType === 'large_airport' || aType === 'medium_airport' || aType === 'small_airport')) {
      const icao = gps || ident;
      if (icao) {
        list.push({
          icao: icao,
          name: name,
          lat: lat,
          lon: lon,
          type: aType,
          iata: (cols[iIata] || '').trim() || null,
          city: (cols[iCity] || '').trim() || null
        });
      }
    }
  }
  return { map, list };
}

async function ensureOurAirportsLoaded() {
  if (_ourAirportsMap) return;
  if (_ourAirportsLoading) return new Promise(res => _ourAirportsWaiters.push(res));
  _ourAirportsLoading = true;
  try {
    const resp = await fetch(chrome.runtime.getURL('airports.csv'));
    const text = await resp.text();
    const parsed = _parseOurAirportsCsv(text);
    _ourAirportsMap = parsed.map;
    _ourAirportsList = parsed.list;
  } catch(e) {
    _ourAirportsMap = new Map();
    _ourAirportsList = [];
  }
  _ourAirportsLoading = false;
  for (const r of _ourAirportsWaiters) r();
  _ourAirportsWaiters = [];
}

// ─── IndexedDB caching ────────────────────────────────────────────────────────
const DB_NAME = "AdsbWptCache";
const STORE_NAME = "fixes";
const MOAS_STORE = "moas";
const FBOS_STORE = "fbos";
const CACHE_VERSION = 21; // Bumped to force reload of cifp.zip with corrected + new waypoints from waypoints_clean.csv

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, CACHE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      if (db.objectStoreNames.contains(MOAS_STORE)) db.deleteObjectStore(MOAS_STORE);
      if (db.objectStoreNames.contains(FBOS_STORE)) db.deleteObjectStore(FBOS_STORE);
      db.createObjectStore(STORE_NAME);
      db.createObjectStore(MOAS_STORE);
      db.createObjectStore(FBOS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFixes(fixes) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(fixes, "allFixes");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadFixesFromCache() {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get("allFixes");
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch (_) {
    return null;
  }
}

async function saveMoas(moas) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOAS_STORE, "readwrite");
    const store = tx.objectStore(MOAS_STORE);
    store.put(moas, "allMoas");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadMoasFromCache() {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MOAS_STORE, "readonly");
      const store = tx.objectStore(MOAS_STORE);
      const req = store.get("allMoas");
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch (_) {
    return null;
  }
}

async function saveFbos(fbos) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FBOS_STORE, "readwrite");
    const store = tx.objectStore(FBOS_STORE);
    store.put(fbos, "allFbos");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadFbosFromCache() {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FBOS_STORE, "readonly");
      const store = tx.objectStore(FBOS_STORE);
      const req = store.get("allFbos");
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch (_) {
    return null;
  }
}

// ─── CIFP lat/lon parser (FAA Arinc-424 format) ───────────────────────────────
function parseCifpLatLon(str) {
  const latHem = str[0];
  const latDeg = parseInt(str.substring(1, 3));
  const latMin = parseInt(str.substring(3, 5));
  const latSec = parseInt(str.substring(5, 9)) / 100;

  const lonHem = str[9];
  const lonDeg = parseInt(str.substring(10, 13));
  const lonMin = parseInt(str.substring(13, 15));
  const lonSec = parseInt(str.substring(15, 19)) / 100;

  let lat = latDeg + latMin / 60 + latSec / 3600;
  let lon = lonDeg + lonMin / 60 + lonSec / 3600;

  if (latHem === "S") lat *= -1;
  if (lonHem === "W") lon *= -1;

  return { lat, lon };
}

// ─── Unzip helper (uses fflate) ───────────────────────────────────────────────
function unzipRawFiles(u8) {
  return fflate.unzipSync(u8);
}

// ─── Determine fix type from CIFP record prefix ──────────────────────────────
// Format: S + area(US/PA) + subarea(A/C) + section code at index 4
//   D = Navaid (VOR/NDB), E = Enroute waypoint, P = Airport,
//   U = Airway intersection, H = Heliport/runway
// For navaids (xD), VOR vs NDB is determined by navaid class at chars 27-31:
//   V=VOR, D=DME, T=TACAN → "vor";  H=NDB, M=MarineNDB without V/T → "ndb"
function lineType(line) {
  const sec = line[4]; // Section code: D, E, P, U, H, etc.

  if (sec === 'D') {
    // Navaid record — check navaid class field (chars 27-31) for VOR vs NDB
    const navClass = line.substring(27, 32);
    const hasVorIndicator = /[VDT]/.test(navClass);
    return hasVorIndicator ? "vor" : "ndb";
  }
  if (sec === 'E') return "fix";        // Enroute waypoint (5-letter ident)
  if (sec === 'U') return null;          // Airway fix / intersection — removed from project
  if (sec === 'P') return "airport";    // Airport procedure waypoint
  if (sec === 'H') return "airport";    // Heliport
  return "fix";
}

// ─── Main CIFP loader ─────────────────────────────────────────────────────────
async function loadCifp() {
  if (READY || LOADING) return;
  LOADING = true;

  try {
    // 1. Try loading from IndexedDB cache first (fast path for SW restarts)
    /* console.log("[WPT] Checking IndexedDB cache..."); */
    const cached = await loadFixesFromCache();
    if (cached && cached.length > 0) {
      FIXES = cached;
      READY = true;
      LOADING = false;
      /* console.log(`[WPT] Loaded ${FIXES.length} fixes from cache`); */
      return;
    }

    // 2. Parse from cifp.zip
    /* console.log("[WPT] No cache found, loading cifp.zip..."); */
    const url = chrome.runtime.getURL("cifp.zip");
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch failed: " + res.status);

    const buf = await res.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const files = unzipRawFiles(u8);

    // Find the CIFP file inside the zip (avoid PDFs/TXTs/XLSXs)
    const cifpName = Object.keys(files).find(k => 
      /FAACIFP/i.test(k) && !/\.(pdf|txt|xlsx|doc)$/i.test(k)
    );
    if (!cifpName) throw new Error("No CIFP file found in zip");

    const rawData = files[cifpName];
    const text = new TextDecoder("utf-8").decode(rawData);
    /* console.log("[WPT] CIFP loaded, length:", text.length); */

    parseCifp(text);

    // Also parse navaids.csv if present
    const navaidsName = Object.keys(files).find(k => /navaids\.csv/i.test(k));
    if (navaidsName) {
      const csv = new TextDecoder("utf-8").decode(files[navaidsName]);
      const lines = csv.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = lines[i].split(",");
        if (cols.length >= 5) {
          const ident = cols[0].trim().toUpperCase();
          const name = cols[1].trim().toUpperCase();
          let typeRaw = cols[2].trim().toUpperCase();
          const lat = parseFloat(cols[3]);
          const lon = parseFloat(cols[4]);
          
          let type = "ndb";
          if (typeRaw.includes("VOR") || typeRaw.includes("TACAN")) type = "vor";

          if (!isNaN(lat) && !isNaN(lon)) {
             FIXES.push({ ident, lat, lon, type, name });
          }
        }
      }
    }

    // Also parse waypoints.csv if present
    const waypointsName = Object.keys(files).find(k => /waypoints\.csv/i.test(k));
    if (waypointsName) {
      const csv = new TextDecoder("utf-8").decode(files[waypointsName]);
      const lines = csv.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        // Regex split handles commas inside quotes
        const split = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        if (split.length >= 5) {
           const ident = split[2].replace(/"/g, "").trim().toUpperCase();
           const latStr = split[3].replace(/"/g, "").trim();
           const lonStr = split[4].replace(/"/g, "").trim();
           
           const mLat = latStr.match(/(\d+)[^\d]+(\d+)[^\d]+([\d.]+)[^\dNSWE]*([NSWE])/i);
           const mLon = lonStr.match(/(\d+)[^\d]+(\d+)[^\d]+([\d.]+)[^\dNSWE]*([NSWE])/i);
           
           if (mLat && mLon) {
             let lat = parseFloat(mLat[1]) + parseFloat(mLat[2])/60 + parseFloat(mLat[3])/3600;
             if (mLat[4].toUpperCase() === 'S') lat = -lat;
             let lon = parseFloat(mLon[1]) + parseFloat(mLon[2])/60 + parseFloat(mLon[3])/3600;
             if (mLon[4].toUpperCase() === 'W') lon = -lon;
             
             FIXES.push({ ident, lat, lon, type: "fix" });
           }
        }
      }
    }

    // 3. Cache parsed fixes to IndexedDB
    /* console.log("[WPT] Saving to IndexedDB cache..."); */
    await saveFixes(FIXES);
    /* console.log("[WPT] Cache saved successfully"); */

  } catch (e) {
    /* console.error("[WPT] Failed to load CIFP:", e); */
  } finally {
    LOADING = false;
  }
}

function parseCifp(text) {
  const seen = new Set();       // exact dedup: ident + rounded coords
  const identCoords = new Map(); // ident → [{lat,lon}] for proximity dedup
  const lines = text.split(/\r?\n/);
  let count = 0;

  // First pass: build fix → procedure index from SID (D) and STAR (E) records
  FIX_PROCS.clear();
  for (const line of lines) {
    if (!line.startsWith("S")) continue;
    if (line[4] !== 'P') continue;
    // Position 12 holds procedure type: D = SID, E = STAR
    const procType = line[12];
    if (procType !== 'D' && procType !== 'E') continue;
    const typeLabel = procType === 'D' ? 'SID' : 'STAR';
    const airport = line.substring(6, 10).trim();
    const procCode = line.substring(13, 19).trim(); // e.g. "DIDLY5", "BEREE3"
    if (!procCode || procCode.length < 2) continue;
    const fixIdent = line.substring(29, 34).trim();
    if (!fixIdent || fixIdent.length < 2) continue;
    if (fixIdent.startsWith("RW")) continue;
    if (!/^[A-Z]{2,5}$/.test(fixIdent)) continue;  // letters only, no digits

    // Parse display name: "DIDLY5" → "DIDLY 5", "BEREE3" → "BEREE 3"
    const pm = procCode.match(/^([A-Z]+)(\d+)$/);
    const displayName = pm ? `${pm[1]} ${pm[2]}` : procCode;

    if (!FIX_PROCS.has(fixIdent)) FIX_PROCS.set(fixIdent, []);
    const arr = FIX_PROCS.get(fixIdent);
    // Avoid duplicates
    if (!arr.some(p => p.proc === displayName && p.type === typeLabel && p.airport === airport)) {
      arr.push({ proc: displayName, type: typeLabel, airport });
    }
  }
  /* console.log(`[WPT] Built procedure index: ${FIX_PROCS.size} fixes have SID/STAR info`); */

  for (const line of lines) {
    // Process all CIFP records (S prefix = standard record)
    if (!line.startsWith("S")) continue;

    const coordMatch = line.match(/[NS]\d{8}[EW]\d{9}/);
    if (!coordMatch) continue;

    // Extract fix ident from columns 13-18
    const ident = line.substring(13, 18).trim();

    if (!ident || ident.length < 2) continue;
    if (ident.startsWith("RW")) continue;    // skip runway designators
    if (!/^[A-Z]{2,5}$/.test(ident)) continue;  // letters only, no digits

    try {
      const { lat, lon } = parseCifpLatLon(coordMatch[0]);

      // Basic sanity check — skip obviously invalid coordinates
      if (lat < -90 || lat > 90) continue;
      if (lon < -180 || lon > 180) continue;

      let type = lineType(line);
      if (!type) continue;  // skip removed types (intersections)

      // Waypoints (fixes/airports) must have exactly 5-letter idents.
      // Shorter idents that aren't VORs or NDBs are procedure/approach fixes — skip them.
      if ((type === "fix" || type === "airport") && ident.length !== 5) continue;

      let name = undefined;
      let airport = undefined;

      if ((type === "vor" || type === "ndb") && line.length > 93) {
        name = line.substring(93, 123).trim();
      }

      // For P-section (airport procedure) records, cols 6-10 hold the airport ICAO
      if (line[4] === 'P' && line.length >= 10) {
        const icao = line.substring(6, 10).trim();
        if (icao && /^[A-Z0-9]{3,4}$/.test(icao)) airport = icao;
      }

      // Exact dedup: same ident + tightly rounded coords
      const dedupeKey = `${ident}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Proximity dedup: collapse identical idents that are close together
      // to prevent airway routes from becoming a solid line of redundant labels
      const existing = identCoords.get(ident);
      if (existing) {
        // Use a ~55km (0.5 degree) suppression radius for generic fixes
        // and a tighter ~5km (0.05 degree) radius for important distinct Navaids/Airports
        const threshold = type === "fix" ? 0.5 : 0.05;
        const isDup = existing.some(e =>
          Math.abs(e.lat - lat) < threshold && Math.abs(e.lon - lon) < threshold
        );
        if (isDup) continue;
        existing.push({ lat, lon });
      } else {
        identCoords.set(ident, [{ lat, lon }]);
      }

      // Attach procedure info if available
      const procs = FIX_PROCS.get(ident) || undefined;

      FIXES.push({ ident, lat, lon, type, name, airport, procs });
      count++;
    } catch (_) {}
  }

  READY = true;
  /* console.log(`[WPT] Parsed ${count} fixes/waypoints from CIFP`); */
}

// ─── Start loading immediately ────────────────────────────────────────────────
loadCifp();
loadMoasAndFbos();

// ─── MOA + FBO Loader ─────────────────────────────────────────────────────────
async function loadMoasAndFbos() {
  // Load MOAs
  if (!MOAS_READY && !MOAS_LOADING) {
    MOAS_LOADING = true;
    try {
      const cached = await loadMoasFromCache();
      if (cached && cached.length > 0) {
        MOAS = cached;
        MOAS_READY = true;
      } else {
        const url = chrome.runtime.getURL("moasfbos.zip");
        const res = await fetch(url);
        if (!res.ok) throw new Error("fetch failed: " + res.status);
        const buf = await res.arrayBuffer();
        const files = unzipRawFiles(new Uint8Array(buf));
        
        const jsonName = Object.keys(files).find(k => /moas\.json$/i.test(k));
        if (!jsonName) throw new Error("No moas.json found in moasfbos.zip");
        const text = new TextDecoder("utf-8").decode(files[jsonName]);
        const geojson = JSON.parse(text);

        for (const f of geojson.features || []) {
          const name = f.properties.NAME || "MOA";
          const coords = f.geometry.coordinates;
          let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
          const isMulti = f.geometry.type === 'MultiPolygon';
          const polys = isMulti ? coords : [coords];
          for (const poly of polys) {
            for (const ring of poly) {
              for (const [lon, lat] of ring) {
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
              }
            }
          }
          MOAS.push({ name, polys, bbox: { minLat, maxLat, minLon, maxLon } });
        }
        await saveMoas(MOAS);
        MOAS_READY = true;
      }
    } catch (e) {
    } finally {
      MOAS_LOADING = false;
    }
  }

  // Load FBOs
  if (!FBOS_READY && !FBOS_LOADING) {
    FBOS_LOADING = true;
    try {
      const cached = await loadFbosFromCache();
      if (cached && cached.length > 0) {
        FBOS = cached;
        FBOS_READY = true;
      } else {
        const url = chrome.runtime.getURL("moasfbos.zip");
        const res = await fetch(url);
        if (!res.ok) throw new Error("fetch failed: " + res.status);
        const buf = await res.arrayBuffer();
        const files = unzipRawFiles(new Uint8Array(buf));
        
        const jsonName = Object.keys(files).find(k => /fbos\.json$/i.test(k));
        if (!jsonName) throw new Error("No fbos.json found in moasfbos.zip");
        const text = new TextDecoder("utf-8").decode(files[jsonName]);
        FBOS = JSON.parse(text);
        await saveFbos(FBOS);
        FBOS_READY = true;
      }
    } catch (e) {
    } finally {
      FBOS_LOADING = false;
    }
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "INJECT_MAIN_SCRIPT") {
    if (sender.tab && sender.tab.id != null) {
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        files: ["content_main.js"],
        world: "MAIN"
      }).then(() => {
        /* console.log(`[WPT] Injected content_main.js into MAIN world on tab ${sender.tab.id}`); */
        sendResponse({ ok: true });
      }).catch(err => {
        /* console.error(`[WPT] Injection failed:`, err); */
        sendResponse({ ok: false, error: String(err) });
      });
      return true; // async response
    }
  }

  if (msg.type === "GET_SETTINGS") {
    chrome.storage.local.get(
      ["wpt_enabled", "wpt_showFixes", "wpt_showMoas", "wpt_showFbos", "wpt_opacity", "wpt_showBtn", "wpt_labelSize", "wpt_scaleDot", "wpt_hlProcs", "wpt_hidePopup", "wpt_fixColor", "wpt_textColor"],
      (data) => {
        sendResponse({
          enabled:       data.wpt_enabled       !== undefined ? data.wpt_enabled       : true,
          showFixes:     data.wpt_showFixes     !== undefined ? data.wpt_showFixes     : true,
          showMoas:      data.wpt_showMoas      !== undefined ? data.wpt_showMoas      : false,
          showFbos:      data.wpt_showFbos      !== undefined ? data.wpt_showFbos      : true,
          opacity:       data.wpt_opacity        !== undefined ? data.wpt_opacity       : 0.92,
          showBtn:       data.wpt_showBtn         !== undefined ? data.wpt_showBtn        : true,
          labelSize:     data.wpt_labelSize       !== undefined ? data.wpt_labelSize      : 1.0,
          scaleDot:      data.wpt_scaleDot        !== undefined ? data.wpt_scaleDot       : true,
          hlProcs:       data.wpt_hlProcs         !== undefined ? data.wpt_hlProcs        : true,
          hidePopup:     data.wpt_hidePopup       !== undefined ? data.wpt_hidePopup      : false,
          fixColor:      data.wpt_fixColor        !== undefined ? data.wpt_fixColor       : "#3fb950",
          textColor:     data.wpt_textColor       !== undefined ? data.wpt_textColor      : "#3fb950",
        });
      }
    );
    return true; // async response
  }

  if (msg.type === "SET_SETTINGS") {
    const updates = {};
    if (msg.settings.enabled !== undefined) updates.wpt_enabled = msg.settings.enabled;
    if (msg.settings.showMoas !== undefined) updates.wpt_showMoas = msg.settings.showMoas;
    if (msg.settings.showFbos !== undefined) updates.wpt_showFbos = msg.settings.showFbos;
    if (msg.settings.opacity !== undefined) updates.wpt_opacity = msg.settings.opacity;
    if (msg.settings.showBtn !== undefined) updates.wpt_showBtn = msg.settings.showBtn;
    if (msg.settings.labelSize !== undefined) updates.wpt_labelSize = msg.settings.labelSize;
    if (msg.settings.scaleDot !== undefined) updates.wpt_scaleDot = msg.settings.scaleDot;
    if (msg.settings.fixColor !== undefined) updates.wpt_fixColor = msg.settings.fixColor;
    if (msg.settings.textColor !== undefined) updates.wpt_textColor = msg.settings.textColor;
    chrome.storage.local.set(updates, () => sendResponse({ ok: true }));
    return true;
  }

  // ── Fuzzy search helpers (shared by SEARCH_AIRPORT & SEARCH_FIX) ──
  function phoneticNormalize(s) {
    if (!s) return "";
    s = s.toUpperCase().replace(/[^A-Z]/g, "");
    const rules = [
      [/PH/g,"F"], [/CK/g,"K"], [/Q/g,"K"], [/X/g,"KS"],
      [/Z/g,"S"], [/DG/g,"J"], [/GH/g,"G"], [/KN/g,"N"], [/WR/g,"R"],
      [/EE/g,"I"], [/EA/g,"I"], [/IE/g,"I"], [/EY/g,"I"], [/AY/g,"I"],
      [/OO/g,"U"], [/OU/g,"U"],
      [/ISN/g,"SN"], [/YSN/g,"SN"]
    ];
    for (const [r, rep] of rules) s = s.replace(r, rep);
    s = s.replace(/Y/g, "I");
    s = s.replace(/(.)\1+/g, "$1");
    if (s.length > 1) s = s[0] + s.slice(1).replace(/[AEIOU]/g, "");
    return s;
  }
  function fuzzy(str, pattern) {
    let i = 0;
    for (const c of str) { if (c === pattern[i]) i++; if (i === pattern.length) return true; }
    return false;
  }
  function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
        else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  }
  function consonantSkeleton(s) {
    if (!s) return "";
    return s.toUpperCase().replace(/[^A-Z]/g, "")
      .replace(/[AEIOU]/g, "").replace(/PH/g, "F")
      .replace(/CK/g, "K").replace(/Q/g, "K").replace(/Z/g, "S")
      .replace(/(.)\1+/g, "$1");
  }
  function soundScore(fix, query) {
    fix = String(fix || "").toUpperCase();
    query = String(query || "").toUpperCase();
    if (!fix || !query) return 0;
    const fixPh = phoneticNormalize(fix), qPh = phoneticNormalize(query);
    const fixSk = consonantSkeleton(fix), qSk = consonantSkeleton(query);
    let score = 0;
    score += Math.round(soundSimilarityScore(fix, query) * 3);
    if (fixPh === qPh) score += 200;
    if (fixSk === qSk && fixSk.length >= 2) score += 180;
    if (fixPh.includes(qPh) || qPh.includes(fixPh)) score += 120;
    if (fixSk.includes(qSk) || qSk.includes(fixSk)) score += 80;
    if (fix === query) score += 100;
    if (fix.startsWith(query)) score += 80;
    if (fix.includes(query)) score += 50;
    if (fuzzy(fix, query)) score += 40;
    const distPh = levenshtein(fixPh, qPh);
    score += Math.max(0, 40 - distPh * 6);
    const distRaw = levenshtein(fix, query);
    if (distRaw <= 3) score += [300, 200, 120, 60][distRaw];
    return score;
  }

  // ── Search by Airport ICAO ──────────────────────────────────────────────────
  if (msg.type === "SEARCH_AIRPORT") {
    if (!READY) { sendResponse({ fixes: [], count: 0 }); return; }
    const icao = (msg.icao || "").toUpperCase().trim();
    if (!icao) { sendResponse({ fixes: [], count: 0 }); return; }

    // Collect all fixes for this airport
    const airportFixes = FIXES.filter(f => f.airport === icao);

    const q = (msg.query || "").toUpperCase().trim();
    if (!q) {
      // No search query — return all fixes for this airport
      const result = airportFixes.slice(0, 100).map(f => ({
        ident: f.ident, lat: f.lat, lon: f.lon, type: f.type, name: f.name, procs: f.procs
      }));
      sendResponse({ fixes: result, count: airportFixes.length });
      return true;
    }

    // Score and sort airport fixes by fuzzy match
    const scored = [];
    for (const f of airportFixes) {
      let score = soundScore(f.ident, q);
      if (f.name) {
        const nameScore = soundScore(f.name.replace(/[^A-Z]/g, ""), q);
        score = Math.max(score, nameScore);
      }
      if (score > 0) scored.push({ fix: f, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const result = scored.slice(0, 50).map(s => ({
      ident: s.fix.ident, lat: s.fix.lat, lon: s.fix.lon,
      type: s.fix.type, name: s.fix.name, procs: s.fix.procs
    }));
    sendResponse({ fixes: result, count: airportFixes.length });
    return true;
  }
  if (msg.type === "OPEN_POPUP") {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().then(() => sendResponse({ ok: true })).catch(err => {
        /* console.error("[WPT] Could not open popup:", err); */
        sendResponse({ ok: false, error: String(err) });
      });
    } else {
      sendResponse({ ok: false, error: "openPopup not supported" });
    }
    return true;
  }

  if (msg.type === "GET_STATUS") {
    // If not ready, try loading (handles SW restart case)
    if (!READY && !LOADING) loadCifp();
    if (!MOAS_READY && !MOAS_LOADING) loadMoas();
    
    // Don't wait, just reply immediate status
    sendResponse({ ready: READY, count: FIXES.length, moasReady: MOAS_READY, fbosReady: FBOS_READY });
    return true;
  }

  // Content script asks for FBOs in a bounding box
  if (msg.type === "GET_FBOS_IN_BBOX") {
    const respond = () => {
      if (!FBOS_READY) { sendResponse({ fbos: [] }); return; }
      const { minLat, maxLat, minLon, maxLon } = msg;
      const result = FBOS.filter(f =>
        f.lat >= minLat && f.lat <= maxLat &&
        f.lon >= minLon && f.lon <= maxLon
      );
      sendResponse({ fbos: result });
    };
    if (!FBOS_READY && !FBOS_LOADING) {
      loadMoasAndFbos().then(respond);
    } else if (FBOS_LOADING) {
      const waitForReady = () => {
        if (FBOS_READY) { respond(); return; }
        setTimeout(waitForReady, 500);
      };
      waitForReady();
    } else {
      respond();
    }
    return true;
  }

  // Content script asks for fixes in a bounding box
  if (msg.type === "GET_FIXES_IN_BBOX") {
    const respond = () => {
      if (!READY) { sendResponse({ fixes: [] }); return; }
      const { minLat, maxLat, minLon, maxLon, types } = msg;
      const typeSet = new Set(types || ["fix", "vor", "ndb"]);
      const result = FIXES.filter(f =>
        f.lat >= minLat && f.lat <= maxLat &&
        f.lon >= minLon && f.lon <= maxLon &&
        typeSet.has(f.type)
      );
      // Deduplicate navaids (VOR/NDB) by name for map display
      const seenNavaidNames = new Set();
      const deduped = [];
      for (const f of result) {
        if ((f.type === "vor" || f.type === "ndb") && f.name) {
          if (seenNavaidNames.has(f.name)) continue;
          seenNavaidNames.add(f.name);
        }
        deduped.push(f);
      }
      sendResponse({ fixes: deduped });
    };

    if (!READY && !LOADING) {
      loadCifp().then(respond);
    } else if (LOADING) {
      // Wait for loading to finish
      const waitForReady = () => {
        if (READY) { respond(); return; }
        setTimeout(waitForReady, 500);
      };
      waitForReady();
    } else {
      respond();
    }
    return true;
  }

  // Content script asks for MOAs in a bounding box
  if (msg.type === "GET_MOAS_IN_BBOX") {
    const respond = () => {
      if (!MOAS_READY) { sendResponse({ moas: [] }); return; }
      const { minLat, maxLat, minLon, maxLon } = msg;
      
      const result = MOAS.filter(m => 
        // AABB Intersection check
        // MOA max must be >= BBOX min AND MOA min must be <= BBOX max
        m.bbox.maxLat >= minLat && m.bbox.minLat <= maxLat &&
        m.bbox.maxLon >= minLon && m.bbox.minLon <= maxLon
      );
      sendResponse({ moas: result });
    };

    if (!MOAS_READY && !MOAS_LOADING) {
      loadMoasAndFbos().then(respond);
    } else if (MOAS_LOADING) {
      const waitForReady = () => {
        if (MOAS_READY) { respond(); return; }
        setTimeout(waitForReady, 500);
      };
      waitForReady();
    } else {
      respond();
    }
    return true;
  }

  // Search for fixes by ident — fuzzy search algorithm
  if (msg.type === "SEARCH_FIX") {
    const respond = () => {
      if (!READY) { sendResponse({ fixes: [] }); return; }
      const q = (msg.query || "").trim().toUpperCase();
      if (!q) { sendResponse({ fixes: [] }); return; }

      // ── Score all fixes ──
      const bboxFilter = msg.bbox || null;
      const scored = [];

      for (const f of FIXES) {
        if (bboxFilter) {
          const { minLat, maxLat, minLon, maxLon } = bboxFilter;
          if (f.lat < minLat || f.lat > maxLat || f.lon < minLon || f.lon > maxLon) continue;
        }
        let score = soundScore(f.ident, q);
        if (f.name) {
          const nameScore = soundScore(f.name.replace(/[^A-Z]/g, ""), q);
          score = Math.max(score, nameScore);
          const nameUpper = f.name.toUpperCase();
          if (nameUpper.includes(q)) score = Math.max(score, 90);
        }
        if (score > 0) {
          scored.push({ fix: f, score });
        }
      }

      // Add MOAs to the search results
      if (MOAS_READY) {
        const seenMoaNames = new Set();
        for (const m of MOAS) {
          if (seenMoaNames.has(m.name)) continue;
          seenMoaNames.add(m.name);

          if (bboxFilter) {
            const { minLat, maxLat, minLon, maxLon } = bboxFilter;
            if (m.bbox.minLat > maxLat || m.bbox.maxLat < minLat || m.bbox.minLon > maxLon || m.bbox.maxLon < minLon) continue;
          }
          
          const cleanIdent = m.name.replace(/\s*MOA$/i, "").trim().toUpperCase();
          let score = soundScore(cleanIdent, q);
          
          // Massive score boosts for MOAs to overcome length penalties
          if (cleanIdent === q) score += 500; // Exact match: "BAGDAD" == "BAGDAD"
          else if (cleanIdent.startsWith(q + " ") || cleanIdent.startsWith(q)) score += 300; // Prefix match: "COUGAR HIGH" starts with "COUGAR"
          else if (cleanIdent.includes(q)) score += 150; // Inner match: "EAST COUGAR" includes "COUGAR"

          if (score > 0) {
            const centerLat = (m.bbox.minLat + m.bbox.maxLat) / 2;
            const centerLon = (m.bbox.minLon + m.bbox.maxLon) / 2;
            scored.push({
              fix: {
                ident: cleanIdent,
                name: m.name,
                type: "moa",
                lat: centerLat,
                lon: centerLon,
                procs: []
              },
              score
            });
          }
        }
      }

      // Add FBOs to the search results
      if (FBOS_READY) {
        for (const f of FBOS) {
          if (bboxFilter) {
            const { minLat, maxLat, minLon, maxLon } = bboxFilter;
            if (f.lat < minLat || f.lat > maxLat || f.lon < minLon || f.lon > maxLon) continue;
          }
          const nameUpper = f.name.toUpperCase();
          let score = soundScore(nameUpper, q);
          if (nameUpper === q) score += 500;
          else if (nameUpper.startsWith(q + " ") || nameUpper.startsWith(q)) score += 300;
          else if (nameUpper.includes(q)) score += 150;
          if (score > 0) {
            scored.push({
              fix: {
                ident: f.name,
                name: f.icao,
                type: "fbo",
                lat: f.lat,
                lon: f.lon,
                procs: []
              },
              score
            });
          }
        }
      }

      scored.sort((a, b) => b.score - a.score || a.fix.ident.localeCompare(b.fix.ident));
      const result = scored.slice(0, 30).map(s => s.fix);
      sendResponse({ fixes: result });
    };

    if (!READY && !LOADING) {
      loadCifp().then(respond);
    } else if (LOADING) {
      const waitForReady = () => {
        if (READY) { respond(); return; }
        setTimeout(waitForReady, 500);
      };
      waitForReady();
    } else {
      respond();
    }
    return true;
  }

  // ── Route Lookup via FlightAware history scraping ────────────────────────────
  if (msg.type === "LOOKUP_ROUTE") {
    const callsign = (msg.callsign || "").trim().toUpperCase();
    const reg = (msg.registration || "").trim().toUpperCase();
    if (!callsign && !reg) {
      sendResponse({ route: null });
      return true;
    }

    // Check in-memory cache (10-minute TTL)
    // Include gpsOrigin in the key so that different legs (same callsign, different physical origin)
    // get separate cache entries. This is essential for the hybrid ADS-B + FlightAware approach.
    const targetTime = msg.timestamp || Date.now();
    const gpsOrig = (msg.gpsOrigin || "").toUpperCase();
    const timeBucket = Math.round(targetTime / 600000); // 10-minute buckets
    const cacheKey = (callsign || reg) + ':' + timeBucket + ':' + gpsOrig;
    const cached = _routeCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < 600000)) {
      sendResponse({ route: cached.data });
      return true;
    }

    // THE SECRET LOGIC:
    // We MUST use the callsign as the primary lookup, NOT the registration!
    // A physical aircraft (registration) flies 5-8 times a day. 500 rows = ~2.5 months of history.
    // A commercial flight number (callsign) flies 1-2 times a day. 500 rows = ~8+ months of history!
    // Because we use exact timestamp matching, callsign is safe from multi-leg collisions,
    // and unlocks much deeper history for historical ADS-B playback.
    const histTarget = callsign || reg;
    const liveTarget = callsign || reg;
    // IMPORTANT: Append /500 to fetch extended history, and use credentials to utilize user's logged-in session
    const histUrl = `https://www.flightaware.com/live/flight/${encodeURIComponent(histTarget)}/history/500`;
    const liveUrl = `https://www.flightaware.com/live/flight/${encodeURIComponent(liveTarget)}`;

    const fetchOpts = { credentials: 'include' };

    Promise.allSettled([fetch(histUrl, fetchOpts).then(r => r.text()), fetch(liveUrl, fetchOpts).then(r => r.text())])
      .then(results => {
        const histHtml = results[0].status === "fulfilled" ? results[0].value : "";
        const liveHtml = results[1].status === "fulfilled" ? results[1].value : "";

        // Parse route candidates from history table rows
        // URL pattern: /history/{YYYYMMDD}/{HHmmZ}/{ORIG}/{DEST}
        // Note: targetTime is captured from the outer scope (already computed for cache key)
        let bestRoute = null;
        let bestDiff = Infinity;

        const htmlSources = [histHtml, liveHtml];
        let allRoutes = [];
        
        for (const html of htmlSources) {
          const regex = /href="[^"]*\/history\/(\d{8})\/(\d{4}Z)\/([A-Z0-9]{2,4})\/([A-Z0-9]{2,4})/gi;
          let match;
          while ((match = regex.exec(html)) !== null) {
            const d = match[1], t = match[2].replace(/Z$/i, ""), orig = match[3].toUpperCase(), dest = match[4].toUpperCase();
            const ts = Date.UTC(
              parseInt(d.slice(0, 4), 10),
              parseInt(d.slice(4, 6), 10) - 1,
              parseInt(d.slice(6, 8), 10),
              parseInt(t.slice(0, 2), 10),
              parseInt(t.slice(2, 4), 10)
            );
            allRoutes.push({ orig, dest, ts, dateStr: d, timeStr: t });
          }
        }

        // ── GPS-Origin Hybrid Filter ─────────────────────────────────────────
        // If gpsOrigin was provided (from ADS-B trail first point), ONLY consider
        // FlightAware routes that depart from that exact airport.
        // This is the killer feature: the trail physically starts at the real origin,
        // so we use it to instantly disambiguate multi-leg flights.
        const gpsOrigin = (msg.gpsOrigin || "").toUpperCase();
        let candidateRoutes;
        if (gpsOrigin) {
          // Filter to only flights departing from the GPS-detected origin
          candidateRoutes = allRoutes.filter(r => r.orig === gpsOrigin);
          // If no flights match the GPS origin (e.g., small uncharted airport), fall back to all routes
          if (candidateRoutes.length === 0) candidateRoutes = allRoutes;
        } else {
          candidateRoutes = allRoutes;
        }

        for (const route of candidateRoutes) {
          let diff;
          if (route.ts > targetTime) {
            const futureMs = route.ts - targetTime;
            if (futureMs > 3600000) {
              diff = futureMs + 21600000; 
            } else {
              diff = futureMs;
            }
          } else {
            diff = targetTime - route.ts;
          }
          
          if (diff <= bestDiff) {
            bestDiff = diff;
            bestRoute = { ...route, diff };
          }
        }

        // Also try to extract airline name from the live page
        let airlineName = null;
        const airlineMatch = liveHtml.match(/<title>\s*([^(]+?)\s*\(.*?FlightAware/i);
        if (airlineMatch) {
          // Title format: "Southwest Airlines Flight 693 (SWA693) - FlightAware"
          const titlePart = airlineMatch[1].trim();
          const flightWord = titlePart.indexOf(" Flight ");
          if (flightWord > 0) airlineName = titlePart.slice(0, flightWord).trim();
        }

        if (!bestRoute) {
          _routeCache.set(cacheKey, { ts: Date.now(), data: null });
          sendResponse({ route: null });
          return;
        }

        const route = {
          callsign: callsign || reg,
          callsignIata: null,
          airline: airlineName ? { name: airlineName, icao: null, iata: null, callsign: null } : null,
          origin: { icao: bestRoute.orig, iata: null, name: null, city: null },
          destination: { icao: bestRoute.dest, iata: null, name: null, city: null },
          flightDate: bestRoute.dateStr,
          flightTime: bestRoute.timeStr,
          timeDiff: bestRoute.diff
        };
        _routeCache.set(cacheKey, { ts: Date.now(), data: route });
        sendResponse({ route });
      })
      .catch(() => {
        _routeCache.set(cacheKey, { ts: Date.now() - 540000, data: null });
        sendResponse({ route: null });
      });
    return true; // async response
  }

  // ── Origin/Destination Detection from GPS Track ─────────────
  // Unlike FlightAware scraping (limited to 3 months), this derives origin and
  // destination directly from the first and last GPS points of the flight track
  // by finding the nearest airport in the CIFP FIXES dataset.
  // This works for ANY flight regardless of age — no FlightAware account needed.
  // GET_AIRPORT_NAME: resolve ICAO to full name via OurAirports
  if (msg.type === "GET_AIRPORT_NAME") {
    (async () => {
      await ensureOurAirportsLoaded();
      const ident = (msg.ident || '').trim().toUpperCase();
      const name = _ourAirportsMap.get(ident) || null;
      sendResponse({ name });
    })();
    return true;
  }

  // GET_NEARBY_AIRPORTS: find all airports within maxNm of the flight path
  if (msg.type === "GET_NEARBY_AIRPORTS") {
    (async () => {
      await ensureOurAirportsLoaded();
      const pts = msg.points;
      const maxNm = msg.maxNm || 150;
      if (!Array.isArray(pts) || pts.length < 1 || !_ourAirportsList) {
        sendResponse({ airports: [] });
        return;
      }

      function haversineNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

      // Cross-track distance from point to segment (same as tracker uses)
      function ptSegDistNm(aLat, aLon, bLat, bLon, pLat, pLon) {
        const dAP = haversineNm(aLat, aLon, pLat, pLon);
        const dAB = haversineNm(aLat, aLon, bLat, bLon);
        const dBP = haversineNm(bLat, bLon, pLat, pLon);
        if (dAB < 0.01) return dAP;
        // Project onto segment
        const t = Math.max(0, Math.min(1, ((dAP * dAP) - (dBP * dBP) + (dAB * dAB)) / (2 * dAB * dAB) ));
        // Interpolate
        const iLat = aLat + t * (bLat - aLat);
        const iLon = aLon + t * (bLon - aLon);
        return haversineNm(iLat, iLon, pLat, pLon);
      }

      // Quick bbox filter first
      const degPad = maxNm / 60;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const p of pts) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
      minLat -= degPad; maxLat += degPad;
      minLon -= degPad; maxLon += degPad;

      const results = [];
      const currentPt = pts[pts.length - 1]; // Plane's current location

      for (const apt of _ourAirportsList) {
        if (apt.lat < minLat || apt.lat > maxLat || apt.lon < minLon || apt.lon > maxLon) continue;
        
        // Strictly use distance from current plane position
        const currentDist = haversineNm(currentPt.lat, currentPt.lon, apt.lat, apt.lon);
        
        if (currentDist <= maxNm) {
          // If the plane is extremely close (visited), give it a slight artificial boost 
          // to ensure it stays absolute #1 even if another airport is technically slightly closer at the apron
          let sortDist = currentDist;
          if (currentDist < 2.0) sortDist -= 5.0; 

          results.push({ ...apt, distance: Math.round(currentDist * 10) / 10, sortDist });
        }
      }
      
      // Sort by current distance (closest first), placing newly visited/closer airports at the top
      results.sort((a, b) => a.sortDist - b.sortDist);
      sendResponse({ airports: results });
    })();
    return true;
  }

  if (msg.type === "DETECT_ORIGIN_DEST_FROM_TRACK") {
    const respond = () => {
      const pts = msg.points;
      if (!Array.isArray(pts) || pts.length < 2) {
        sendResponse({ origin: null, destination: null });
        return;
      }

      // Haversine distance in nautical miles
      function haversineNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065; // Earth radius in NM
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

      // Find nearest airport ICAO to a lat/lon point within maxNm nautical miles.
      // Uses the FIXES array which has type="airport" entries; each airport-type
      // fix carries the ICAO code in its `airport` field.
      function nearestAirportIcao(lat, lon, maxNm) {
        // Collect all unique airport ICAO positions from FIXES
        // (multiple procedure fixes share the same airport ICAO, pick closest)
        const seen = new Map(); // icao -> {lat, lon}
        for (const f of FIXES) {
          if (f.type === "airport" && f.airport && !seen.has(f.airport)) {
            seen.set(f.airport, { lat: f.lat, lon: f.lon });
          }
        }

        let best = null;
        let bestDist = Infinity;
        for (const [icao, pos] of seen) {
          const d = haversineNm(lat, lon, pos.lat, pos.lon);
          if (d < bestDist) {
            bestDist = d;
            best = icao;
          }
        }
        return (bestDist <= maxNm) ? best : null;
      }

      const first = pts[0];
      const last = pts[pts.length - 1];
      const MAX_NM = 25; // proximity threshold

      const originIcao = nearestAirportIcao(first.lat, first.lon, MAX_NM);
      const destIcao = nearestAirportIcao(last.lat, last.lon, MAX_NM);

      sendResponse({
        origin: originIcao ? { icao: originIcao, iata: null, name: null, city: null } : null,
        destination: destIcao ? { icao: destIcao, iata: null, name: null, city: null } : null
      });
    };

    // FIXES may still be loading — wait for them just like GET_FIXES_IN_BBOX does
    if (!READY && !LOADING) {
      loadCifp().then(respond);
    } else if (LOADING) {
      const wait = () => { if (READY) { respond(); return; } setTimeout(wait, 500); };
      wait();
    } else {
      respond();
    }
    return true;
  }

  // ── AirNav Airport Info Lookup ──────────────────────────────────────────────
  if (msg.action === "getAirportInfo") {
    const ident = (msg.ident || "").trim().toUpperCase();
    if (!ident) { sendResponse({ isFound: false }); return true; }
    
    // Check in-memory cache for airport info
    if (!_routeCache.has('airport_' + ident)) {
      const url = `https://www.airnav.com/airport/${ident}`;
      fetch(url).then(res => res.text()).then(html => {
        if (html.includes("not found") || html.includes("Unknown Airport")) {
          sendResponse({ isFound: false }); return;
        }
        const headerMatch = html.match(/size="\+1"><b>([\s\S]*?)<\/b><br>([\s\S]*?)<\/font>/i);
        if (headerMatch) {
          let name = headerMatch[1].replace(/<[^>]*>/g, '').trim();
          let location = headerMatch[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
          const data = { name, location, isFound: true };
          _routeCache.set('airport_' + ident, { ts: Date.now(), data });
          sendResponse(data);
        } else {
          const nameMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
          let name = nameMatch ? nameMatch[1].replace(/<[^>]*>/g, '').replace(/AirNav:/gi, '').trim() : "";
          const data = { name, location: "", isFound: !!name };
          _routeCache.set('airport_' + ident, { ts: Date.now(), data });
          sendResponse(data);
        }
      }).catch(() => sendResponse({ isFound: false }));
    } else {
      sendResponse(_routeCache.get('airport_' + ident).data);
    }
    return true; // async response
  }

  return false;
});

// ─── Keep-alive during initial load ───────────────────────────────────────────
// MV3 service workers can be terminated. Ping ourselves to stay alive during load.
let keepAliveInterval = null;
if (!READY) {
  keepAliveInterval = setInterval(() => {
    if (READY) {
      clearInterval(keepAliveInterval);
      return;
    }
    // chrome.runtime.getPlatformInfo keeps the SW alive
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}