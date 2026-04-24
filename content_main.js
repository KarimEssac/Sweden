// content_main.js
// Injected into globe.adsbexchange.com page world (MAIN world).
// Draws waypoint markers on a canvas overlay synced to the OpenLayers map.

(function () {
  if (window.__adsbWptMainInstalled) return;
  window.__adsbWptMainInstalled = true;

  // ── Logging (console only) ─────────────────────────────────────────────────
  console.log("%cSweden Injected", "color: #00ff00; font-weight: bold; font-size: 14px;");
  function logMsg(msg, isErr = false) {
    // Suppressed per user request
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  const Settings = {
    showFixes: true,
    showMoas:  false,
    showFbos:  true,
    enabled:   true,
    opacity:   0.92,
    showBtn:   true,
    labelSize: 1.0,
    scaleDot:  true,
    hlProcs:   true,
    hidePopup: false,
    fixColor:  "#3fb950",
    textColor: "#3fb950",
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let allFixes = [];
  let allMoas = [];
  let allFbos = [];
  let activeHitboxes = [];
  let canvas = null;
  let ctx = null;
  let tooltip = null;
  let lastBbox = null;
  let loadTimer = null;
  let _highlightIdent = null;  // ident string to glow on map (set by popup hover)

  // ── Bridge: page <-> extension content script ─────────────────────────────
  let _reqId = 0;
  const _pending = new Map();

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.__wpt_source !== "bridge") return;
    const msg = event.data;

    if (msg.type === "WPT_TOGGLE") {
      Settings[msg.key] = msg.value;
      // Hide quick-access button when popup/overlay/panel is active
      if (msg.key === "__hideQAB") {
        const btn = document.getElementById("wpt-quick-access-btn");
        if (btn) {
          // Only restore if user has showBtn enabled
          if (msg.value) btn.style.display = "none";
          else btn.style.display = Settings.showBtn === false ? "none" : "flex";
        }
        return;
      }
      // Handle quick-access button visibility
      if (msg.key === "showBtn") {
        const btn = document.getElementById("wpt-quick-access-btn");
        if (btn) btn.style.display = msg.value ? "flex" : "none";
        return;
      }
      // Label size only affects rendering, no data reload needed
      if (msg.key === "labelSize" || msg.key === "scaleDot" || msg.key === "fixColor" || msg.key === "textColor" || msg.key === "hlProcs" || msg.key === "hidePopup") return;
      lastBbox = null;  // Force re-fetch with new type filters
      loadFixesForView();
      return;
    }
    if (msg.type === "WPT_FLY_TO") {
      flyToFix(msg.lat, msg.lon, msg.zoom);
      return;
    }
    if (msg.type === "WPT_GET_BBOX") {
      const bbox = getMapBounds();
      window.postMessage({
        __wpt_source: "page",
        __wpt_bbox_reply_id: msg.__wpt_bbox_reply_id,
        bbox: bbox
      }, "*");
      return;
    }
    if (msg.type === "WPT_START_SELECTION") {
      startAreaSelection();
      return;
    }
    if (msg.type === "WPT_HIGHLIGHT") {
      _highlightIdent = msg.ident || null;
      return;
    }

    const id = msg.__wpt_req_id;
    if (id !== undefined && _pending.has(id)) {
      const { resolve, reject } = _pending.get(id);
      _pending.delete(id);
      msg.error ? reject(new Error(msg.error)) : resolve(msg);
    }
  });

  window.addEventListener("keydown", (e) => {
    // Only trigger if not typing in an input
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    
    if (e.shiftKey && e.key.toLowerCase() === 's') {
      Settings.enabled = !Settings.enabled;
      // Notify background to save the new setting
      bgRequest({ type: "SET_SETTINGS", settings: { enabled: Settings.enabled } }).catch(() => {});
      
      // Update the page map
      lastBbox = null;
      loadFixesForView();
    }
  });

  function bgRequest(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = _reqId++;
      _pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); reject(new Error("bgReq timeout: " + payload.type)); }
      }, timeoutMs || 5000);
      window.postMessage({ __wpt_source: "page", __wpt_req_id: id, ...payload }, "*");
    });
  }

  // ── Tracker Math ──────────────────────────────────────────────────────────
  function toRad(v) { return v * Math.PI / 180; }
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth radius in NM
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function pointToSegmentDistance(lat1, lon1, lat2, lon2, lat3, lon3) {
    const L2 = (lat2 - lat1) ** 2 + (lon2 - lon1) ** 2;
    if (L2 === 0) return haversineDistance(lat1, lon1, lat3, lon3);
    const t = Math.max(0, Math.min(1, ((lat3 - lat1) * (lat2 - lat1) + (lon3 - lon1) * (lon2 - lon1)) / L2));
    return haversineDistance(lat3, lon3, lat1 + t * (lat2 - lat1), lon1 + t * (lon2 - lon1));
  }

  // ── OpenLayers helpers ────────────────────────────────────────────────────
  function getOLMap() {
    // ADS-B Exchange (tar1090) exposes the map as window.OLMap
    if (window.OLMap && typeof window.OLMap.getView === "function") {
      return window.OLMap;
    }
    return null;
  }

  function getZoom() {
    const map = getOLMap();
    if (!map) return 0;
    try {
      return map.getView().getZoom() || 0;
    } catch (_) { return 0; }
  }

  function latLonToPixel(lat, lon) {
    const map = getOLMap();
    if (!map || !window.ol) return null;
    try {
      const coord = ol.proj.fromLonLat([lon, lat]);
      const pixel = map.getPixelFromCoordinate(coord);
      if (!pixel) return null;
      // OL returns CSS pixels; we need to match our canvas which uses device pixels
      const dpr = window.devicePixelRatio || 1;
      return { x: pixel[0] * dpr, y: pixel[1] * dpr };
    } catch (_) { return null; }
  }

  function getMapBounds() {
    const map = getOLMap();
    if (!map || !window.ol) return null;
    try {
      const size = map.getSize();
      if (!size) return null;
      const extent = map.getView().calculateExtent(size);
      
      // Calculate min/max lat/lon individually in case transformExtent is stripped from their OL build
      const minPt = ol.proj.toLonLat([extent[0], extent[1]]);
      const maxPt = ol.proj.toLonLat([extent[2], extent[3]]);
      
      const latPad = (maxPt[1] - minPt[1]) * 0.15;
      const lonPad = (maxPt[0] - minPt[0]) * 0.15;
      return {
        minLat: minPt[1] - latPad,
        maxLat: maxPt[1] + latPad,
        minLon: minPt[0] - lonPad,
        maxLon: maxPt[0] + lonPad,
      };
    } catch (e) { 
      logMsg("[WPT] getMapBounds error: " + String(e), true);
      return null; 
    }
  }

  // ── Find overlay container ────────────────────────────────────────────────
  function findMapViewport() {
    // tar1090 uses #map_canvas as the target element; OL creates .ol-viewport inside
    return document.querySelector(".ol-viewport") ||
           document.querySelector("#map_canvas");
  }

  // ── Create overlay canvas ─────────────────────────────────────────────────
  function createCanvas() {
    if (canvas) return;
    const container = findMapViewport();
    if (!container) { logMsg("[WPT] No OL viewport found", true); return; }

    canvas = document.createElement("canvas");
    canvas.id = "wpt-overlay-canvas";
    // Removing z-index completely. By appending to baseLayer without a z-index,
    // it will naturally render above the base map's canvas (due to DOM order)
    // but strictly beneath any subsequent OpenLayers layers (like flights) 
    // because it shares the base map's stacking context.
    canvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
    `;
    ctx = canvas.getContext("2d");

    // OpenLayers strictly manages its container and creates separate stacking contexts for each map layer.
    // To cleanly sit between the map and the airplanes without being deleted by OpenLayers' renderer,
    // we inject our canvas directly into the *first* layer container (the base map).
    // This way, we render above the base map tile canvas, but strictly below the airplane vector layers.
    setInterval(() => {
      if (!canvas) return;
      const layersContainer = container.querySelector('.ol-layers');
      if (layersContainer && layersContainer.children.length > 0) {
        // children[0] is usually the base map .ol-layer
        const baseLayer = layersContainer.children[0];
        if (canvas.parentElement !== baseLayer) {
          baseLayer.appendChild(canvas);
        }
      } else {
        // Fallback if structure is unexpected
        const uiContainer = container.querySelector('.ol-overlaycontainer');
        if (uiContainer && canvas.parentElement !== container) {
          container.insertBefore(canvas, uiContainer);
        }
      }
    }, 500);

    function syncSize() {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width  = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    syncSize();
    new ResizeObserver(syncSize).observe(container);

    // Tooltip detection — listen on the container without blocking map interactions
    container.addEventListener("mousemove", onMouseMove, { passive: true });

    // Track mousedown position so we can distinguish clicks from drags
    container.addEventListener("pointerdown", (e) => {
      _downX = e.clientX;
      _downY = e.clientY;
    }, { capture: true });

    // Intercept clicks at the DOCUMENT level (capture phase) so we fire BEFORE
    // OpenLayers' handlers on the viewport. This prevents OL from seeing our
    // waypoint clicks, keeping tracked flights selected.
    document.addEventListener("click", onClick, { capture: true });

    logMsg("[WPT] Overlay canvas ready: " + canvas.width + "x" + canvas.height);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  const DEFAULT_FIX_COLOR = "#3fb950";
  function getColorMap() {
    return { airport: Settings.fixColor, fix: Settings.fixColor, vor: "#58a6ff", ndb: "#f85149", fbo: "#DFFF00" };
  }
  function getRootProcs(fix) {
    if (!fix || !fix.procs || !fix.procs.length) return [];
    return fix.procs.filter(p => {
      if (!p.proc.startsWith(fix.ident)) return false;
      const num = p.proc.substring(fix.ident.length).trim();
      return num.length > 0 && /\d/.test(num);
    });
  }

  function getProcCopyText(fix) {
    const rootProcs = getRootProcs(fix);
    if (!rootProcs.length) return null;
    const p = rootProcs[0];
    const num = p.proc.replace(fix.ident, '').trim();
    const map = {'0':'ZERO','1':'ONE','2':'TWO','3':'THREE','4':'FOUR','5':'FIVE','6':'SIX','7':'SEVEN','8':'EIGHT','9':'NINE'};
    const numWords = num.split('').map(c => map[c] || c).join('');
    const displayName = fix.name ? fix.name.toUpperCase() : fix.ident.toUpperCase();
    return `${displayName} ${numWords} ${p.type === 'SID' ? 'DEPARTURE' : 'ARRIVAL'}`;
  }
  // If a hex color is too dark, return white for readability on dark tooltips
  function readableColor(hex) {
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.4 ? "#ffffff" : hex;
  }
  function isDarkColor(hex) {
    const c = hex.replace("#", "");
    if(c.length !== 6) return false;
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.15;
  }

  function drawShape(type, x, y, r) {
    if (type === "vor") {
      // Hexagon
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        i === 0 ? ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a))
                : ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
      }
      ctx.closePath();
    } else if (type === "ndb") {
      // Diamond
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.8, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.8, y);
      ctx.closePath();
    } else {
      // Circle for fixes, intersects, and airports
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function drawFrame() {
    if (!canvas || !ctx) return;

    // Sync canvas size each frame
    const container = canvas.parentElement;
    if (container) {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    activeHitboxes = [];
    if (!Settings.enabled) return;

    const zoom = getZoom();
    if (zoom < 6) return;

    const dpr = window.devicePixelRatio || 1;
    const COLOR = getColorMap();
    const showLabels = zoom >= 10;
    
    // Scale radius down when zoomed out. Max size reached at zoom >= 10.5.
    let baseRadius = 5; // default max radius
    if (zoom >= 10.5) baseRadius = 5;
    else if (zoom >= 9.5) baseRadius = 4;
    else if (zoom >= 8.5) baseRadius = 3;
    else if (zoom >= 7.5) baseRadius = 2;
    else baseRadius = 1.5;
    
    const r = baseRadius * dpr * (Settings.scaleDot ? Settings.labelSize : 1);

    let drawn = 0;
    try {
      // Visually deduplicate points that map to the exact same screen location
      const drawnPixels = new Set();
      
      // Also deduplicate identical labels that are too close on screen (e.g. airway lines)
      const drawnLocationsByIdent = new Map(); // ident -> [{x, y}]

      // Draw MOAs first so they are beneath waypoints
      if (Settings.showMoas) {
        ctx.save();
        ctx.globalAlpha = Settings.opacity;

        for (const moa of allMoas) {
          const isHighlighted = _highlightIdent && (moa.name === _highlightIdent || moa.name.replace(/\s*MOA$/i, "").trim().toUpperCase() === _highlightIdent.toUpperCase());
          // Draw filled polygon
          ctx.beginPath();
          if (isHighlighted) {
            ctx.shadowColor = "#ffffff";
            ctx.shadowBlur = Math.round(15 + 10 * Math.sin(Date.now() / 150)) * dpr;
            ctx.fillStyle = "rgba(220, 90, 255, 0.3)";  // Brighter Fill
            ctx.strokeStyle = "rgba(220, 90, 255, 1.0)"; // Brighter Stroke
          } else {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.fillStyle = "rgba(220, 90, 255, 0.1)";  // Purple/Pink Fill
            ctx.strokeStyle = "rgba(220, 90, 255, 0.6)"; // Purple/Pink Stroke
          }
          ctx.lineWidth = 1.5 * dpr;
          ctx.setLineDash([8 * dpr, 6 * dpr]);
          // No shadow — prevents bright orange blowout on zoom

          // Compute centroid using the signed-area method for accurate center
          let centroidLat = 0, centroidLon = 0, totalArea = 0;

          for (const poly of moa.polys) {
            for (const ring of poly) {
              if (!ring.length) continue;
              const start = latLonToPixel(ring[0][1], ring[0][0]);
              if (!start) continue;
              ctx.moveTo(start.x, start.y);

              for (let i = 1; i < ring.length; i++) {
                const pt = latLonToPixel(ring[i][1], ring[i][0]);
                if (pt) ctx.lineTo(pt.x, pt.y);
              }
              ctx.closePath();

              // Signed-area centroid computation (geographic coords)
              let a = 0, cx = 0, cy = 0;
              for (let i = 0; i < ring.length; i++) {
                const j = (i + 1) % ring.length;
                const cross = ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
                a += cross;
                cx += (ring[i][0] + ring[j][0]) * cross;
                cy += (ring[i][1] + ring[j][1]) * cross;
              }
              a /= 2;
              if (Math.abs(a) > 1e-10) {
                cx /= (6 * a);
                cy /= (6 * a);
                centroidLon += cx * Math.abs(a);
                centroidLat += cy * Math.abs(a);
                totalArea += Math.abs(a);
              }
            }
          }
          ctx.fill();
          ctx.stroke();

          // Label at centroid
          if (showLabels && totalArea > 0) {
            centroidLon /= totalArea;
            centroidLat /= totalArea;
            const cp = latLonToPixel(centroidLat, centroidLon);
            if (cp) {
              ctx.setLineDash([]);
              const fs = (zoom >= 11 ? 12 : 11) * dpr * Settings.labelSize;
              ctx.font = `bold ${fs}px sans-serif`;
              ctx.fillStyle = "rgba(230, 130, 255, 0.9)"; // Purple/Pink Text
              ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
              ctx.lineWidth = 3 * dpr;
              const textWidth = ctx.measureText(moa.name).width;
              ctx.strokeText(moa.name, cp.x - textWidth / 2, cp.y);
              ctx.fillText(moa.name, cp.x - textWidth / 2, cp.y);
            }
          }
        }
        ctx.restore();
      }

      // Draw FBO markers
      if (Settings.showFbos && allFbos.length) {
        const fboColor = "#DFFF00";
        const fs = (zoom >= 11 ? 11 : 10) * dpr * Settings.labelSize;
        for (const fbo of allFbos) {
          const p = latLonToPixel(fbo.lat, fbo.lon);
          if (!p) continue;
          const isHighlighted = _highlightIdent && fbo.name.toUpperCase() === _highlightIdent.toUpperCase();

          // White dot — same radius as standard waypoints
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = isHighlighted ? "#ffffff" : fboColor;
          ctx.globalAlpha = Settings.opacity;
          if (isHighlighted) {
            ctx.shadowColor = "#ffffff";
            ctx.shadowBlur = Math.round(15 + 10 * Math.sin(Date.now() / 150)) * dpr;
          } else {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
          }
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.75)";
          ctx.lineWidth = 1 * dpr;
          ctx.stroke();

          if (isHighlighted) {
            const time = Date.now();
            const duration = 1200;
            const p1 = (time % duration) / duration; 
            const p2 = ((time + (duration/2)) % duration) / duration; 

            ctx.shadowBlur = 0; 
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + (25 * dpr * p1), 0, Math.PI * 2);
            ctx.strokeStyle = fboColor;
            ctx.lineWidth = 2 * dpr;
            ctx.globalAlpha = 1 - p1;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(p.x, p.y, r + (25 * dpr * p2), 0, Math.PI * 2);
            ctx.globalAlpha = 1 - p2;
            ctx.stroke();

            // Animated crosshairs
            ctx.beginPath();
            const crossSize = 12 * dpr;
            ctx.moveTo(p.x - crossSize, p.y);
            ctx.lineTo(p.x + crossSize, p.y);
            ctx.moveTo(p.x, p.y - crossSize);
            ctx.lineTo(p.x, p.y + crossSize);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5 * dpr;
            ctx.globalAlpha = 0.4 + 0.4 * Math.sin(time / 200);
            ctx.stroke();

            ctx.globalAlpha = Settings.opacity; // restore
          }

          // Label — same zoom threshold as waypoints (showLabels = zoom >= 10)
          let fboLabelHit = null;
          if (showLabels) {
            ctx.font = `bold ${fs}px sans-serif`;
            ctx.fillStyle = fboColor;
            ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
            ctx.lineWidth = 3 * dpr;
            const labelText = fbo.name.toUpperCase();
            const tx = p.x + r + 3 * dpr;
            const ty = p.y + 4 * dpr;
            ctx.strokeText(labelText, tx, ty);
            ctx.fillText(labelText, tx, ty);

            const w = ctx.measureText(labelText).width;
            fboLabelHit = {
              x1: tx,
              y1: ty - fs * 0.8,
              x2: tx + w + 4 * dpr,
              y2: ty + fs * 0.3
            };
          }

          // Push hitbox for hover/click on both dot and label
          activeHitboxes.push({
            fix: { ident: fbo.name, name: fbo.icao, type: "fbo", lat: fbo.lat, lon: fbo.lon, procs: [] },
            dotHit: { x: p.x, y: p.y, r: r + 6 * dpr },
            labelHit: fboLabelHit
          });
        }
      }
      
      // Draw standard waypoints
      for (const fix of allFixes) {
        if (!Settings.showFixes) continue;

        const pt = latLonToPixel(fix.lat, fix.lon);
        if (!pt) continue;
        const { x, y } = pt;
        if (x < -30 || x > canvas.width + 30 || y < -30 || y > canvas.height + 30) continue;

        // Dedup by rounding to nearest 2 pixels (for entirely overlapping points)
        const pxKey = `${Math.round(x/2)},${Math.round(y/2)}`;
        if (drawnPixels.has(pxKey)) continue;
        
        // Dedup identical ident names within ~40 pixels visually
        const existing = drawnLocationsByIdent.get(fix.ident);
        if (existing) {
          const isCrowded = existing.some(pt => Math.hypot(pt.x - x, pt.y - y) < 40 * dpr);
          if (isCrowded) continue;
          existing.push({x, y});
        } else {
          drawnLocationsByIdent.set(fix.ident, [{x, y}]);
        }
        
        drawnPixels.add(pxKey);

        let color = COLOR[fix.type] || Settings.fixColor;
        let isMythic = false;

        const rootProcs = getRootProcs(fix);
        if (Settings.hlProcs && rootProcs.length > 0) {
          const hasSid = rootProcs.some(p => p.type === 'SID');
          color = hasSid ? "#ff9e22" : "#00cfcf"; // Darker red for SID, darker cyan for STAR
          isMythic = true;
        }

        ctx.save();
        if (isMythic) {
          ctx.shadowColor = color;
          // Pulse the blur between 4px and 14px based on time
          ctx.shadowBlur = Math.round(9 + 5 * Math.sin(Date.now() / 250)) * dpr;
        }

        // Search-result hover highlight: bright pulsing shadow
        const isHighlighted = _highlightIdent && fix.ident === _highlightIdent;
        if (isHighlighted) {
          ctx.shadowColor = "#ffffff";
          ctx.shadowBlur = Math.round(15 + 10 * Math.sin(Date.now() / 150)) * dpr;
        }

        ctx.fillStyle = isHighlighted ? "#ffffff" : color; // make the core pop white
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 1 * dpr;
        ctx.globalAlpha = Settings.opacity;

        // Keep standard size
        drawShape(fix.type, x, y, r);
        ctx.fill();
        ctx.stroke();

        if (isHighlighted) {
          // Radar ping/ripple effect
          const time = Date.now();
          const duration = 1200;
          const p1 = (time % duration) / duration; 
          const p2 = ((time + (duration/2)) % duration) / duration; 

          ctx.shadowBlur = 0; // Turn off shadow for the crisp ripples

          ctx.beginPath();
          ctx.arc(x, y, r + (25 * dpr * p1), 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2 * dpr;
          ctx.globalAlpha = 1 - p1;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(x, y, r + (25 * dpr * p2), 0, Math.PI * 2);
          ctx.globalAlpha = 1 - p2;
          ctx.stroke();

          // Animated crosshairs
          ctx.beginPath();
          const crossSize = 12 * dpr;
          ctx.moveTo(x - crossSize, y);
          ctx.lineTo(x + crossSize, y);
          ctx.moveTo(x, y - crossSize);
          ctx.lineTo(x, y + crossSize);
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5 * dpr;
          ctx.globalAlpha = 0.4 + 0.4 * Math.sin(time / 200);
          ctx.stroke();

          ctx.globalAlpha = Settings.opacity;
        }

        // Turn off shadow before drawing text so labels remain crisp
        ctx.shadowBlur = 0;

        let labelHit = null;

        if (showLabels) {
          const fs = (zoom >= 11 ? 11 : 10) * dpr * Settings.labelSize;
          ctx.font = `bold ${fs}px monospace`;
          ctx.globalAlpha = Settings.opacity;
          ctx.lineWidth = 3 * dpr;
          const labelColor = isMythic ? color : ((fix.type === "fix" || fix.type === "airport") ? Settings.textColor : color);
          ctx.strokeStyle = isDarkColor(labelColor) ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.9)";
          const label = fix.name ? `${fix.ident} (${fix.name})` : fix.ident;
          
          let labelX = x + r + 3 * dpr;
          let labelY = y + 4 * dpr;
          
          ctx.strokeText(label, labelX, labelY);
          ctx.fillStyle = labelColor;
          ctx.fillText(label, labelX, labelY);
          
          let w = ctx.measureText(label).width;
          labelHit = {
             x1: labelX, 
             y1: labelY - fs * 0.8,
             x2: labelX + w + 4 * dpr, 
             y2: labelY + fs * 0.3
          };
        }

        activeHitboxes.push({
           fix,
           dotHit: { x, y, r: r + 6 * dpr },
           labelHit
        });

        ctx.restore();
        drawn++;
      }

      // Draw highlighted nearby airport to ensure glowing effect triggers even if not in allFixes
      if (_highlightIdent && typeof _nearbyAirports !== 'undefined' && _nearbyAirports.length > 0) {
        const highlightedNearby = _nearbyAirports.find(a => a.icao === _highlightIdent);
        if (highlightedNearby) {
          const pt = latLonToPixel(highlightedNearby.lat, highlightedNearby.lon);
          if (pt && pt.x >= -30 && pt.x <= canvas.width + 30 && pt.y >= -30 && pt.y <= canvas.height + 30) {
            const x = pt.x;
            const y = pt.y;
            const color = COLOR["airport"] || Settings.fixColor || "#c9d1d9";
            
            ctx.save();
            ctx.shadowColor = "#ffffff";
            ctx.shadowBlur = Math.round(15 + 10 * Math.sin(Date.now() / 150)) * dpr;
            ctx.fillStyle = "#ffffff"; // core pops white
            ctx.strokeStyle = "rgba(0,0,0,0.75)";
            ctx.lineWidth = 1 * dpr;
            ctx.globalAlpha = Settings.opacity;
            
            if (typeof drawShape === "function") {
               drawShape("airport", x, y, r);
            } else {
               ctx.beginPath();
               ctx.arc(x, y, r, 0, Math.PI * 2);
            }
            ctx.fill();
            ctx.stroke();

            // Radar ping/ripple effect
            const time = Date.now();
            const duration = 1200;
            const p1 = (time % duration) / duration; 
            const p2 = ((time + (duration/2)) % duration) / duration; 

            ctx.shadowBlur = 0; // Turn off shadow for the crisp ripples

            ctx.beginPath();
            ctx.arc(x, y, r + (25 * dpr * p1), 0, Math.PI * 2);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2 * dpr;
            ctx.globalAlpha = 1 - p1;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, r + (25 * dpr * p2), 0, Math.PI * 2);
            ctx.globalAlpha = 1 - p2;
            ctx.stroke();

            // Animated crosshairs
            ctx.beginPath();
            const crossSize = 12 * dpr;
            ctx.moveTo(x - crossSize, y);
            ctx.lineTo(x + crossSize, y);
            ctx.moveTo(x, y - crossSize);
            ctx.lineTo(x, y + crossSize);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5 * dpr;
            ctx.globalAlpha = 0.4 + 0.4 * Math.sin(time / 200);
            ctx.stroke();

            ctx.globalAlpha = Settings.opacity;

            // Turn off shadow before drawing text so labels remain crisp
            ctx.shadowBlur = 0;

            if (showLabels) {
              const fs = (zoom >= 11 ? 11 : 10) * dpr * Settings.labelSize;
              ctx.font = `bold ${fs}px monospace`;
              ctx.globalAlpha = Settings.opacity;
              ctx.lineWidth = 3 * dpr;
              const labelColor = "#FED8B1"; // User requested specific color for hover popup
              ctx.strokeStyle = isDarkColor(labelColor) ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.9)";
              const label = highlightedNearby.name ? `${highlightedNearby.icao} (${highlightedNearby.name})` : highlightedNearby.icao;
              
              let labelX = x + r + 3 * dpr;
              let labelY = y + 4 * dpr;
              
              ctx.strokeText(label, labelX, labelY);
              ctx.fillStyle = labelColor;
              ctx.fillText(label, labelX, labelY);
            }

            ctx.restore();
          }
        }
      }
    } catch(e) {
      logMsg("[WPT] Draw error: " + String(e), true);
    }
  }

  // Render loop — keeps overlay in sync during panning
  function startRenderLoop() {
    function loop() {
      drawFrame();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────
  function getFixNearMouse(e) {
    const container = canvas ? canvas.parentElement : null;
    if (!container) return null;

    // Yield priority to flights: check if tar1090's own hover popup is visible
    const hlBlock = document.getElementById('highlighted_infoblock');
    if (hlBlock && window.getComputedStyle(hlBlock).display !== 'none' && hlBlock.innerHTML.trim() !== '') {
      // The aircraft hover popup is currently visible on screen
      return null;
    }

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (e.clientX - rect.left) * dpr;
    const my = (e.clientY - rect.top) * dpr;

    // Check hitboxes in reverse order (top-most drawn)
    for (let i = activeHitboxes.length - 1; i >= 0; i--) {
      const box = activeHitboxes[i];
      // Check dot
      if (Math.hypot(box.dotHit.x - mx, box.dotHit.y - my) <= box.dotHit.r) {
         return box.fix;
      }
      // Check label
      if (box.labelHit && 
          mx >= box.labelHit.x1 && mx <= box.labelHit.x2 &&
          my >= box.labelHit.y1 && my <= box.labelHit.y2) {
         return box.fix;
      }
    }
    return null;
  }

  // Check if mouse is inside any MOA polygon (ray-casting point-in-polygon)
  function getMoaNearMouse(e) {
    if (!Settings.showMoas || !allMoas.length) return null;
    const container = canvas ? canvas.parentElement : null;
    if (!container) return null;

    const hlBlock = document.getElementById('highlighted_infoblock');
    if (hlBlock && window.getComputedStyle(hlBlock).display !== 'none' && hlBlock.innerHTML.trim() !== '') return null;

    // Use geographic coordinates for the test (more accurate than pixel)
    const map = getOLMap();
    if (!map) return null;
    const rect = container.getBoundingClientRect();
    const pixel = [e.clientX - rect.left, e.clientY - rect.top];
    let coord;
    try {
      coord = map.getCoordinateFromPixel(pixel);
      if (!coord) return null;
      const lonLat = ol.proj.toLonLat(coord);
      var testLon = lonLat[0], testLat = lonLat[1];
    } catch (_) { return null; }

    for (const moa of allMoas) {
      // Quick AABB reject
      if (testLat < moa.bbox.minLat || testLat > moa.bbox.maxLat ||
          testLon < moa.bbox.minLon || testLon > moa.bbox.maxLon) continue;

      for (const poly of moa.polys) {
        for (const ring of poly) {
          // Ray-casting algorithm
          let inside = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if (((yi > testLat) !== (yj > testLat)) &&
                (testLon < (xj - xi) * (testLat - yi) / (yj - yi) + xi)) {
              inside = !inside;
            }
          }
          if (inside) return moa;
        }
      }
    }
    return null;
  }

  // Get the FBO nearest to mouse position (within ~15px)
  function getFboNearMouse(e) {
    if (!Settings.showFbos || !allFbos.length) return null;
    const dpr = window.devicePixelRatio || 1;
    const threshold = 15;
    let best = null, bestDist = Infinity;
    for (const fbo of allFbos) {
      const p = latLonToPixel(fbo.lat, fbo.lon);
      if (!p) continue;
      const dx = e.clientX - p.x / dpr;
      const dy = e.clientY - p.y / dpr;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < threshold && dist < bestDist) {
        bestDist = dist;
        best = fbo;
      }
    }
    return best;
  }

  let _copiedUntil = 0; // timestamp — tooltip is locked while Date.now() < _copiedUntil
  let _downX = 0, _downY = 0; // mousedown position for drag detection

  // Inject a script into the MAIN world to bridge access to ADS-B Exchange globals
  const injector = document.createElement("script");
  injector.textContent = `
    window.__swedenLastHex = null;
    setInterval(() => {
       try {
         if (typeof SelectedPlane !== 'undefined' && SelectedPlane) {
           window.__swedenLastHex = SelectedPlane.icao || SelectedPlane.hex;
         }
       } catch (e) {}
    }, 500);

    document.addEventListener("SwedenRefocusFlight", () => {
      try {
        if (!window.__swedenLastHex) return;
        setTimeout(() => {
          if ((typeof SelectedPlane === 'undefined' || !SelectedPlane) && typeof selectPlaneByHex === 'function') {
             selectPlaneByHex(window.__swedenLastHex, { follow: false });
          }
        }, 0);
      } catch (e) {}
    });
  `;
  document.head.appendChild(injector);

  // Preserve the currently tracked flight after our click-to-copy
  // by telling the MAIN world script to re-select it.
  function preserveTrackedFlight() {
    document.dispatchEvent(new CustomEvent("SwedenRefocusFlight"));
  }

  function onClick(e) {
    // If the mouse moved more than 5px since mousedown, this was a drag — let the map pan
    if (Math.abs(e.clientX - _downX) > 5 || Math.abs(e.clientY - _downY) > 5) return;

    const fix = getFixNearMouse(e);
    if (fix) {
      preserveTrackedFlight();

      const procCopyText = getProcCopyText(fix);
      const copyText = procCopyText ? procCopyText : (fix.type === "fbo" ? fix.ident.toLowerCase() : (fix.name || fix.ident).toUpperCase());
      navigator.clipboard.writeText(copyText).then(() => {
        if (tooltip && !Settings.hidePopup) {
          const COPY_DURATION = 400;
          _copiedUntil = Date.now() + COPY_DURATION;
          
          let color = getColorMap()[fix.type] || Settings.fixColor;
          const rootProcs = getRootProcs(fix);
          if (Settings.hlProcs && rootProcs.length > 0) {
            const hasSid = rootProcs.some(p => p.type === 'SID');
            color = hasSid ? "#ff9e22" : "#00cfcf";
          }
          
          tooltip.innerHTML = `<span style="color:${readableColor(color)};font-weight:bold;font-size:14px">Copied ${copyText} to clipboard</span>`;
          tooltip.style.display = "block";
          setTimeout(() => { _copiedUntil = 0; }, COPY_DURATION);
        }
      }).catch(err => logMsg("[WPT] clipboard auto-copy failed", true));
      return;
    }

    // Fallback: check MOA click
    const moa = getMoaNearMouse(e);
    if (moa) {
      preserveTrackedFlight();
      // Strip " MOA" suffix, remove digits, clean up extra spaces, and lowercase
      const moaName = moa.name.replace(/\s*MOA$/i, "").replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      navigator.clipboard.writeText(moaName).then(() => {
        if (tooltip && !Settings.hidePopup) {
          const COPY_DURATION = 400;
          _copiedUntil = Date.now() + COPY_DURATION;
          tooltip.innerHTML = `<span style="color:rgba(230, 130, 255, 0.9);font-weight:bold;font-size:14px">Copied ${moaName} to clipboard</span>`;
          tooltip.style.display = "block";
          setTimeout(() => { _copiedUntil = 0; }, COPY_DURATION);
        }
      }).catch(err => logMsg("[WPT] clipboard auto-copy failed", true));
      return;
    }

    // Fallback: check FBO click
    const fbo = getFboNearMouse(e);
    if (fbo) {
      preserveTrackedFlight();
      const fboName = fbo.name.toLowerCase();
      navigator.clipboard.writeText(fboName).then(() => {
        if (tooltip && !Settings.hidePopup) {
          const COPY_DURATION = 400;
          _copiedUntil = Date.now() + COPY_DURATION;
          tooltip.innerHTML = `<span style="color:#DFFF00;font-weight:bold;font-size:14px">Copied ${fboName} to clipboard</span>`;
          tooltip.style.display = "block";
          setTimeout(() => { _copiedUntil = 0; }, COPY_DURATION);
        }
      }).catch(err => logMsg("[WPT] clipboard auto-copy failed", true));
    }
  }

  function onMouseMove(e) {
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "wpt-tooltip";
      tooltip.style.cssText = `
        position:fixed; background:rgba(8,12,20,0.96); color:#e6edf3;
        border:1px solid #30363d; border-radius:7px; padding:8px 12px;
        font-family:monospace; font-size:13px; pointer-events:none;
        z-index:99999; display:none; box-shadow:0 4px 18px rgba(0,0,0,0.6);
        line-height:1.5;
      `;
      document.body.appendChild(tooltip);
    }

    // Don't overwrite the "Copied" message while it's still showing
    if (Date.now() < _copiedUntil) return;

    const fix = getFixNearMouse(e);
    if (fix && !Settings.hidePopup) {
      let dotColor = getColorMap()[fix.type] || Settings.fixColor;
      let isMythic = false;

      const rootProcs = getRootProcs(fix);

      if (Settings.hlProcs && rootProcs.length > 0) {
        const hasSid = rootProcs.some(p => p.type === 'SID');
        dotColor = hasSid ? "#ff9e22" : "#00cfcf";
        isMythic = true;
      }

      const labelColor = isMythic ? dotColor : ((fix.type === "fix" || fix.type === "airport") ? Settings.textColor : dotColor);
      const label = fix.type === "fbo" ? fix.ident.toUpperCase() : (fix.name ? `${fix.ident} (${fix.name})` : fix.ident);
      let html = `<span style="font-size:15px;font-weight:bold;color:${readableColor(labelColor)}">${label}</span>`;

      // Show SID/STAR: only the number and type for procedures named after this fix
      if (rootProcs.length > 0) {
        const p = rootProcs[0];
        const num = p.proc.replace(fix.ident, '').trim();
        html = `<span style="font-size:15px;font-weight:bold;color:${readableColor(labelColor)}">${fix.ident} ${num}</span> <span style="color:${dotColor};font-weight:700;font-size:15px;">- ${p.type}</span>`;
      }

      tooltip.innerHTML = html;
      tooltip.style.display = "block";
      tooltip.style.left = (e.clientX + 16) + "px";
      tooltip.style.top  = (e.clientY - 8) + "px";
    } else {
      // Fallback: check MOA hover (since MOAs are polygons, they are not strictly point-based active hitboxes)
      const moa = getMoaNearMouse(e);
      if (moa && !Settings.hidePopup) {
        tooltip.innerHTML = `<span style="font-size:15px;font-weight:bold;color:rgba(230, 130, 255, 0.9)">${moa.name}</span>`;
        tooltip.style.display = "block";
        tooltip.style.left = (e.clientX + 16) + "px";
        tooltip.style.top  = (e.clientY - 8) + "px";
        return;
      }
      
      tooltip.style.display = "none";
    }
  }

  // ── Load fixes from background ────────────────────────────────────────────
  async function loadFixesForView() {
    if (!Settings.enabled) { allFixes = []; drawFrame(); return; }

    const bbox = getMapBounds();
    if (!bbox) return;

    const zoom = getZoom();
    if (zoom < 6) { allFixes = []; drawFrame(); return; }

    if (lastBbox) {
      const dLat = Math.abs(bbox.minLat - lastBbox.minLat);
      const dLon = Math.abs(bbox.minLon - lastBbox.minLon);
      if (dLat < 0.1 && dLon < 0.1) { drawFrame(); return; }
    }
    lastBbox = bbox;

    const types = [];
    if (Settings.showFixes) types.push("fix", "airport", "vor", "ndb");
    if (!types.length && !Settings.showMoas && !Settings.showFbos) { allFixes = []; allMoas = []; allFbos = []; drawFrame(); return; }

    try {
      const pWait = [];
      if (types.length) {
        pWait.push(bgRequest({ type: "GET_FIXES_IN_BBOX", ...bbox, types }).then(res => {
          allFixes = res.fixes || [];
        }));
      } else {
        allFixes = [];
      }
      
      if (Settings.showMoas) {
        pWait.push(bgRequest({ type: "GET_MOAS_IN_BBOX", ...bbox }).then(res => {
          allMoas = res.moas || [];
        }));
      } else {
        allMoas = [];
      }

      if (Settings.showFbos) {
        pWait.push(bgRequest({ type: "GET_FBOS_IN_BBOX", ...bbox }).then(res => {
          allFbos = res.fbos || [];
        }));
      } else {
        allFbos = [];
      }
      
      await Promise.all(pWait);
      logMsg(`[WPT] Loaded ${allFixes.length} fixes, ${allMoas.length} MOAs, ${allFbos.length} FBOs.`);
    } catch (e) {
      logMsg("[WPT] Load error: " + String(e), true);
    }
  }

  function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadFixesForView, 300);
  }

  function flyToFix(lat, lon, zoom) {
    const map = getOLMap();
    if (!map || !window.ol) { logMsg("[WPT] flyTo: No map", true); return; }
    try {
      const center = ol.proj.fromLonLat([lon, lat]);
      map.getView().animate({
        center: center,
        zoom: zoom || 12,
        duration: 1000
      });
      logMsg(`[WPT] Flew to ${lat.toFixed(3)}, ${lon.toFixed(3)}`);
    } catch (e) {
      logMsg("[WPT] flyTo error: " + String(e), true);
    }
  }

  // ── Aggressive Map Search ─────────────────────────────────────────────────
  function findMapObjectDynamically() {
    // 1. Check known variables
    if (window.OLMap) return window.OLMap;
    if (window.olMap) return window.olMap;
    if (window.map && typeof window.map.getView === 'function') return window.map;
    if (window.SiteTracker && window.SiteTracker.map) return window.SiteTracker.map;
    if (window.tar1090 && window.tar1090.map) return window.tar1090.map;

    // 2. OpenLayers 6+ internal registries
    try {
      if (window.ol && window.ol.Map && window.ol.Map.instances && window.ol.Map.instances.length > 0) {
        logMsg("[WPT DEBUG] Found map in ol.Map.instances!");
        return window.ol.Map.instances[0];
      }
    } catch(e) {}

    // 3. The Intercept Hook Method (runs on new ol.Map())
    if (interceptedMap) return interceptedMap;

    // 4. Fallback: Search all properties of the viewport directly
    try {
      const container = document.querySelector('.ol-viewport') || document.getElementById('map_canvas');
      if (container) {
        const parent = container.parentElement;
        if (parent) {
          logMsg(`[WPT] Scanning parent element properties: ${parent.id || parent.className}...`);
          for (let key in parent) {
            try {
              let obj = parent[key];
              if (obj && typeof obj === 'object') {
                if (typeof obj.getView === 'function' && typeof obj.getLayers === 'function') return obj;
                if (obj.map && typeof obj.map.getView === 'function') return obj.map;
              }
            } catch(e) {}
          }
        }
      }
    } catch(e) {}

    // 5. The Control Injection Trick
    // OpenLayers scans the viewport for DOM elements matching its controls.
    // If we can't find the map, but window.ol exists, we can try to
    // force the map to hand itself to us by creating a dummy control.
    try {
      if (window.ol && window.ol.control && window.ol.control.Control) {
        if (!window.__wpt_dummy_control) {
          logMsg("[WPT] Injecting dummy Control to extract map...");
          const dummyDiv = document.createElement('div');
          const DummyControl = /*@__PURE__*/(function (Control) {
            function DummyControl(opt_options) {
              Control.call(this, { element: dummyDiv, target: opt_options.target });
            }
            if (Control) DummyControl.__proto__ = Control;
            DummyControl.prototype = Object.create(Control && Control.prototype);
            DummyControl.prototype.constructor = DummyControl;
            DummyControl.prototype.setMap = function setMap (map) {
              Control.prototype.setMap.call(this, map);
              if (map && !interceptedMap) {
                logMsg("[WPT DEBUG] Stole map from Control.setMap!");
                interceptedMap = map;
              }
            };
            return DummyControl;
          }(window.ol.control.Control));
          
          window.__wpt_dummy_control = new DummyControl({});
          // The map has a collection of controls. We can't easily push to it without the map.
        }
      }
    } catch(e) {}

    // 6. The Massive Interceptor Hook
    try {
      if (window.ol && window.ol.Map && !window.ol.Map.prototype.__wpt_massive_patched) {
        logMsg("[WPT] Setting up massive ol.Map.prototype interceptor... Waiting for you to move the map.");
        const methods = [
          'getView', 'updateSize', 'render', 'getEventPixel', 
          'getEventCoordinate', 'getFeaturesAtPixel', 'forEachFeatureAtPixel',
          'setTarget', 'getLayers', 'addLayer', 'removeLayer', 'getPixelFromCoordinate'
        ];
        
        methods.forEach(method => {
          if (typeof window.ol.Map.prototype[method] === 'function') {
            const orig = window.ol.Map.prototype[method];
            window.ol.Map.prototype[method] = function() {
              if (!interceptedMap) {
                logMsg(`[WPT DEBUG] JACKPOT! Stole map from ${method}()!`);
                interceptedMap = this;
                // Force an immediate init check now that we have the map
                if (!canvas) setTimeout(initOverlay, 100);
              }
              return orig.apply(this, arguments);
            };
          }
        });
        window.ol.Map.prototype.__wpt_massive_patched = true;
      }
    } catch(e) {}

    return interceptedMap;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  let attempts = 0;
  let interceptedMap = null;

  function injectMapInterceptor() {
    if (!window.ol || !window.ol.Map || window.ol.Map.__wpt_patched) return false;
    
    logMsg("[WPT] Intercepting ol.Map constructor (just in case)...");
    const originalMap = window.ol.Map;
    
    // Monkey-patch the OpenLayers Map constructor
    window.ol.Map = function(options) {
      logMsg("[WPT] Intercepted new ol.Map() call!");
      const instance = new originalMap(options);
      interceptedMap = instance;
      setTimeout(initOverlay, 500);
      return instance;
    };
    
    // Copy over prototype and static props
    window.ol.Map.prototype = originalMap.prototype;
    Object.assign(window.ol.Map, originalMap);
    window.ol.Map.__wpt_patched = true;

    // Alternative: Intercept layer addition. If the map was already created, any new layer added might give us the map
    if (window.ol.layer && window.ol.layer.Layer) {
        const origSetMap = window.ol.layer.Layer.prototype.setMap;
        if (origSetMap) {
            window.ol.layer.Layer.prototype.setMap = function(map) {
                if (map && typeof map.getView === 'function') {
                    if (!interceptedMap) {
                      logMsg("[WPT] Intercepted map via Layer.setMap!");
                      interceptedMap = map;
                      setTimeout(initOverlay, 100);
                    }
                }
                return origSetMap.apply(this, arguments);
            };
        }
    }
    
    return true;
  }

  function getOLMap() {
    // 1. Check known variables just in case
    if (window.OLMap) return window.OLMap;
    if (window.map && typeof window.map.getView === 'function') return window.map;
    // 2. Return the map we intercepted during creation or interaction
    if (interceptedMap) return interceptedMap;
    return null;
  }

  // Inject interceptor immediately in case the map hasn't loaded yet
  injectMapInterceptor();

  function initOverlay() {
    if (canvas) return; // already initialized

    const map = getOLMap();
    const viewport = findMapViewport();

    if (!map || !viewport) {
      logMsg(`[WPT] initOverlay: Map or viewport missing. map=${!!map}, viewport=${!!viewport}`);
      return;
    }

    logMsg("[WPT] Map object captured! Setting up overlay...");
    try {
      createCanvas();
      if (!canvas) { 
        logMsg("[WPT] Canvas creation failed, trying again...", true);
        setTimeout(initOverlay, 500); 
        return; 
      }

      // OpenLayers events
      map.on("moveend", scheduleLoad);
      map.getView().on("change:resolution", scheduleLoad);
      
      startRenderLoop();
      logMsg("[WPT] Triggering initial loadFixesForView...");
      loadFixesForView();
      logMsg("[WPT] Overlay initialised and running render loop!");
    } catch(e) {
      logMsg("[WPT] Init failed: " + String(e), true);
    }
  }

  function init() {
    const map = getOLMap() || findMapObjectDynamically();
    const viewport = findMapViewport();

    if (!map || !viewport) {
      attempts++;
      if (attempts === 1) {
        logMsg("[WPT] Waiting for map interception... Please DRAG, ZOOM, or CLICK the map to force capture.");
      } else if (attempts % 5 === 0) {
        logMsg(`[WPT] Still waiting for you to move the map... (attempt ${attempts})`);
      }
      
      // Keep trying to patch if 'ol' arrived late
      if (!window.ol?.Map?.__wpt_patched) injectMapInterceptor();
      
      // Run forever until we get the map!
      setTimeout(init, 1000);
      return;
    }
    
    initOverlay();
  }



  // ── Load persisted settings before first render ───────────────────────────
  // Request saved toggle states from the background service worker so that
  // Settings are restored immediately after a browser/machine restart.
  async function loadPersistedSettings() {
    try {
      const saved = await bgRequest({ type: "GET_SETTINGS" });
      if (saved) {
        if (saved.enabled       !== undefined) Settings.enabled       = saved.enabled;
        if (saved.showFixes     !== undefined) Settings.showFixes     = saved.showFixes;
        if (saved.showMoas      !== undefined) Settings.showMoas      = saved.showMoas;
        if (saved.showFbos      !== undefined) Settings.showFbos      = saved.showFbos;
        if (saved.opacity       !== undefined) Settings.opacity       = saved.opacity;
        if (saved.showBtn      !== undefined) Settings.showBtn      = saved.showBtn;
        if (saved.labelSize    !== undefined) Settings.labelSize    = saved.labelSize;
        if (saved.scaleDot     !== undefined) Settings.scaleDot     = saved.scaleDot;
        if (saved.hlProcs      !== undefined) Settings.hlProcs      = saved.hlProcs;
        if (saved.hidePopup    !== undefined) Settings.hidePopup    = saved.hidePopup;
        if (saved.fixColor     !== undefined) Settings.fixColor     = saved.fixColor;
        if (saved.textColor    !== undefined) Settings.textColor    = saved.textColor;
        logMsg("[WPT] Persisted settings restored: " + JSON.stringify(Settings));
      }
    } catch (e) {
      logMsg("[WPT] Could not restore settings, using defaults: " + String(e));
    }
  }

  function createQuickAccessButton() {
    const btn = document.createElement("div");
    btn.id = "wpt-quick-access-btn";
    btn.innerText = "Sweden Settings";
    btn.style.position = "fixed";
    
    // Restore saved position or use default
    let savedPos = null;
    try {
      const posStr = localStorage.getItem("wpt_btn_pos");
      if (posStr) savedPos = JSON.parse(posStr);
    } catch(e) {}
    
    if (savedPos && savedPos.top !== undefined && savedPos.left !== undefined) {
      btn.style.top = savedPos.top + "px";
      btn.style.left = savedPos.left + "px";
    } else {
      btn.style.top = "10px";
      btn.style.right = "10px";
    }

    btn.style.zIndex = "999999";
    btn.style.background = "linear-gradient(135deg, #161b22, #1c2333)";
    btn.style.color = "#ffffff";
    btn.style.width = "215px";
    btn.style.height = "38px";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.borderRadius = "8px";
    btn.style.border = "1px solid #30363d";
    btn.style.cursor = "pointer";
    btn.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    btn.style.fontSize = "14px";
    btn.style.fontWeight = "bold";
    btn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.6)";
    btn.style.transition = "background 0.2s";
    btn.style.userSelect = "none";
    
    btn.addEventListener("mouseover", () => {
      btn.style.background = "linear-gradient(135deg, #21262d, #272f44)";
    });
    btn.addEventListener("mouseout", () => {
      btn.style.background = "linear-gradient(135deg, #161b22, #1c2333)";
    });

    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // Only left click
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = btn.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      
      btn.style.transition = "none"; // Disable transition during drag
      btn.style.right = "auto";
      btn.style.left = startLeft + "px";
      btn.style.top = startTop + "px";
      
      e.preventDefault(); // Prevent text selection
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      // Small threshold to distinguish click from drag
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      
      if (hasMoved) {
        btn.style.left = (startLeft + dx) + "px";
        btn.style.top = (startTop + dy) + "px";
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      btn.style.transition = "background 0.2s"; // Restore transition
      if (hasMoved) {
        try {
          const rect = btn.getBoundingClientRect();
          localStorage.setItem("wpt_btn_pos", JSON.stringify({ left: rect.left, top: rect.top }));
        } catch(err) {}
      }
    });
    
    btn.addEventListener("click", () => {
      if (hasMoved) return; // Ignore click if dragging occurred
      bgRequest({ type: "OPEN_POPUP" }).catch(e => {
        if (String(e).includes("invalidated")) return; // expected after extension reload
        logMsg("Failed to open popup: " + e, true);
      });
    });
  
    document.body.appendChild(btn);

    // Apply persisted showBtn visibility
    if (!Settings.showBtn) btn.style.display = "none";
  }

  // Wait for the bridge to be ready, load settings, then start map init
  async function startWithSettings() {
    await loadPersistedSettings();
    createQuickAccessButton();
    setTimeout(init, 1500);
  }

  startWithSettings();

  // Expose for popup commands
  window.__wptOverlay = { getSettings: () => ({...Settings}), reload: loadFixesForView };
  logMsg("[WPT] Exposed window.__wptOverlay");

  // ── Fuzzy search engine ─────────
  const SOUND_GROUPS = [
    "EI","AE","OU","BP","DT","GKC","FV","SZC","MN","LR","JY","XKS"
  ];
  const CHAR_GROUPS = {};
  for (let gi = 0; gi < SOUND_GROUPS.length; gi++) {
    for (const ch of SOUND_GROUPS[gi]) {
      if (!CHAR_GROUPS[ch]) CHAR_GROUPS[ch] = [];
      CHAR_GROUPS[ch].push(gi);
    }
  }
  function charSimilarity(a, b) {
    if (a === b) return 1.0;
    const ga = CHAR_GROUPS[a], gb = CHAR_GROUPS[b];
    if (!ga || !gb) return 0;
    for (const g of ga) { if (gb.includes(g)) return 0.6; }
    return 0;
  }
  function soundSimilarityScore(a, b) {
    a = String(a || "").toUpperCase(); b = String(b || "").toUpperCase();
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length), minLen = Math.min(a.length, b.length);
    if (maxLen === 0) return 0;
    let totalSim = 0;
    for (let i = 0; i < minLen; i++) totalSim += charSimilarity(a[i], b[i]);
    const lengthPenalty = 1 - (maxLen - minLen) / maxLen;
    return Math.round((totalSim / maxLen) * 100 * lengthPenalty);
  }
  function phoneticNormalize(s) {
    if (!s) return "";
    s = s.toUpperCase().replace(/[^A-Z]/g, "");
    const rules = [
      [/PH/g,"F"],[/CK/g,"K"],[/Q/g,"K"],[/X/g,"KS"],
      [/Z/g,"S"],[/DG/g,"J"],[/GH/g,"G"],[/KN/g,"N"],[/WR/g,"R"],
      [/EE/g,"I"],[/EA/g,"I"],[/IE/g,"I"],[/EY/g,"I"],[/AY/g,"I"],
      [/OO/g,"U"],[/OU/g,"U"],[/ISN/g,"SN"],[/YSN/g,"SN"]
    ];
    for (const [r, rep] of rules) s = s.replace(r, rep);
    s = s.replace(/Y/g, "I");
    s = s.replace(/(.)\\1+/g, "$1");
    if (s.length > 1) s = s[0] + s.slice(1).replace(/[AEIOU]/g, "");
    return s;
  }
  function consonantSkeleton(s) {
    if (!s) return "";
    return s.toUpperCase().replace(/[^A-Z]/g, "")
      .replace(/[AEIOU]/g, "").replace(/PH/g,"F")
      .replace(/CK/g,"K").replace(/Q/g,"K").replace(/Z/g,"S")
      .replace(/(.)\\1+/g, "$1");
  }
  function fuzzyMatch(str, pattern) {
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
        if (b.charAt(i-1) === a.charAt(j-1)) matrix[i][j] = matrix[i-1][j-1];
        else matrix[i][j] = Math.min(matrix[i-1][j-1]+1, matrix[i][j-1]+1, matrix[i-1][j]+1);
      }
    }
    return matrix[b.length][a.length];
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
    if (fuzzyMatch(fix, query)) score += 40;
    const distPh = levenshtein(fixPh, qPh);
    score += Math.max(0, 40 - distPh * 6);
    const distRaw = levenshtein(fix, query);
    if (distRaw <= 3) score += [300, 200, 120, 60][distRaw];
    return score;
  }

  // ── Area Selection Mode ──────────────────────────────────────────────────────
  function pixelToLatLon(px, py) {
    const map = getOLMap();
    if (!map || !window.ol) return null;
    try {
      const coord = map.getCoordinateFromPixel([px, py]);
      if (!coord) return null;
      const lonlat = ol.proj.toLonLat(coord);
      return { lat: lonlat[1], lon: lonlat[0] };
    } catch (_) { return null; }
  }

  function startAreaSelection() {
    const old = document.getElementById("wpt-selection-overlay");
    if (old) old.remove();

    // Restore last used mode or default to rect
    let mode = "rect";
    try { mode = localStorage.getItem("wpt_selMode") || "rect"; } catch(_) {}

    const overlay = document.createElement("div");
    overlay.id = "wpt-selection-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      z-index: 999999;
      cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cline x1='16' y1='0' x2='16' y2='32' stroke='%2358a6ff' stroke-width='2'/%3E%3Cline x1='0' y1='16' x2='32' y2='16' stroke='%2358a6ff' stroke-width='2'/%3E%3Ccircle cx='16' cy='16' r='6' fill='none' stroke='%2358a6ff' stroke-width='1.5'/%3E%3C/svg%3E") 16 16, crosshair;
    `;

    // Hide quick-access button during selection
    const qab = document.getElementById("wpt-quick-access-btn");
    if (qab) qab.style.display = "none";

    const cvs = document.createElement("canvas");
    cvs.width = window.innerWidth;
    cvs.height = window.innerHeight;
    cvs.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;";
    overlay.appendChild(cvs);
    const dc = cvs.getContext("2d");

    // Banner
    const banner = document.createElement("div");
    banner.style.cssText = `
      position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
      background: rgba(13,17,23,0.92); color: #e6edf3; padding: 10px 18px;
      border-radius: 8px; border: 1px solid #58a6ff; font-size: 12px;
      font-weight: 600; font-family: monospace; pointer-events: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      display: flex; align-items: center; gap: 12px;
    `;
    const bannerText = document.createElement("span");
    bannerText.style.pointerEvents = "none";

    const modeToggle = document.createElement("div");
    modeToggle.style.cssText = `
      display: flex; gap: 2px; background: #161b22; border: 1px solid #30363d;
      border-radius: 5px; padding: 2px; pointer-events: auto;
    `;

    const btnStyle = `border:none; border-radius:3px; padding:3px 8px; font-size:10px;
      font-weight:600; cursor:pointer; transition:all 0.15s;`;
    const btnModeRect = document.createElement("button");
    btnModeRect.textContent = "Rectangle";
    btnModeRect.style.cssText = btnStyle;
    const btnModeFree = document.createElement("button");
    btnModeFree.textContent = "Free Select";
    btnModeFree.style.cssText = btnStyle;
    const btnModeCircle = document.createElement("button");
    btnModeCircle.textContent = "Circle";
    btnModeCircle.style.cssText = btnStyle;

    const allModeBtns = [btnModeRect, btnModeFree, btnModeCircle];

    function switchMode(m) {
      mode = m;
      try { localStorage.setItem("wpt_selMode", m); } catch(_) {}
      freePoints = [];
      rectDrawing = false;
      circDrawing = false;
      dc.clearRect(0, 0, cvs.width, cvs.height);
      allModeBtns.forEach(b => { b.style.background = "transparent"; b.style.color = "#8b949e"; });
      const activeBtn = m === "rect" ? btnModeRect : m === "free" ? btnModeFree : btnModeCircle;
      activeBtn.style.background = "#58a6ff";
      activeBtn.style.color = "#0d1117";
      if (m === "rect") bannerText.textContent = "Drag to select";
      else if (m === "free") bannerText.textContent = "Click to place points \u00b7 Right-click to finish";
      else bannerText.textContent = "Click center, drag radius";
    }

    btnModeRect.addEventListener("click", (e) => { e.stopPropagation(); switchMode("rect"); });
    btnModeFree.addEventListener("click", (e) => { e.stopPropagation(); switchMode("free"); });
    btnModeCircle.addEventListener("click", (e) => { e.stopPropagation(); switchMode("circle"); });

    modeToggle.appendChild(btnModeRect);
    modeToggle.appendChild(btnModeFree);
    modeToggle.appendChild(btnModeCircle);

    const escHint = document.createElement("span");
    escHint.textContent = "ESC to cancel";
    escHint.style.cssText = "color: #8b949e; font-size: 10px; pointer-events: none;";

    banner.appendChild(bannerText);
    banner.appendChild(modeToggle);
    banner.appendChild(escHint);
    overlay.appendChild(banner);

    // ── State ──
    let rectDrawing = false, rectSx = 0, rectSy = 0;
    let freePoints = [];
    let circDrawing = false, circCx = 0, circCy = 0;

    // ── Draw helpers ──
    function drawFreeOverlay(mouseX, mouseY) {
      dc.clearRect(0, 0, cvs.width, cvs.height);
      if (freePoints.length === 0) return;
      dc.beginPath();
      dc.moveTo(freePoints[0].x, freePoints[0].y);
      for (let i = 1; i < freePoints.length; i++) dc.lineTo(freePoints[i].x, freePoints[i].y);
      if (mouseX !== undefined) dc.lineTo(mouseX, mouseY);
      dc.lineTo(freePoints[0].x, freePoints[0].y);
      dc.closePath();
      dc.fillStyle = "rgba(88,166,255,0.1)"; dc.fill();
      dc.strokeStyle = "#58a6ff"; dc.lineWidth = 2;
      dc.setLineDash([6, 4]); dc.stroke(); dc.setLineDash([]);
      for (const pt of freePoints) {
        dc.beginPath(); dc.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        dc.fillStyle = "#58a6ff"; dc.fill();
        dc.strokeStyle = "#0d1117"; dc.lineWidth = 1; dc.stroke();
      }
    }

    function drawRectOverlay(x1, y1, x2, y2) {
      dc.clearRect(0, 0, cvs.width, cvs.height);
      const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
      dc.fillStyle = "rgba(88,166,255,0.1)"; dc.fillRect(rx, ry, rw, rh);
      dc.strokeStyle = "#58a6ff"; dc.lineWidth = 2;
      dc.setLineDash([6, 4]); dc.strokeRect(rx, ry, rw, rh); dc.setLineDash([]);
    }

    function drawCircleOverlay(sx, sy, ex, ey) {
      dc.clearRect(0, 0, cvs.width, cvs.height);
      const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
      const r = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) / 2;
      dc.beginPath(); dc.arc(cx, cy, r, 0, Math.PI * 2);
      dc.fillStyle = "rgba(88,166,255,0.1)"; dc.fill();
      dc.strokeStyle = "#58a6ff"; dc.lineWidth = 2;
      dc.setLineDash([6, 4]); dc.stroke(); dc.setLineDash([]);
      // Start and end dots
      dc.beginPath(); dc.arc(sx, sy, 3, 0, Math.PI * 2);
      dc.fillStyle = "#58a6ff"; dc.fill();
      dc.beginPath(); dc.arc(ex, ey, 3, 0, Math.PI * 2);
      dc.fillStyle = "#58a6ff"; dc.fill();
    }

    function finishFreeSelect() {
      if (freePoints.length < 3) return;
      const polygon = freePoints.map(p => pixelToLatLon(p.x, p.y)).filter(Boolean);
      if (polygon.length < 3) return;
      overlay.remove(); document.removeEventListener("keydown", onKey);
      collectPolygonWaypoints(polygon);
    }

    function finishCircleSelect(sx, sy, ex, ey) {
      const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
      const r = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) / 2;
      if (r < 15) return;
      const polygon = [];
      for (let i = 0; i < 36; i++) {
        const angle = (i / 36) * Math.PI * 2;
        const px = cx + r * Math.cos(angle);
        const py = cy + r * Math.sin(angle);
        const ll = pixelToLatLon(px, py);
        if (ll) polygon.push(ll);
      }
      if (polygon.length < 3) return;
      overlay.remove(); document.removeEventListener("keydown", onKey);
      collectPolygonWaypoints(polygon);
    }

    // ── Events ──
    overlay.addEventListener("mousedown", (e) => {
      if (mode === "rect") {
        rectDrawing = true; rectSx = e.clientX; rectSy = e.clientY;
      }
      if (mode === "circle") {
        circDrawing = true; circCx = e.clientX; circCy = e.clientY;
      }
    });

    overlay.addEventListener("mousemove", (e) => {
      if (mode === "rect" && rectDrawing) {
        drawRectOverlay(rectSx, rectSy, e.clientX, e.clientY);
      }
      if (mode === "free" && freePoints.length > 0) {
        drawFreeOverlay(e.clientX, e.clientY);
      }
      if (mode === "circle" && circDrawing) {
        drawCircleOverlay(circCx, circCy, e.clientX, e.clientY);
      }
    });

    overlay.addEventListener("mouseup", (e) => {
      if (mode === "rect" && rectDrawing) {
        rectDrawing = false;
        const x1 = Math.min(rectSx, e.clientX), y1 = Math.min(rectSy, e.clientY);
        const x2 = Math.max(rectSx, e.clientX), y2 = Math.max(rectSy, e.clientY);
        if (x2 - x1 < 20 || y2 - y1 < 20) return;
        overlay.remove(); document.removeEventListener("keydown", onKey);
        const tl = pixelToLatLon(x1, y1), br = pixelToLatLon(x2, y2);
        if (!tl || !br) return;
        collectAreaWaypoints({
          minLat: Math.min(tl.lat, br.lat), maxLat: Math.max(tl.lat, br.lat),
          minLon: Math.min(tl.lon, br.lon), maxLon: Math.max(tl.lon, br.lon),
        });
      }
      if (mode === "circle" && circDrawing) {
        circDrawing = false;
        finishCircleSelect(circCx, circCy, e.clientX, e.clientY);
      }
    });

    overlay.addEventListener("click", (e) => {
      if (mode === "free") {
        freePoints.push({ x: e.clientX, y: e.clientY });
        drawFreeOverlay(e.clientX, e.clientY);
      }
    });

    overlay.addEventListener("contextmenu", (e) => {
      if (mode === "free") { e.preventDefault(); finishFreeSelect(); }
    });

    const onKey = (e) => {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        const qab2 = document.getElementById("wpt-quick-access-btn");
        if (qab2) qab2.style.display = "flex";
        bgRequest({ type: "OPEN_POPUP" }).catch(() => {});
      }
    };
    document.addEventListener("keydown", onKey);

    // Initialize with persisted mode
    switchMode(mode);
    document.body.appendChild(overlay);
  }

  // Ray-casting point-in-polygon test
  function pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lat, yi = polygon[i].lon;
      const xj = polygon[j].lat, yj = polygon[j].lon;
      if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  }

  async function collectPolygonWaypoints(polygon) {
    const lats = polygon.map(p => p.lat), lons = polygon.map(p => p.lon);
    const bbox = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
    try {
      const p1 = bgRequest({
        type: "GET_FIXES_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon,
        types: ["fix", "airport", "vor", "ndb"]
      });
      const p2 = bgRequest({
        type: "GET_MOAS_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon
      });
      const p3 = bgRequest({
        type: "GET_FBOS_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon
      });
      const [res, mres, fres] = await Promise.all([p1, p2, p3]);
      
      const fixes = (res.fixes || []).filter(f => pointInPolygon(f.lat, f.lon, polygon));
      
      const seenNames = new Set();
      const moas = (mres.moas || []).filter(m => {
        if (seenNames.has(m.name)) return false;
        seenNames.add(m.name);
        const clat = (m.bbox.minLat + m.bbox.maxLat) / 2;
        const clon = (m.bbox.minLon + m.bbox.maxLon) / 2;
        return pointInPolygon(clat, clon, polygon);
      }).map(m => {
        const clat = (m.bbox.minLat + m.bbox.maxLat) / 2;
        const clon = (m.bbox.minLon + m.bbox.maxLon) / 2;
        return {
          ident: m.name.replace(/\s*MOA$/i, "").trim().toUpperCase(),
          name: m.name,
          type: "moa",
          lat: clat,
          lon: clon,
          procs: [],
          copyText: m.name.replace(/\s*MOA$/i, "").replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim().toLowerCase()
        };
      });

      const fbos = (fres.fbos || []).filter(f => pointInPolygon(f.lat, f.lon, polygon)).map(f => ({
        ident: f.name,
        name: f.icao,
        type: "fbo",
        lat: f.lat,
        lon: f.lon,
        procs: [],
        copyText: f.name.toLowerCase()
      }));

      showAreaResultsPanel([...moas, ...fbos, ...fixes], bbox);
    } catch (e) { logMsg("[WPT] Polygon query failed: " + String(e), true); }
  }

  async function collectAreaWaypoints(bbox) {
    try {
      const p1 = bgRequest({
        type: "GET_FIXES_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon,
        types: ["fix", "airport", "vor", "ndb"]
      });
      const p2 = bgRequest({
        type: "GET_MOAS_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon
      });
      const p3 = bgRequest({
        type: "GET_FBOS_IN_BBOX",
        minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon
      });
      const [res, mres, fres] = await Promise.all([p1, p2, p3]);

      const fixes = res.fixes || [];
      
      const seenNames = new Set();
      const moas = (mres.moas || []).filter(m => {
        if (seenNames.has(m.name)) return false;
        seenNames.add(m.name);
        return true;
      }).map(m => {
        const clat = (m.bbox.minLat + m.bbox.maxLat) / 2;
        const clon = (m.bbox.minLon + m.bbox.maxLon) / 2;
        return {
          ident: m.name.replace(/\s*MOA$/i, "").trim().toUpperCase(),
          name: m.name,
          type: "moa",
          lat: clat,
          lon: clon,
          procs: [],
          copyText: m.name.replace(/\s*MOA$/i, "").replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim().toLowerCase()
        };
      });

      const fbos = (fres.fbos || []).map(f => ({
        ident: f.name,
        name: f.icao,
        type: "fbo",
        lat: f.lat,
        lon: f.lon,
        procs: [],
        copyText: f.name.toLowerCase()
      }));

      showAreaResultsPanel([...moas, ...fbos, ...fixes], bbox);
    } catch (e) { logMsg("[WPT] Area selection query failed: " + String(e), true); }
  }

  function showAreaResultsPanel(fixes, bbox) {
    // Remove any existing panel
    const old = document.getElementById("wpt-area-panel");
    if (old) old.remove();

    // Hide quick-access button while panel is visible
    const qab3 = document.getElementById("wpt-quick-access-btn");
    if (qab3) qab3.style.display = "none";

    const panel = document.createElement("div");
    panel.id = "wpt-area-panel";
    panel.style.cssText = `
      position: fixed; top: 60px; right: 16px; width: 320px; max-height: 70vh;
      background: #0d1117; border: 1px solid #30363d; border-radius: 10px;
      color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
      z-index: 999998; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      display: flex; flex-direction: column; overflow: hidden;
    `;

    // Header
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 12px 16px; border-bottom: 1px solid #21262d;
      display: flex; justify-content: space-between; align-items: center;
      background: #161b22; border-radius: 10px 10px 0 0;
    `;
    header.innerHTML = `
      <div style="display:flex; flex-direction:column;">
        <span style="font-weight:700; font-size:13px;">Area Selection — ${fixes.length} waypoints</span>
        <span style="font-size:10px; color:#8b949e; margin-top:2px; font-weight:normal;">Right-click to fly-to point</span>
      </div>
    `;
    const closeBtn = document.createElement("span");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "cursor:pointer; color:#8b949e; font-size:18px; line-height:1; padding: 0 2px;";
    closeBtn.addEventListener("click", () => {
      panel.remove();
      const qab4 = document.getElementById("wpt-quick-access-btn");
      if (qab4) qab4.style.display = "flex";
      bgRequest({ type: "OPEN_POPUP" }).catch(() => {});
    });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    if (fixes.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding: 24px 16px; text-align: center; color: #8b949e; font-size: 12px;";
      empty.textContent = "No waypoints found in the selected area";
      panel.appendChild(empty);
      document.body.appendChild(panel);
      return;
    }

    // Toolbar: Copy All + New Selection
    const toolbar = document.createElement("div");
    toolbar.style.cssText = `padding: 8px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 8px;`;
    const btnStyle = `background:#21262d; color:#e6edf3; border:1px solid #30363d; border-radius:5px;
      padding:5px 12px; font-size:11px; cursor:pointer; font-weight:600;`;
    const copyAllBtn = document.createElement("button");
    copyAllBtn.textContent = "Copy All";
    copyAllBtn.style.cssText = btnStyle;
    copyAllBtn.addEventListener("click", () => {
      const filtered = getFilteredFixes();
      const text = filtered.map(f => f.ident).join(", ");
      navigator.clipboard.writeText(text).then(() => {
        copyAllBtn.textContent = "\u2713 Copied!";
        setTimeout(() => { copyAllBtn.textContent = "Copy All"; }, 1200);
      });
    });
    copyAllBtn.addEventListener("mouseover", () => { copyAllBtn.style.background = "#30363d"; });
    copyAllBtn.addEventListener("mouseout", () => { copyAllBtn.style.background = "#21262d"; });
    toolbar.appendChild(copyAllBtn);

    const newSelBtn = document.createElement("button");
    newSelBtn.textContent = "New Selection";
    newSelBtn.style.cssText = btnStyle;
    newSelBtn.addEventListener("click", () => { panel.remove(); startAreaSelection(); });
    newSelBtn.addEventListener("mouseover", () => { newSelBtn.style.background = "#30363d"; });
    newSelBtn.addEventListener("mouseout", () => { newSelBtn.style.background = "#21262d"; });
    toolbar.appendChild(newSelBtn);
    panel.appendChild(toolbar);

    // Search box
    const searchRow = document.createElement("div");
    searchRow.style.cssText = "padding: 6px 12px; border-bottom: 1px solid #21262d;";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = `Filter ${fixes.length} waypoints...`;
    searchInput.style.cssText = `
      width: 100%; box-sizing: border-box; background: #161b22; color: #e6edf3;
      border: 1px solid #30363d; border-radius: 5px; padding: 6px 10px;
      font-size: 11px; font-family: monospace; outline: none;
    `;
    searchInput.addEventListener("focus", () => { searchInput.style.borderColor = "#58a6ff"; });
    searchInput.addEventListener("blur", () => { searchInput.style.borderColor = "#30363d"; });
    searchRow.appendChild(searchInput);
    panel.appendChild(searchRow);

    // Results list
    const list = document.createElement("div");
    list.className = "wpt-area-list";
    list.style.cssText = "overflow-y: auto; flex: 1; padding: 4px 0;";

    if (!document.getElementById("wpt-area-scrollbar-css")) {
      const style = document.createElement("style");
      style.id = "wpt-area-scrollbar-css";
      style.textContent = `
        .wpt-area-list::-webkit-scrollbar { width: 4px; }
        .wpt-area-list::-webkit-scrollbar-track { background: transparent; }
        .wpt-area-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
      `;
      document.head.appendChild(style);
    }

    const colorMap = getColorMap();

    function getFilteredFixes() {
      const q = searchInput.value.trim().toUpperCase();
      if (!q) {
        // Prioritize SIDs and STARs before generic fixes when no search is active
        return [...fixes].sort((a, b) => {
          const aProc = getRootProcs(a).length > 0 ? 1 : 0;
          const bProc = getRootProcs(b).length > 0 ? 1 : 0;
          if (aProc !== bProc) return bProc - aProc;
          return a.ident.localeCompare(b.ident); // alphabetical for ties
        });
      }
      const scored = [];
      for (const f of fixes) {
        let sc = soundScore(f.ident, q);
        if (f.name) sc = Math.max(sc, soundScore(f.name.replace(/[^A-Z]/g, ""), q));
        if (sc > 0) scored.push({ fix: f, score: sc });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map(s => s.fix);
    }

    function renderList() {
      list.innerHTML = "";
      const filtered = getFilteredFixes();
      if (filtered.length === 0) {
        const msg = document.createElement("div");
        msg.style.cssText = "padding: 16px; text-align: center; color: #8b949e; font-size: 11px;";
        msg.textContent = "No matches";
        list.appendChild(msg);
        return;
      }
      filtered.forEach((fix, i) => {
        const row = document.createElement("div");
        row.style.cssText = `
          padding: 6px 16px; display: flex; align-items: center; gap: 8px;
          cursor: pointer; transition: background 0.15s;
          ${i % 2 === 0 ? "background: #0d1117;" : "background: #161b22;"}
        `;
        row.addEventListener("mouseover", () => { 
          row.style.background = "#21262d"; 
          _highlightIdent = fix.ident;
        });
        row.addEventListener("mouseout", () => { 
          row.style.background = i % 2 === 0 ? "#0d1117" : "#161b22"; 
          if (_highlightIdent === fix.ident) _highlightIdent = null;
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          if (typeof setCenterByLatLon === "function") {
             setCenterByLatLon(fix.lat, fix.lon);
          } else {
             const map = getOLMap();
             if (map) map.getView().animate({ center: ol.proj.fromLonLat([fix.lon, fix.lat]), duration: 500, zoom: 11 });
          }
        });
        row.addEventListener("click", () => {
          const procCopyText = getProcCopyText(fix);
          let defaultCopy = (fix.ident || "").toUpperCase();
          if (fix.type === "fbo") {
            defaultCopy = fix.ident.toLowerCase();
          } else if (fix.type === "moa") {
            defaultCopy = fix.copyText;
          } else if (fix.name) {
            defaultCopy = fix.name.toUpperCase();
          }
          const txt = procCopyText ? procCopyText : defaultCopy;
          navigator.clipboard.writeText(txt).then(() => {
            const originalHTML = identEl.innerHTML;
            identEl.innerHTML = "\u2713 Copied!";
            setTimeout(() => { identEl.innerHTML = originalHTML; }, 800);
          });
        });

        const dot = document.createElement("div");
        let c = fix.type === "moa" ? "rgba(230, 130, 255, 0.9)" : (colorMap[fix.type] || Settings.fixColor);
        let isMythic = false;
        let pText = "";
        let pLabel = fix.type === "fbo" ? fix.ident.toUpperCase() : fix.ident;

        const rootProcs = getRootProcs(fix);

        if (Settings.hlProcs && rootProcs.length > 0) {
          const hasSid = rootProcs.some(p => p.type === 'SID');
          c = hasSid ? "#ff9e22" : "#00cfcf";
          isMythic = true;
          const p = rootProcs[0];
          const num = p.proc.replace(fix.ident, '').trim();
          pLabel = `${fix.ident} ${num}`;
          pText = ` - ${p.type}`;
        } else if (!Settings.hlProcs && rootProcs.length > 0) {
          // If highlighting off, still show the proc number and type to identify it
          const p = rootProcs[0];
          const num = p.proc.replace(fix.ident, '').trim();
          pLabel = `${fix.ident} ${num}`;
          pText = ` - ${p.type}`;
        }

        dot.style.cssText = `width:8px; height:8px; border-radius:50%; background:${c}; flex-shrink:0;${isMythic ? ` box-shadow: 0 0 5px ${c};` : ""}`;
        row.appendChild(dot);

        const identEl = document.createElement("span");
        if (pText) {
          identEl.innerHTML = `<span>${pLabel}</span><span style="font-size: 10px; margin-left: 4px; color: ${isMythic ? c : '#8b949e'};">${pText}</span>`;
        } else {
          identEl.textContent = fix.ident;
        }
        identEl.style.cssText = `font-weight:700; font-size:12px; color:${c}; min-width: 50px;`;
        row.appendChild(identEl);

        if (fix.name && fix.type !== "fbo") {
          const name = document.createElement("span");
          name.textContent = fix.name;
          name.style.cssText = "font-size:11px; color:#8b949e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
          row.appendChild(name);
        }

        const type = document.createElement("span");
        type.textContent = fix.type;
        type.style.cssText = "font-size:9px; color:#484f58; margin-left:auto; text-transform:uppercase; flex-shrink:0;";
        row.appendChild(type);

        list.appendChild(row);
      });
    }

    let _filterTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(_filterTimer);
      _filterTimer = setTimeout(renderList, 150);
    });

    renderList();

    panel.appendChild(list);
    document.body.appendChild(panel);

    // Make panel draggable
    let isDragging = false, dragOffX = 0, dragOffY = 0;
    header.style.cursor = "move";
    header.addEventListener("mousedown", (e) => {
      isDragging = true;
      dragOffX = e.clientX - panel.getBoundingClientRect().left;
      dragOffY = e.clientY - panel.getBoundingClientRect().top;
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      panel.style.left = (e.clientX - dragOffX) + "px";
      panel.style.top = (e.clientY - dragOffY) + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { isDragging = false; });
  }

  // ── Flight Path Tracker ───────────────────────────────────────────────────
  let trackerUpdateInterval = null;
  let currentTrackerData = { allPoints: [], zones: { crossed: [], "5nm": [], "10nm": [], "15nm": [], "20nm": [] } };
  let trackerBbox = null;
  let globalTrackerQuery = "";
  let zoneQueries = { crossed: "", "5nm": "", "10nm": "", "15nm": "", "20nm": "" };
  let openZones = { crossed: true, "5nm": false, "10nm": false, "15nm": false, "20nm": false };

  // Route info state
  let trackerRouteInfo = null;      // { callsign, airline, origin, destination } or null
  let trackerRouteCallsign = "";    // last callsign we fetched route for
  let trackerRouteTimestamp = 0;    // last timestamp bucket we fetched route for (1-hour granularity)
  let trackerRouteFirstPt = null;   // last drawn trail start point {lat, lon}
  let trackerRouteFetching = false; // true while fetch is in-flight

  function extractPlaneTrack() {
    if (typeof SelectedPlane === "undefined" || !SelectedPlane) return null;
    const pts = [];

    // Primary source: track_linesegs (the actual drawn flight path)
    if (Array.isArray(SelectedPlane.track_linesegs) && SelectedPlane.track_linesegs.length > 0) {
      // Sort by segment timestamp (tar1090 exposes `ts` on each lineseg) so that
      // pts[0] is always the chronologically earliest point (departure/origin) and
      // pts[last] is the most recent point (approaching destination).
      // Without this sort, the array order is indeterminate — OpenLayers may render
      // segments newest-first, which inverts origin and destination in the GPS fallback.
      const sortedSegs = SelectedPlane.track_linesegs.slice().sort((a, b) => {
        const ta = (a.ts != null ? a.ts : (a.position_time != null ? a.position_time : 0));
        const tb = (b.ts != null ? b.ts : (b.position_time != null ? b.position_time : 0));
        return ta - tb; // ascending: oldest first
      });

      const seen = new Set();
      for (const seg of sortedSegs) {
        if (seg.position && Array.isArray(seg.position) && seg.position.length === 2) {
          const key = seg.position[0].toFixed(5) + "," + seg.position[1].toFixed(5);
          if (!seen.has(key)) {
            seen.add(key);
            pts.push({ lat: seg.position[1], lon: seg.position[0] }); // [lon, lat] -> {lat, lon}
          }
        }
      }
    }

    // Add current position
    if (SelectedPlane.position && Array.isArray(SelectedPlane.position) && SelectedPlane.position.length === 2) {
      pts.push({ lat: SelectedPlane.position[1], lon: SelectedPlane.position[0] });
    }

    // Extract callsign (e.g. "SWA123") — often padded with spaces
    const callsign = (SelectedPlane.flight || "").trim();
    // Extract registration/tail number (e.g. "N7815L") to identify physical aircraft
    const registration = (SelectedPlane.registration || SelectedPlane.r || "").trim();
    
    // The most accurate target time for flight snapping is the exact playback position time.
    let timestamp = (SelectedPlane.position_time || (Date.now() / 1000)) * 1000;

    // In historical playback, position_time may be frozen at the start/end of the track
    // while the plane icon is visually moved by the scrubber.
    // We can calculate the true scrubbed time by finding the track point closest to the rendered position.
    if (SelectedPlane.track && SelectedPlane.track.length > 0 && SelectedPlane.position) {
      const curLon = SelectedPlane.position[0];
      const curLat = SelectedPlane.position[1];
      if (curLon !== undefined && curLat !== undefined) {
        let minDst = Infinity;
        let closestTime = timestamp;
        
        for (let i = 0; i < SelectedPlane.track.length; i++) {
          const ptTime = SelectedPlane.track[i][0];
          const ptLat = SelectedPlane.track[i][1];
          const ptLon = SelectedPlane.track[i][2];
          
          if (ptTime && ptLat !== undefined && ptLon !== undefined) {
            const dst = Math.pow(ptLat - curLat, 2) + Math.pow(ptLon - curLon, 2);
            if (dst < minDst) {
              minDst = dst;
              closestTime = ptTime * 1000; // tar1090 track timestamps are in seconds
            }
          }
        }
        
        // If we found a track point that perfectly matches the plane's icon location, use its time!
        if (minDst < 0.001) {
          timestamp = closestTime;
        }
      }
    }

    return pts.length > 1 ? { pts, callsign, registration, timestamp } : null;
  }

  async function updateTrackerData() {
    if (!document.getElementById("sweden-tracker-panel")) return;
    const trackData = extractPlaneTrack();
    if (!trackData) {
      const listCont = document.getElementById("tracker-list-cont");
      if (listCont) listCont.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;font-size:12px;">Waiting for flight path data...<br>Select a plane with a visible track.</div>';
      // Clear route info when no plane selected
      if (trackerRouteCallsign) {
        trackerRouteCallsign = "";
        trackerRouteTimestamp = 0;
        trackerRouteInfo = null;
        renderRouteInfo();
      }
      return;
    }
    const pts = trackData.pts;
    const callsign = trackData.callsign;

    // ── Async route lookup (non-blocking) ─────────────────────────────────
    // Re-fetch only if the callsign changed OR the trail's starting point changed significantly (implying a new leg)
    let shouldFetch = false;
    const firstPt = pts.length > 0 ? pts[0] : null;

    if (callsign && callsign !== trackerRouteCallsign) {
      shouldFetch = true;
      trackerRouteCallsign = callsign;
      trackerRouteTimestamp = trackData.timestamp;
      trackerRouteFirstPt = firstPt;
    } else if (callsign && firstPt && trackerRouteFirstPt) {
      // Calculate squared distance between new start point and cached start point
      const dLat = firstPt.lat - trackerRouteFirstPt.lat;
      const dLon = firstPt.lon - trackerRouteFirstPt.lon;
      const distSq = (dLat * dLat) + (dLon * dLon);
      
      // If the trail's physical start point moved by more than ~0.6 NM (0.01 degrees), the origin has changed!
      if (distSq > 0.0001) {
        shouldFetch = true;
        trackerRouteTimestamp = trackData.timestamp;
        trackerRouteFirstPt = firstPt;
      }
    }

    if (shouldFetch && !trackerRouteFetching) {
      trackerRouteInfo = null;
      trackerRouteFetching = true;
      renderRouteInfo(); // Show "loading" state immediately

      // Helper: enrich origin/destination with airport names via OurAirports
      async function enrichAirports(r) {
        if (r.origin && r.origin.icao && !r.origin.name) {
          var oRes = await bgRequest({ type: "GET_AIRPORT_NAME", ident: r.origin.icao }).catch(() => null);
          if (oRes && oRes.name) r.origin.name = oRes.name;
        }
        if (r.destination && r.destination.icao && !r.destination.name) {
          var dRes = await bgRequest({ type: "GET_AIRPORT_NAME", ident: r.destination.icao }).catch(() => null);
          if (dRes && dRes.name) r.destination.name = dRes.name;
        }
        return r;
      }

      // ── HYBRID APPROACH ──────────────────────────────────────────────────
      // Step 1: Get the ORIGIN from ADS-B trail (first GPS point → nearest airport).
      //         This is always correct because the trail physically starts where the plane took off.
      // Step 2: Pass that GPS origin to LOOKUP_ROUTE so FlightAware results are filtered
      //         to ONLY match flights departing from that airport.
      //         FlightAware gives us the DESTINATION (since the plane may not have arrived yet on ADS-B).
      // Step 3: If FlightAware fails entirely, fall back to GPS for both origin and destination.
      (async () => {
        try {
          // Step 1: Detect origin from ADS-B trail
          var gpsDet = await bgRequest({ type: "DETECT_ORIGIN_DEST_FROM_TRACK", points: pts }).catch(() => null);
          var gpsOriginIcao = (gpsDet && gpsDet.origin && gpsDet.origin.icao) ? gpsDet.origin.icao : null;

          // Step 2: Fetch FlightAware route, passing gpsOrigin to filter results
          var res = await bgRequest({
            type: "LOOKUP_ROUTE",
            callsign: callsign,
            registration: trackData.registration,
            timestamp: trackData.timestamp,
            gpsOrigin: gpsOriginIcao  // NEW: tells background.js to prefer flights from this origin
          }).catch(() => null);

          var r = (res && res.route) ? res.route : null;

          // If FlightAware returned a result, use it directly.
          // The GPS origin was already used by background.js to filter for the correct leg,
          // so FlightAware's origin+destination pair is already the right one.
          // Only fall back to GPS when FlightAware returned nothing.
          if (!r || (!r.origin && !r.destination)) {
            if (gpsOriginIcao || (gpsDet && gpsDet.destination)) {
              r = r || { callsign: callsign, airline: null, origin: null, destination: null };
              if (gpsOriginIcao) r.origin = { icao: gpsOriginIcao, iata: null, name: null, city: null };
              if (gpsDet && gpsDet.destination) r.destination = gpsDet.destination;
            }
          }

          if (!r || (!r.origin && !r.destination)) {
            trackerRouteFetching = false;
            trackerRouteInfo = null;
            renderRouteInfo();
            return;
          }

          r = await enrichAirports(r);
          trackerRouteFetching = false;
          trackerRouteInfo = r;
          renderRouteInfo();
        } catch (_) {
          trackerRouteFetching = false;
          trackerRouteInfo = null;
          renderRouteInfo();
        }
      })();
    }

    // Compute bounding box of path + 25NM padding
    const pathBbox = { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
    for (const pt of pts) {
      pathBbox.minLat = Math.min(pathBbox.minLat, pt.lat);
      pathBbox.maxLat = Math.max(pathBbox.maxLat, pt.lat);
      pathBbox.minLon = Math.min(pathBbox.minLon, pt.lon);
      pathBbox.maxLon = Math.max(pathBbox.maxLon, pt.lon);
    }
    const latPad = 25 / 60;
    const lonPad = 25 / (60 * Math.cos(((pathBbox.minLat + pathBbox.maxLat) / 2) * Math.PI / 180));
    pathBbox.minLat -= latPad; pathBbox.maxLat += latPad;
    pathBbox.minLon -= lonPad; pathBbox.maxLon += lonPad;

    // Only re-fetch data if bbox expanded beyond cached bbox
    if (!trackerBbox || pathBbox.minLat < trackerBbox.minLat || pathBbox.maxLat > trackerBbox.maxLat || pathBbox.minLon < trackerBbox.minLon || pathBbox.maxLon > trackerBbox.maxLon) {
      const eLat = 30 / 60;
      const eLon = 30 / (60 * Math.cos(((pathBbox.minLat + pathBbox.maxLat) / 2) * Math.PI / 180));
      trackerBbox = { minLat: pathBbox.minLat - eLat, maxLat: pathBbox.maxLat + eLat, minLon: pathBbox.minLon - eLon, maxLon: pathBbox.maxLon + eLon };

      try {
        const [res, mres, fres] = await Promise.all([
          bgRequest({ type: "GET_FIXES_IN_BBOX", ...trackerBbox, types: ["fix", "airport", "vor", "ndb"] }),
          bgRequest({ type: "GET_MOAS_IN_BBOX", ...trackerBbox }),
          bgRequest({ type: "GET_FBOS_IN_BBOX", ...trackerBbox })
        ]);

        const allPts = [];
        for (const f of (res.fixes || [])) {
          allPts.push({ ...f, searchStr: (f.ident + " " + (f.name || "")).toUpperCase() });
        }

        const mseen = new Set();
        for (const m of (mres.moas || [])) {
          if (mseen.has(m.name)) continue;
          mseen.add(m.name);
          allPts.push({
            type: "moa",
            ident: m.name.replace(/\s*MOA$/i, "").trim().toUpperCase(),
            name: m.name,
            lat: (m.bbox.minLat + m.bbox.maxLat) / 2,
            lon: (m.bbox.minLon + m.bbox.maxLon) / 2,
            searchStr: m.name.toUpperCase(),
            copyText: m.name.replace(/\s*MOA$/i, "").replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim().toLowerCase()
          });
        }

        for (const f of (fres.fbos || [])) {
          allPts.push({
            type: "fbo",
            ident: f.name.toUpperCase(),
            name: f.icao,
            lat: f.lat,
            lon: f.lon,
            searchStr: (f.name + " " + f.icao).toUpperCase(),
            copyText: f.name.toLowerCase()
          });
        }

        currentTrackerData.allPoints = allPts;
      } catch (err) {
        logMsg("[WPT] Tracker data fetch failed: " + err, true);
      }
    }

    if (!document.getElementById("sweden-tracker-panel")) return;

    // Categorize all points by cross-track distance
    const zones = { crossed: [], "5nm": [], "10nm": [], "15nm": [], "20nm": [] };
    for (const pt of currentTrackerData.allPoints) {
      // Quick bbox filter
      if (pt.lat < pathBbox.minLat || pt.lat > pathBbox.maxLat || pt.lon < pathBbox.minLon || pt.lon > pathBbox.maxLon) continue;

      let minDist = Infinity;
      let nearestSegIdx = 0;
      if (pts.length === 1) {
        minDist = haversineDistance(pts[0].lat, pts[0].lon, pt.lat, pt.lon);
        nearestSegIdx = 0;
      } else {
        for (let i = 0; i < pts.length - 1; i++) {
          const d = pointToSegmentDistance(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon, pt.lat, pt.lon);
          if (d < minDist) { minDist = d; nearestSegIdx = i; }
        }
      }

      pt.distance = minDist;
      pt.nearestSegIdx = nearestSegIdx;
      if (minDist <= 1.0) zones.crossed.push(pt);
      else if (minDist <= 5.0) zones["5nm"].push(pt);
      else if (minDist <= 10.0) zones["10nm"].push(pt);
      else if (minDist <= 15.0) zones["15nm"].push(pt);
      else if (minDist <= 20.0) zones["20nm"].push(pt);
    }

    // Deduplicate by ident within each category (keep highest nearestSegIdx = most recently visited)
    for (const k in zones) {
      const seen = {};
      const deduped = [];
      for (const pt of zones[k]) {
        const key = (pt.ident || "") + "|".concat(pt.type || "");
        if (!seen[key] || pt.nearestSegIdx > seen[key].nearestSegIdx) {
          seen[key] = pt;
        }
      }
      zones[k] = Object.values(seen);
    }

    // Sort each category: most recently visited first (highest segment index first)
    for (const k in zones) zones[k].sort((a, b) => b.nearestSegIdx - a.nearestSegIdx);
    currentTrackerData.zones = zones;
    renderTrackerResults();

    // Keep nearby airports modal in sync while open
    _nearbyScheduleRefresh(pts);
  }

  function getTrackerTypeColor(t) {
    if (t === "moa") return "rgba(230, 130, 255, 0.9)";
    if (t === "fbo") return "#DFFF00";
    if (t === "vor") return "#58a6ff";
    if (t === "ndb") return "#f85149";
    return Settings.fixColor || "#3fb950";
  }

  function trFuzzyScore(pt, q) {
    if (!q) return 0;
    var best = Math.max(soundScore(pt.ident || "", q), soundScore(pt.name || "", q));
    if (pt.searchStr && pt.searchStr.includes(q)) best = Math.max(best, 200);
    return best;
  }

  function buildTrackerItemHtml(pt) {
    let col = getTrackerTypeColor(pt.type);
    const rootProcs = getRootProcs(pt);
    if (Settings.hlProcs && rootProcs.length > 0) {
      col = rootProcs.some(p => p.type === 'SID') ? "#ff9e22" : "#00cfcf";
    }
    const dist = pt.distance != null ? pt.distance.toFixed(1) : "?";
    const displayIdent = (pt.type === "fbo") ? pt.ident : (pt.ident || "").toUpperCase();
    const procCopyText = getProcCopyText(pt);
    const copyVal = procCopyText ? procCopyText : (pt.copyText || (pt.type === "fbo" ? pt.ident.toLowerCase() : (pt.name || pt.ident || "").toUpperCase()));
    const latAttr = pt.lat != null ? ' data-lat="' + pt.lat + '"' : '';
    const lonAttr = pt.lon != null ? ' data-lon="' + pt.lon + '"' : '';
    let h = '<div class="tracker-item" data-color="' + col + '" data-cp="' + copyVal.replace(/"/g, "&quot;") + '" data-type="' + pt.type + '" data-ident="' + (pt.ident || "").toUpperCase().replace(/"/g, "&quot;") + '"' + latAttr + lonAttr + ' style="padding:6px 12px;border-bottom:1px solid #21262d;cursor:pointer;">';
    h += '<div style="display:flex;align-items:baseline;justify-content:space-between;">';
    h += '<div style="color:' + col + ';font-weight:bold;font-size:13px;">' + displayIdent;
    if (pt.name && pt.type !== "fbo") h += ' <span style="color:#8b949e;font-size:11px;font-weight:normal;">' + pt.name + '</span>';
    h += "</div>";
    h += '<div style="font-size:11px;color:#8b949e;">' + dist + ' NM</div>';
    h += "</div>";
    h += '<div style="font-size:10px;text-transform:uppercase;color:#484f58;margin-top:1px;">' + pt.type + "</div>";
    h += "</div>";
    return h;
  }

  function bindTrackerItemEvents(listCont) {
    if (listCont.dataset.eventsBound) return;
    listCont.dataset.eventsBound = "true";

    listCont.addEventListener("mouseover", function (e) {
      const r = e.target.closest(".tracker-item");
      if (r) {
        r.style.background = "#21262d";
        _highlightIdent = r.getAttribute("data-ident") || null;
      }
    });
    listCont.addEventListener("mouseout", function (e) {
      const r = e.target.closest(".tracker-item");
      if (r) {
        r.style.background = "";
        _highlightIdent = null;
      }
    });
    listCont.addEventListener("contextmenu", function (e) {
      const r = e.target.closest(".tracker-item");
      if (r) {
        e.preventDefault();
        e.stopPropagation();
        var lat = parseFloat(r.getAttribute("data-lat"));
        var lon = parseFloat(r.getAttribute("data-lon"));
        if (isNaN(lat) || isNaN(lon)) return;
        const map = getOLMap();
        if (map && window.ol) {
          map.getView().animate({ center: ol.proj.fromLonLat([lon, lat]), duration: 500, zoom: 11 });
        }
      }
    });
    listCont.addEventListener("click", function (e) {
      const r = e.target.closest(".tracker-item");
      if (r) {
        var cpText = r.getAttribute("data-cp");
        if (!cpText) return;
        navigator.clipboard.writeText(cpText).then(function () {
          var col = r.getAttribute("data-color") || getTrackerTypeColor(r.getAttribute("data-type"));
          var og = r.innerHTML;
          r.innerHTML = '<div style="color:' + col + ';text-align:center;padding:8px;font-weight:bold;font-size:13px;">Copied ' + cpText + '</div>';
          setTimeout(function () { r.innerHTML = og; }, 900);
        });
      }
    });
  }

  function renderTrackerResults() {
    const listCont = document.getElementById("tracker-list-cont");
    if (!listCont) return;

    const zoneLabels = [
      { key: "crossed", label: "Crossed (< 1 NM)" },
      { key: "5nm",     label: "< 5 NM" },
      { key: "10nm",    label: "< 10 NM" },
      { key: "15nm",    label: "< 15 NM" },
      { key: "20nm",    label: "< 20 NM" }
    ];

    const gq = globalTrackerQuery.trim().toUpperCase();

    let html = "";

    // ── Global search mode: flat unified list across all zones ──────────
    if (gq) {
      // Collect all non-MOA items from all categories, score, deduplicate by ident
      const seen = new Set();
      let scored = [];
      for (const c of zoneLabels) {
        for (const pt of (currentTrackerData.zones[c.key] || [])) {
          if (pt.type === "moa") continue;
          const key = (pt.ident || "") + "|" + (pt.type || "");
          if (seen.has(key)) continue;
          seen.add(key);
          const score = trFuzzyScore(pt, gq);
          if (score >= 60) scored.push({ pt: pt, score: score });
        }
      }
      scored.sort(function (a, b) { return b.score - a.score; });

      if (scored.length > 0) {
        html += '<div style="padding:6px 12px;background:#161b22;border-bottom:1px solid #30363d;font-size:11px;color:#8b949e;">Showing ' + scored.length + ' results across all zones</div>';
        for (const { pt } of scored) {
          html += buildTrackerItemHtml(pt);
        }
      } else {
        html += '<div style="padding:20px;text-align:center;color:#484f58;font-size:12px;">No results found</div>';
      }

      listCont.innerHTML = html;
      bindTrackerItemEvents(listCont);
      return;
    }

    // ── Normal mode: per-category accordions ─────────────────────────────────
    // Check if a zone search input is currently focused — if so, do a
    // surgical update of only that category's items list, keeping the input
    // element alive in the DOM so it never loses focus.
    const activeInput = document.activeElement;
    const typingInZone = activeInput && activeInput.classList.contains("sw-trk-zone-input")
      ? activeInput.getAttribute("data-zone")
      : null;

    if (typingInZone) {
      // Only rebuild the items container for the category being searched,
      // leave everything else (including the input) untouched.
      const itemsDiv = document.getElementById("sw-trk-items-" + typingInZone);
      if (itemsDiv) {
        const allItems = currentTrackerData.zones[typingInZone] || [];
        const cq = (zoneQueries[typingInZone] || "").trim().toUpperCase();
        let listItems = allItems.filter(function (i) { return i.type !== "moa"; });
        if (cq) {
          listItems = listItems.map(function (i) {
            return { item: i, score: trFuzzyScore(i, cq) };
          }).filter(function (x) { return x.score >= 60; })
            .sort(function (a, b) { return b.score - a.score; })
            .map(function (x) { return x.item; });
        }
        let itemsHtml = "";
        if (listItems.length > 0) {
          for (const pt of listItems) {
            itemsHtml += buildTrackerItemHtml(pt);
          }
        } else {
          itemsHtml = '<div style="padding:12px;font-size:12px;color:#484f58;text-align:center;">No results</div>';
        }
        itemsDiv.innerHTML = itemsHtml;

        // Also update the category header counts (without destroying them)
        for (const c of zoneLabels) {
          const hdrCountEl = listCont.querySelector('.tracker-zone-hdr[data-zone="' + c.key + '"] .sw-trk-count');
          if (hdrCountEl) {
            const cnt = (currentTrackerData.zones[c.key] || []).length;
            hdrCountEl.textContent = "(" + cnt + ")";
          }
        }
      }
      return;
    }

    // Full rebuild (no category input is focused)
    for (const c of zoneLabels) {
      const allItems = currentTrackerData.zones[c.key] || [];
      const cq = (zoneQueries[c.key] || "").trim().toUpperCase();

      // MOAs → header pills only
      const moaItems = allItems.filter(function (i) { return i.type === "moa"; });
      let listItems = allItems.filter(function (i) { return i.type !== "moa"; });

      // Per-zone fuzzy filter+sort
      if (cq) {
        listItems = listItems.map(function (i) {
          return { item: i, score: trFuzzyScore(i, cq) };
        }).filter(function (x) { return x.score >= 60; })
          .sort(function (a, b) { return b.score - a.score; })
          .map(function (x) { return x.item; });
      }

      const totalCnt = allItems.length;
      const isOpen = openZones[c.key];

      // MOA pills in header
      var moaPills = "";
      if (moaItems.length > 0) {
        var moaNames = moaItems.map(function (m) { return m.ident + " MOA"; }).join(", ");
        moaPills = '<div style="font-size:10px;color:rgba(230,130,255,0.85);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;" title="' + moaNames.replace(/"/g, '&quot;') + '">' + moaNames + '</div>';
      }

      html += '<div class="tracker-zone">';
      html += '<div class="tracker-zone-hdr' + (isOpen ? " open" : "") + '" data-zone="' + c.key + '" style="padding:6px 12px;background:#161b22;border-bottom:1px solid #30363d;cursor:pointer;display:flex;justify-content:space-between;align-items:flex-start;user-select:none;">';
      html += '<div>';
      html += '<div style="color:#c9d1d9;font-weight:bold;font-size:13px;">' + c.label + ' <span class="sw-trk-count" style="opacity:0.5;font-size:11px;margin-left:4px;">(' + totalCnt + ')</span></div>';
      html += moaPills;
      html += '</div>';
      html += '<span style="color:#8b949e;font-size:12px;margin-top:2px;">' + (isOpen ? "&#9660;" : "&#9654;") + '</span>';
      html += "</div>";

      if (isOpen) {
        html += '<div style="background:#0d1117;">';
        html += '<input type="text" class="sw-trk-zone-input" data-zone="' + c.key + '" placeholder="Search in ' + c.label + '..." value="' + (zoneQueries[c.key] || "").replace(/"/g, "&quot;") + '" style="width:100%;box-sizing:border-box;background:#0d1117;border:none;border-bottom:1px solid #21262d;color:#c9d1d9;padding:6px 12px;outline:none;font-size:12px;font-family:monospace;" />';

        html += '<div id="sw-trk-items-' + c.key + '">';
        if (listItems.length > 0) {
          for (const pt of listItems) {
            html += buildTrackerItemHtml(pt);
          }
        } else {
          html += '<div style="padding:12px;font-size:12px;color:#484f58;text-align:center;">No results</div>';
        }
        html += '</div>';
        html += "</div>";
      }
      html += "</div>";
    }

    listCont.innerHTML = html;

    // Bind events
    listCont.querySelectorAll(".tracker-zone-hdr").forEach(function (h) {
      h.onclick = function () {
        openZones[h.getAttribute("data-zone")] = !openZones[h.getAttribute("data-zone")];
        renderTrackerResults();
      };
    });

    listCont.querySelectorAll(".sw-trk-zone-input").forEach(function (inp) {
      inp.addEventListener("input", function () {
        zoneQueries[inp.getAttribute("data-zone")] = inp.value;
        renderTrackerResults();
      });
    });

    bindTrackerItemEvents(listCont);
  }

  function renderRouteInfo() {
    var el = document.getElementById("sweden-trk-route");
    if (!el) return;

    if (trackerRouteFetching) {
      el.innerHTML = '<div style="padding:8px 14px;font-size:11px;color:#484f58;display:flex;align-items:center;gap:6px;">'
        + '<span style="display:inline-block;width:12px;height:12px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:sw-trk-spin 0.8s linear infinite;"></span>'
        + 'Looking up route...</div>';
      el.style.display = "block";
      return;
    }

    if (!trackerRouteInfo) {
      // No route data — either no callsign, or lookup returned nothing
      if (trackerRouteCallsign) {
        el.innerHTML = '<div style="padding:6px 14px;font-size:10px;color:#484f58;">No route data for ' + trackerRouteCallsign + '</div>';
        el.style.display = "block";
      } else {
        el.innerHTML = '';
        el.style.display = "none";
      }
      return;
    }

    var r = trackerRouteInfo;
    var h = '';

    // Airline / callsign row
    if (r.airline && r.airline.name) {
      var airlineRadio = r.airline.callsign ? ' (' + r.airline.callsign + ')' : '';
      h += '<div style="display:flex;align-items:center;gap:6px;padding:8px 14px 4px;">'
        + '<span style="font-size:14px;color:#58a6ff;">✈</span>'
        + '<span style="color:#e6edf3;font-weight:700;font-size:13px;background:rgba(88,166,255,0.15);border:1px solid rgba(88,166,255,0.3);padding:2px 8px;border-radius:4px;letter-spacing:0.5px;">' + r.airline.name + '</span>'
        + '<span style="color:#8b949e;font-size:10px;margin-left:2px;">' + airlineRadio + '</span>'
        + '</div>';
    } else if (r.callsign) {
      h += '<div style="display:flex;align-items:center;gap:6px;padding:8px 14px 4px;">'
        + '<span style="font-size:14px;color:#58a6ff;">✈</span>'
        + '<span style="color:#e6edf3;font-weight:700;font-size:13px;background:rgba(88,166,255,0.15);border:1px solid rgba(88,166,255,0.3);padding:2px 8px;border-radius:4px;letter-spacing:0.5px;">' + r.callsign + '</span>'
        + '</div>';
    }

    // Origin → Destination row
    if (r.origin && r.destination) {
      var oIcao = r.origin.icao || '????';
      var oIata = r.origin.iata ? ' (' + r.origin.iata + ')' : '';
      var dIcao = r.destination.icao || '????';
      var dIata = r.destination.iata ? ' (' + r.destination.iata + ')' : '';
      var oCity = r.origin.city || r.origin.name || '';
      var dCity = r.destination.city || r.destination.name || '';

      var oAirnavUrl = 'https://www.airnav.com/airport/' + oIcao;
      var dAirnavUrl = 'https://www.airnav.com/airport/' + dIcao;
      var oName = r.origin.name || '';
      var dName = r.destination.name || '';
      h += '<div style="padding:2px 14px 6px;display:flex;align-items:flex-start;gap:6px;">'
        + '<div style="display:flex;flex-direction:column;align-items:center;min-width:0;flex:1;">'
        + '<a href="' + oAirnavUrl + '" target="_blank" rel="noopener" style="color:#3fb950;font-weight:bold;font-size:14px;font-family:monospace;text-decoration:none;border-bottom:1px dashed #3fb95066;" title="Open on AirNav">' + oIcao + '<span style="color:#8b949e;font-size:10px;font-weight:normal;">' + oIata + '</span></a>'
        + '<span style="color:#c9d1d9;font-size:11px;margin-top:3px;text-align:center;white-space:normal;word-break:break-word;max-width:130px;line-height:1.3;">' + (oName || '<span style="color:#484f58;font-style:italic;">name unavailable</span>') + '</span>'
        + '</div>'
        + '<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;padding-top:2px;">'
        + '<span style="color:#58a6ff;font-size:14px;letter-spacing:2px;">──▶</span>'
        + '</div>'
        + '<div style="display:flex;flex-direction:column;align-items:center;min-width:0;flex:1;">'
        + '<a href="' + dAirnavUrl + '" target="_blank" rel="noopener" style="color:#f85149;font-weight:bold;font-size:14px;font-family:monospace;text-decoration:none;border-bottom:1px dashed #f8514966;" title="Open on AirNav">' + dIcao + '<span style="color:#8b949e;font-size:10px;font-weight:normal;">' + dIata + '</span></a>'
        + '<span style="color:#c9d1d9;font-size:11px;margin-top:3px;text-align:center;white-space:normal;word-break:break-word;max-width:130px;line-height:1.3;">' + (dName || '<span style="color:#484f58;font-style:italic;">name unavailable</span>') + '</span>'
        + '</div>'
        + '</div>';
    }

    // Nearby Airports button — show whenever we have any route info
    h += '<div style="text-align:center;padding:2px 14px 8px;">'
      + '<button id="sweden-trk-nearby-btn" style="background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.35);color:#3fb950;padding:4px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;font-family:monospace;letter-spacing:0.5px;transition:background 0.15s;">'
      + 'Nearby Airports</button>'
      + '</div>';

    el.innerHTML = h;
    el.style.display = h ? "block" : "none";

    // Bind nearby airports button
    var nearbyBtn = document.getElementById("sweden-trk-nearby-btn");
    if (nearbyBtn) {
      nearbyBtn.addEventListener("mouseover", function () { nearbyBtn.style.background = "rgba(63,185,80,0.25)"; });
      nearbyBtn.addEventListener("mouseout", function () { nearbyBtn.style.background = "rgba(63,185,80,0.12)"; });
      nearbyBtn.addEventListener("click", function (e) { e.stopPropagation(); openNearbyAirportsModal(); });
    }
  }

  // ── Nearby Airports Modal ─────────────────────────────────────────────────
  let _nearbyAirports = [];       // cached result from background
  let _nearbyFetching = false;
  let _nearbyQuery = "";
  let _nearbyFetchTimer = null;   // guards real-time refresh
  let _nearbyLastFetch = 0;       // timestamp of last successful fetch

  function _nearbyScheduleRefresh(pts) {
    if (!document.getElementById("sweden-nearby-modal")) return; // modal not open
    if (_nearbyFetching) return;                                  // already in flight
    var now = Date.now();
    if (now - _nearbyLastFetch < 3000) return;                    // throttle: once per 3 s
    _nearbyLastFetch = now;
    _nearbyFetching = true;
    // Do not call renderNearbyList() here to avoid flashing the spinner

    bgRequest({ type: "GET_NEARBY_AIRPORTS", points: pts, maxNm: 100 }, 30000)
      .then(function (res) {
        _nearbyAirports = (res && res.airports) || [];
        _nearbyFetching = false;
        renderNearbyList();
      })
      .catch(function () {
        _nearbyFetching = false;
        renderNearbyList();
      });
  }

  function openNearbyAirportsModal() {
    // Remove if already open
    var existing = document.getElementById("sweden-nearby-modal");
    if (existing) { existing.remove(); return; }

    var trackData = extractPlaneTrack();
    if (!trackData || trackData.pts.length < 1) return;

    // Create modal
    var modal = document.createElement("div");
    modal.id = "sweden-nearby-modal";
    modal.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:380px;max-height:70vh;background:#0d1117;border:1px solid #30363d;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,0.7);z-index:10002;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,monospace;";

    modal.innerHTML = '<div id="sweden-nearby-drag" style="padding:10px 14px;background:#161b22;border-bottom:1px solid #30363d;border-radius:10px 10px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move;">'
      + '<span style="color:#c9d1d9;font-weight:bold;font-size:13px;">Nearby Airports (&lt; 100 NM)</span>'
      + '<span id="sweden-nearby-close" style="color:#8b949e;cursor:pointer;font-size:18px;line-height:1;">&times;</span>'
      + '</div>'
      + '<div style="padding:8px 12px;border-bottom:1px solid #30363d;">'
      + '<input type="text" id="sweden-nearby-search" placeholder="Search airports..." style="width:100%;box-sizing:border-box;background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:4px;outline:none;font-size:12px;font-family:monospace;" />'
      + '<div style="font-size:10px;color:#484f58;margin-top:5px;text-align:center;">🖱 Left-click: pan camera &nbsp;·&nbsp; Right-click: open AirNav</div>'
      + '</div>'
      + '<div id="sweden-nearby-list" style="flex:1;overflow-y:auto;background:#0d1117;"></div>';

    // Add scrollbar + hover styles
    if (!document.getElementById("sw-nearby-css")) {
      var st = document.createElement("style");
      st.id = "sw-nearby-css";
      st.textContent = "#sweden-nearby-list::-webkit-scrollbar{width:4px}#sweden-nearby-list::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px}.sw-nearby-item:hover{background:#161b22!important}";
      document.head.appendChild(st);
    }

    document.body.appendChild(modal);

    // Draggable
    var dh = modal.querySelector("#sweden-nearby-drag");
    var isDrag = false, ofx = 0, ofy = 0;
    dh.addEventListener("mousedown", function (e) {
      isDrag = true;
      ofx = e.clientX - modal.getBoundingClientRect().left;
      ofy = e.clientY - modal.getBoundingClientRect().top;
    });
    window.addEventListener("mousemove", function (e) {
      if (!isDrag) return;
      modal.style.left = e.clientX - ofx + modal.offsetWidth / 2 + "px";
      modal.style.top = e.clientY - ofy + modal.offsetHeight / 2 + "px";
    });
    window.addEventListener("mouseup", function () { isDrag = false; });

    // Close
    modal.querySelector("#sweden-nearby-close").onclick = function () { modal.remove(); };

    // Block ADS-B keyboard shortcuts inside modal
    function blockKeys(e) {
      if (e.target && e.target.closest && e.target.closest("#sweden-nearby-modal")) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", blockKeys, true);
    window.addEventListener("keyup", blockKeys, true);
    window.addEventListener("keypress", blockKeys, true);

    // Search input
    modal.querySelector("#sweden-nearby-search").addEventListener("input", function (e) {
      _nearbyQuery = e.target.value.trim().toUpperCase();
      renderNearbyList();
    });

    // Delegated click: left = pan camera, right = open AirNav
    var listEl = modal.querySelector("#sweden-nearby-list");
    
    listEl.addEventListener("mouseover", function (e) {
      var item = e.target.closest(".sw-nearby-item");
      if (item) {
        var icaoEl = item.querySelector(".sw-nearby-icao");
        if (icaoEl) _highlightIdent = icaoEl.getAttribute("data-icao") || null;
      }
    });
    listEl.addEventListener("mouseout", function (e) {
      var item = e.target.closest(".sw-nearby-item");
      if (item) _highlightIdent = null;
    });

    listEl.addEventListener("click", function (e) {
      var item = e.target.closest(".sw-nearby-item");
      if (!item) return;

      // Pan camera (using fallback logic from normal search, since window.OLMap is blocked in content script)
      var lat = parseFloat(item.getAttribute("data-lat"));
      var lon = parseFloat(item.getAttribute("data-lon"));
      if (!isNaN(lat) && !isNaN(lon)) {
        if (typeof setCenterByLatLon === "function") {
          setCenterByLatLon(lat, lon);
        } else {
          var map = getOLMap();
          if (map && window.ol) {
            map.getView().animate({ center: window.ol.proj.fromLonLat([lon, lat]), duration: 500, zoom: 12 });
          }
        }
      }
    });
    listEl.addEventListener("contextmenu", function (e) {
      var item = e.target.closest(".sw-nearby-item");
      if (!item) return;
      e.preventDefault();
      var url = item.getAttribute("data-url");
      if (url) window.open(url, "_blank");
    });

    // Initial fetch — reset last-fetch time so subsequent auto-refreshes aren't blocked
    _nearbyLastFetch = 0;
    _nearbyFetching = true;
    _nearbyAirports = [];
    _nearbyQuery = "";
    renderNearbyList();

    bgRequest({ type: "GET_NEARBY_AIRPORTS", points: trackData.pts, maxNm: 100 }, 30000)
      .then(function (res) {
        _nearbyAirports = (res && res.airports) || [];
        _nearbyFetching = false;
        _nearbyLastFetch = Date.now(); // start the 10s throttle clock after first fetch
        renderNearbyList();
      })
      .catch(function () {
        _nearbyFetching = false;
        _nearbyAirports = [];
        renderNearbyList();
      });
  }

  function renderNearbyList() {
    var listEl = document.getElementById("sweden-nearby-list");
    if (!listEl) return;

    if (_nearbyFetching && _nearbyAirports.length === 0) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#484f58;font-size:12px;display:flex;align-items:center;justify-content:center;gap:6px;">'
        + '<span style="display:inline-block;width:12px;height:12px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:sw-trk-spin 0.8s linear infinite;"></span>'
        + 'Scanning nearby airports...</div>';
      return;
    }

    var items = _nearbyAirports;

    // Fuzzy filter
    if (_nearbyQuery) {
      items = items.map(function (a) {
        var q = _nearbyQuery;
        var nameClean = (a.name || "").toUpperCase().replace(/[^A-Z ]/g, "");
        // Score against whole fields
        var s = Math.max(
          soundScore(a.icao, q),
          soundScore(nameClean, q),
          soundScore((a.city || "").toUpperCase(), q)
        );
        // Score against each word of the name individually (catches "DeKalb" from "DeKalb Taylor Municipal")
        var words = nameClean.split(" ");
        for (var wi = 0; wi < words.length; wi++) {
          if (words[wi].length >= 3) s = Math.max(s, soundScore(words[wi], q));
        }
        // Exact / substring boosts
        if ((a.icao || "").includes(q)) s = Math.max(s, 250);
        if (nameClean.includes(q)) s = Math.max(s, 200);
        if ((a.city || "").toUpperCase().includes(q)) s = Math.max(s, 160);
        if (a.iata && a.iata.toUpperCase() === q) s = Math.max(s, 300);
        return { apt: a, score: s };
      }).filter(function (x) { return x.score >= 50; })
        .sort(function (a, b) { return b.score - a.score; })
        .map(function (x) { return x.apt; });
    }

    if (items.length === 0) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#484f58;font-size:12px;">' + (_nearbyQuery ? "No airports match your search" : "No airports found nearby") + '</div>';
      return;
    }

    var h = '<div style="padding:4px 12px;font-size:10px;color:#484f58;border-bottom:1px solid #21262d;">' + items.length + ' airport' + (items.length !== 1 ? 's' : '') + ' found</div>';
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var typeLabel = a.type === 'large_airport' ? 'LRG' : a.type === 'medium_airport' ? 'MED' : 'SML';
      var typeColor = a.type === 'large_airport' ? '#58a6ff' : a.type === 'medium_airport' ? '#3fb950' : '#8b949e';
      var iataStr = a.iata ? ' (' + a.iata + ')' : '';
      var url = 'https://www.airnav.com/airport/' + a.icao;
      h += '<div class="sw-nearby-item" data-url="' + url + '" data-lat="' + a.lat + '" data-lon="' + a.lon + '" style="display:block;padding:8px 12px;border-bottom:1px solid #21262d;cursor:pointer;transition:background 0.1s;">'
        + '<div style="display:flex;align-items:baseline;justify-content:space-between;">'
        + '<div style="display:flex;align-items:baseline;gap:6px;min-width:0;flex:1;">'
        + '<span class="sw-nearby-icao" data-icao="' + a.icao + '" data-name="' + (a.name || "").replace(/"/g, '&quot;') + '" style="color:#FED8B1;font-weight:bold;font-size:13px;font-family:monospace;flex-shrink:0;">' + a.icao + '</span>'
        + '<span style="color:#8b949e;font-size:10px;flex-shrink:0;">' + iataStr + '</span>'
        + '<span style="color:#c9d1d9;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + a.name + '</span>'
        + '</div>'
        + '<span style="color:' + typeColor + ';font-size:9px;font-weight:600;padding:1px 4px;border:1px solid ' + typeColor + '44;border-radius:3px;margin-left:6px;flex-shrink:0;">' + typeLabel + '</span>'
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;margin-top:2px;">'
        + '<span style="font-size:10px;color:#484f58;">' + (a.city || '') + '</span>'
        + '<span style="font-size:11px;color:#8b949e;font-weight:600;">' + a.distance + ' NM</span>'
        + '</div>'
        + '</div>';
    }
    listEl.innerHTML = h;
  }

  function toggleTrackerPanel() {
    var p = document.getElementById("sweden-tracker-panel");
    if (p) {
      p.remove();
      if (trackerUpdateInterval) clearInterval(trackerUpdateInterval);
      trackerUpdateInterval = null;
      return;
    }

    p = document.createElement("div");
    p.id = "sweden-tracker-panel";
    p.style.cssText = "position:fixed;top:60px;right:20px;width:340px;height:calc(100vh - 100px);background:#0d1117;border:1px solid #30363d;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:10001;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,monospace;";

    p.innerHTML = '<div id="sweden-trk-drag" style="padding:10px 14px;background:#161b22;border-bottom:1px solid #30363d;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move;">'
      + '<span style="color:#c9d1d9;font-weight:bold;font-size:14px;">Sweden Tracker</span>'
      + '<span id="sweden-trk-close" style="color:#8b949e;cursor:pointer;font-size:18px;line-height:1;">&times;</span>'
      + '</div>'
      + '<div id="sweden-trk-route" style="display:none;border-bottom:1px solid #30363d;background:#161b22;"></div>'
      + '<div style="padding:8px 12px 4px;border-bottom:1px solid #30363d;">'
      + '<input type="text" id="sweden-trk-global" placeholder="Search ALL zones..." style="width:100%;box-sizing:border-box;background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:4px;outline:none;font-size:12px;font-family:monospace;" />'
      + '<div style="font-size:10px;color:#484f58;margin-top:4px;margin-bottom:2px;">&#9658; Left-click to copy &nbsp;&nbsp; Right-click to fly to point</div>'
      + '</div>'
      + '<div id="tracker-list-cont" style="flex:1;overflow-y:auto;background:#0d1117;"></div>';

    // Add scrollbar style
    if (!document.getElementById("sw-trk-scroll-css")) {
      var st = document.createElement("style");
      st.id = "sw-trk-scroll-css";
      st.textContent = "#tracker-list-cont::-webkit-scrollbar{width:4px}#tracker-list-cont::-webkit-scrorack{background:transparent}#tracker-list-cont::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px}@keyframes sw-trk-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(st);
    }

    document.body.appendChild(p);

    // Draggable header
    var dHeader = p.querySelector("#sweden-trk-drag");
    var isDrag = false, ofx = 0, ofy = 0;
    dHeader.addEventListener("mousedown", function (e) {
      isDrag = true;
      ofx = e.clientX - p.getBoundingClientRect().left;
      ofy = e.clientY - p.getBoundingClientRect().top;
    });
    window.addEventListener("mousemove", function (e) {
      if (!isDrag) return;
      p.style.left = (e.clientX - ofx) + "px";
      p.style.top = (e.clientY - ofy) + "px";
      p.style.right = "auto";
    });
    window.addEventListener("mouseup", function () { isDrag = false; });

    p.querySelector("#sweden-trk-close").onclick = toggleTrackerPanel;

    p.querySelector("#sweden-trk-global").addEventListener("input", function (e) {
      globalTrackerQuery = e.target.value;
      renderTrackerResults();
    });

    // Stop ADS-B keyboard shortcuts from firing when typing in tracker inputs
    // Must use window-level capture phase listeners to guarantee we run first
    function blockKeysInTracker(e) {
      if (e.target && e.target.closest && e.target.closest("#sweden-tracker-panel")) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", blockKeysInTracker, true);
    window.addEventListener("keyup", blockKeysInTracker, true);
    window.addEventListener("keypress", blockKeysInTracker, true);

    // Reset state
    trackerBbox = null;
    globalTrackerQuery = "";
    zoneQueries = { crossed: "", "5nm": "", "10nm": "", "15nm": "", "20nm": "" };
    currentTrackerData = { allPoints: [], zones: { crossed: [], "5nm": [], "10nm": [], "15nm": [], "20nm": [] } };
    trackerRouteInfo = null;
    trackerRouteCallsign = "";
    trackerRouteFetching = false;

    // First load + interval
    updateTrackerData();
    trackerUpdateInterval = setInterval(updateTrackerData, 2000);
  }

  // ── Sidebar Button Injector ───────────────────────────────────────────────
  function pollForSidebar() {
    var closeBtn = document.getElementById("infoblock_close");
    if (!closeBtn) return;
    if (document.getElementById("sweden-tracker-btn")) return;

    var btn = document.createElement("div");
    btn.id = "sweden-tracker-btn";
    btn.title = "Sweden Tracker";
    btn.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAbZQTFRFAAAA5Obk8ujx7ebupN2jr+Wo7+jv7eburdyvTNFJEMMND8oNRMxIsN2w7ubv7ufv8efwwOS7WdhSKNoXGtIQG8EaHssbCr4LEMYPYN9VuN648erwXtdgJtEWFcgPJdMdKNEeJc0cIM4bI8ceIMobGM8QGMISYcZfH7oaE8MUKNAeH8wZH8wYHsoYJM0cJNQbJtYcGr0ZCKANEn0PfG1EMowYGZkUIdMaJM8bItIaJMocF7gUEJ0RG6sVK2YQVUEnn2ZJhVw1V04iKK0YG8AXBbcPELQSEYINKEgOKVERWjkjgk84oXFLnGlHilM4YU0kW14pKnUTMGoZQVUYWjEcbjwmc0QocEkwmWlIjlo2hFQ0mGA+lVs+gkkwbj4pfEo1bEIockYoe0wtdlM9iFk7omxEkmA9jFw6kmA6lWI8gFIxckksXDUgdksvbEAmils7n3NWhVEtmmVAk2VFm2ZAkGBAdkcrf08vglQ2Zj4mYzIVhl9H5uPgxKyaiGFJj1cvglAwk2REcUQqbUIobDsehVo9sJuP4uLhxq2amGhInWI3aTkbeFE5pJaP5ePgtJ2OsZqM7fHzKAwiSwAAAJJ0Uk5TAAE/YP//XjPZ//////9vLT8/xv/////////lKf///////////////////////////////////////////////////////////////////////////////////////////////////////////////9v/////////////vwHy///////////WB8/////6sRS8tAVjSOBjAAAAaUlEQVR4nGNkQAOMYAIMfiEE2Bmh4CNYQIARAZ6CBGSQBG6CBDSQBM6CBEyQBA6CBByQBLaCBHyQBFaCBCKQBOaCBFKQBCaCBAqQBFpBAjUIfhXU6e0QbjHcLwwMfYyMBUi+BYGJ+RAaAF3aDxHvilNWAAAAAElFTkSuQmCC" style="width:16px;height:16px;pointer-events:none;" />';
    // Precision layout based on X button's physical coordinates (left: 160px, width: 20px, top: 8px)
    btn.style.cssText = "position:absolute;top:6px;right:46px;display:flex;align-items:center;justify-content:center;width:22px;height:22px;cursor:pointer;border-radius:4px;background:rgba(22, 27, 34, 0.9);border:1px solid rgba(255,255,255,0.2);transition:background 0.15s;z-index:20;";
    btn.addEventListener("mouseover", function () { btn.style.background = "rgba(48, 54, 61, 0.9)"; });
    btn.addEventListener("mouseout", function () { btn.style.background = "rgba(22, 27, 34, 0.9)"; });
    btn.addEventListener("click", function (e) { e.stopPropagation(); toggleTrackerPanel(); });

    closeBtn.parentNode.appendChild(btn);
  }

  setInterval(pollForSidebar, 1000);

})();