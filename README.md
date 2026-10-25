# CellSim: mobile cellular network simulator on OpenStreetMap

**Live demo:** https://yurii-shkoropad.github.io/cell-sim/

A browser-only simulator for 2G/4G/5G radio networks. You place and configure base stations on an
OpenStreetMap map. The app computes coverage, best-server, SINR and throughput maps, then simulates
users moving along real streets with voice and data sessions, cell selection, handovers, radio link
failures and capacity limits. Live KPIs, charts and an event log show the results.

It has no backend: the radio maths runs in the browser, and heatmaps are computed in a Web Worker.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests for the radio models, engine, planning and import
npm run build      # static bundle in dist/ (relative paths, so any static host works)
```

The app opens on the **Lviv Polytechnic** demo scenario. The demo area also ships OSM building footprints
and heights (`public/buildings/lviv-polytechnic.json`) for the building-aware path-loss model. It has three operators, LTE 1800 hex grids,
a GSM 900 layer with 4/12 reuse and an NR 3500 site. The road network for that area ships with the
app (`public/roads/lviv-polytechnic.json`, © OpenStreetMap contributors, ODbL). Anywhere else, roads
are fetched live from Overpass (Users → *Load OSM roads for current view*). The public Overpass
servers are often slow, so a request can take a minute. If it fails, users move by random waypoint.

The scenario is saved in browser storage automatically. Use Import/Export to save it as a JSON file.

For scripted experiments, the browser console exposes the running app as `window.cellsim`.
For example, `cellsim.engine.step()`, `cellsim.engine.counters`, `cellsim.engine.log.events` and
`cellsim.store.scenario` are all available.

## What you can configure

**Per base station:** technology (GSM/LTE/NR), template (GSM900/1800, LTE B20/B3/B1/B7, NR n78/n28),
bandwidth, antenna / MIMO type (SISO, 2×2, 4×4, 8T8R, massive MIMO 32T32R / 64T64R), max modulation
(QPSK … 256QAM, 1024QAM for NR), transmit power,
antenna height, feeder loss, TRX count (GSM), maximum active users, position, and on-air state.

**Per sector:** azimuth, horizontal and vertical beamwidth, tilt, gain, front-to-back ratio, carrier
frequency (the ARFCN, EARFCN or NR-ARFCN is shown), PCI or BSIC, and on/off.

**Operators:** name, PLMN (MCC-MNC, used to match imported data), colour and subscriber share.

**Placement:** *Add sites on map* enters edit mode, shown by a banner and a frame around the map. Click to add sites and drag sites to move them; *Done* or Esc finishes. Edit mode also ends when you switch tabs, open a user, or click an existing site. Outside edit mode, sites can't be dragged by accident. Generate a hex grid
(rings, inter-site distance, azimuth offset) or scatter random sites. You can also import:
- **OpenCelliD CSV:** LTE is grouped by eNB ID, NR by gNB ID and GSM by proximity. Azimuths are
  derived from the cell position estimates.
- **OSM towers:** masts and towers tagged for communication, via Overpass.
- **Scenario JSON.**

**Users:** every user is saved in the scenario with its start position, operator, device (RATs,
receive antennas), mobility (static, pedestrian or vehicle), traffic and demand. The **Users** tab has:
- a list of all users with live state, serving cell and throughput. Click a row to open the user;
  **×** deletes it.
- filters (text, operator, mobility, state), multi-select (selected users are highlighted on the map)
  and batch editing of operator, mobility, traffic, antennas, devices and demand, plus starting or
  ending sessions and deleting the selection.
- **Add users** from a template, either as a batch in the current view, in a rectangle or circle
  picked on the map, or one at a time by clicking.

**Reset** restarts the simulation with the same users. Global settings cover the speed ranges,
default antennas, and the Poisson traffic rates for users with random traffic.

**Radio:** environment (urban large/medium, suburban, rural), path-loss model, UE height, noise
figure, shadowing σ and decorrelation distance, interferer-load model, Shannon parameters, and
per-RAT mobility thresholds (min level, A3 offset, hysteresis, TTT, B2, Qout, T310, priority).

## Inspecting the network

- **Station inspector:** click a site on the map or in the station list.
  - *Overview* (live): site totals (users, served versus demanded throughput, mean SINR, cell-edge users, handovers, drops and blocks); per-sector PRB/TCH utilisation, throughput, SINR and MU-MIMO gain; the connected users (level, SINR, layers, modulation, throughput); and recent events. Lines on the map join the site to its users.
  - *Configure:* every station and sector parameter, plus the vertical-beam side view.
- **User inspector:** click a user. It shows live radio state and lets you edit the user, and its serving cell links back to the station.

Only one inspector is open at a time.

## Outputs

- **Map layers:** signal level (RSRP or RxLev), best server, SINR, peak DL throughput, and modulation reached. Each can
  be filtered by operator and RAT, with a hover readout. Further overlays show sectors, users
  (coloured by state), user-to-cell links and the road graph.
- **KPI tiles:** coverage, handover success, ping-pong, drop rate, block rate, mean and cell-edge
  throughput, mean SINR, and fairness (Jain's index).
- **Charts:** active sessions, users by serving RAT, throughput, mean SINR, an event timeline
  (10 s buckets), the most loaded cells and the SINR CDF.
- **Event log:** handovers (intra and inter-RAT), handover failures, ping-pongs, drops, blocks and
  session start/end. Each event can be filtered, and clicking one locates it on the map.
- **Planning check:** PCI collision, confusion and mod-3 conflicts; GSM co-channel and
  adjacent-channel BCCH reuse; spectrum overlap between operators; parameter ranges; and Hata
  validity warnings. There is also auto PCI and auto GSM BCCH assignment.

## Models

The **Models** tab in the app has the full formulas. In short:

| Area | Model |
|---|---|
| Path loss | Okumura-Hata (≤1500 MHz) / COST-231 Hata (>1500 MHz), with environment corrections and a free-space floor; or **COST-231 Walfisch–Ikegami on OSM buildings** |
| Buildings | Footprints and heights (`height`, `building:levels`, type) rasterised at 3 m; 720 rays per site up to 4 km; exact LOS test, rooftop-to-street and multi-screen diffraction from actual roof heights and spacing; ITU-R P.2109 building entry loss for indoor UEs |
| Antenna | 3GPP TR 36.814 parabolic horizontal and vertical pattern, with tilt and front-to-back limit |
| Shadowing | Log-normal truncated at ±3σ, spatially correlated (lattice at the decorrelation distance, per site) |
| SINR | Wideband, spectrum-overlap weighted, load weighted; thermal noise is kTB + NF |
| Throughput | Truncated Shannon (3GPP TR 36.942) per layer, per-RB rate × RBs |
| Modulation | Per-station max (QPSK/16/64/256/1024QAM) caps per-layer SE at the 3GPP CQI table maxima |
| Antennas / MIMO | SISO, 2T2R, 4T4R, 8T8R, massive MIMO 32T32R/64T64R: beamforming gain, rank adaptation (power split, Rx combining, precoding gain), MU-MIMO pairing |
| Scheduler | GBR voice first, then a selectable data scheduler: Round Robin, Proportional Fair (analytical multi-user diversity gain), Max C/I, or equal throughput (max-min); global with per-station override. GSM uses TCH timeslots (8·TRX − 2) |
| Mobility | Idle selection by RAT priority; A3 intra-RAT and B2 inter-RAT handover with TTT; RLF via Qout + T310 |
| Traffic | Poisson arrivals, exponential durations and demand |
| Movement | A* routes on the OSM walk and drive graphs (one-way aware), with random destinations and dwell |

### Known limitations

- Hata models are empirical. They are valid for 1–20 km and antennas 30–200 m high. Small cells,
  short distances and frequencies above 2 GHz (LTE 2600, NR 3500) are **extrapolated**, and the
  app flags this.
- Hata models ignore buildings; only the statistical shadowing accounts for obstructions. The Walfisch–Ikegami
  model uses OSM buildings but no terrain, no reflections, and a fixed street orientation (φ = 90°).
  OSM building heights are often missing, in which case levels, building type, or a default are used.
- Only the downlink is modelled. UMTS is not modelled; UMTS rows are skipped on import.
- Beamforming is approximated by a static array gain; there are no per-beam patterns. MIMO uses an
  abstract rank-adaptation model rather than channel matrices, and has no interference rejection.
- UE measurements are instantaneous; there is no L3 filtering. Ping-pong rates with strong
  shadowing are therefore pessimistic, so tune them with hysteresis, TTT or σ.

## Project layout

```
src/radio/      propagation, antenna, shadowing, link budget & SINR, band/PRB tables
src/sim/        simulation engine, KPIs & event log, OSM road graph + routing
src/map/        Leaflet map view, heatmap layer + worker, colour scales
src/planning/   plan checks, auto PCI/BCCH, hex/random patterns
src/io/         OpenCelliD / OSM tower import, scenario JSON
src/ui/         panels (network, users, radio, layers, planning, import/export, models), KPI panel
```
