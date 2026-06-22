# ADS-B Exchange Waypoints Finder

An ADS-B Exchange browser extension that overlays flight waypoints, fixes, VORs, and NDBs directly on the map. Built for aviation enthusiasts and flight tracking, it provides powerful search, area selection, and interactive map tools.

## Features

### Map Overlay
- **Waypoint Types**: Visual markers for aviation fixes, intersections, VORs, and NDBs — each with distinct color coding.
- **High Performance**: Canvas-based rendering synced with the OpenLayers map during zoom and pan.
- **Auto-Loading**: Waypoints load automatically based on the visible map area.

### Interactive Map
- **Hover Tooltips**: Hover over any marker to see identifier, name, type, and coordinates. Dark-color labels automatically appear in white for readability.
- **Click to Copy**: Click any waypoint marker to instantly copy its identifier to the clipboard.

### Search Waypoint (3 Modes)
- **All Available**: Search across the entire waypoint database.
- **Current View**: Search only within the currently visible map area.
- **Airport (ICAO)**: Enter an airport ICAO code (e.g., KLAX) to load all waypoints associated with that airport, then search within them.

### Search Airport (2 Modes)
- Toggle the popup search to **Airports** to search the bundled `airports.csv` dataset by airport code or name.
- **All Available** searches the full airport dataset; **Current View** limits results to the visible map area.

All search modes use the **advanced fuzzy search algorithm**, which combines:
- Position-aware sound similarity (phonetic matching)
- Consonant skeleton comparison
- Levenshtein edit distance
- Fuzzy subsequence matching
- Literal prefix/substring matching

### Area Selection Tool
Select an area on the map to find all waypoints within it. Three selection modes:
- **Rectangle**: Click and drag to draw a rectangular selection area.
- **Free Select**: Click to place polygon vertices, double-click to complete the shape.
- **Circle**: Click and drag — the start and end points define the circle's diameter.

The system remembers the last used selection mode. Results appear in a floating panel with:
- Waypoint list with color-coded type indicators
- Search bar to filter results using the same fuzzy search algorithm
- Copy individual waypoints or copy all at once
- Start a new selection directly from the results panel

### Visual Settings
- **Fix/Waypoint Color**: Customize marker dot color with a color picker.
- **Label Text Color**: Customize label color, or link it to match the waypoint color.
- **Label Size**: Adjustable label font size (6–20).
- **Scale Dots by Zoom**: Optionally scale marker size with zoom level.
- **Opacity**: Adjustable overlay opacity (10–100%).

### Quick-Access Button
- A draggable "ADSB Waypoints Settings" button appears on the map for quick access to the extension popup.
- Drag to reposition (position is saved across sessions).
- Auto-hides when the popup, area selection overlay, or results panel are active.
- Can be toggled on/off in settings.

## Installation

1. Download or clone this repository.
2. Open Chrome (or any Chromium-based browser) and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the appropriate extension folder:
   - `Sweden/` for Windows
   - `_MACOSX/` for macOS
5. Navigate to [ADS-B Exchange Globe](https://globe.adsbexchange.com/) and the overlay will activate automatically.

## Usage

1. Navigate to [ADS-B Exchange Globe](https://globe.adsbexchange.com/).
2. Click the extension icon in your browser toolbar to open the settings popup.
3. Toggle the overlay on/off and choose which waypoint types to display.
4. Use the search box to find specific waypoints — switch between All Available, Current View, or Airport search modes.
5. Use the **Select Area on Map** button to draw a shape and discover all waypoints within it.
6. Click any waypoint on the map or in search results to copy its name to your clipboard.

## Data Source

Uses FAA CIFP (Coded Instrument Flight Procedures) data, compressed with fflate for efficient client-side decompression.

## Development

This extension is built with:
- **Manifest V3** for modern browser compatibility.
- **Vanilla JavaScript** for injection and rendering.
- **fflate** for efficient client-side decompression of aviation data.
- **OpenLayers** integration for seamless map synchronization.
- **Canvas API** for high-performance waypoint rendering and area selection drawing.
