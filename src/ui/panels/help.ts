import { h } from '../dom';

const HTML = `
<section class="sec doc">
<h3>Models used</h3>

<h4>1. Path loss: Okumura-Hata / COST-231 Hata</h4>
<p>Median loss <code>L = A + B·log₁₀(d<sub>km</sub>)</code>, with <code>B = 44.9 − 6.55·log₁₀(h<sub>b</sub>)</code>.</p>
<ul>
<li><b>Okumura-Hata</b> (150–1500 MHz): <code>A = 69.55 + 26.16·log f − 13.82·log h<sub>b</sub> − a(h<sub>m</sub>)</code></li>
<li><b>COST-231 Hata</b> (1500–2000 MHz): <code>A = 46.3 + 33.9·log f − 13.82·log h<sub>b</sub> − a(h<sub>m</sub>) + C<sub>m</sub></code>, C<sub>m</sub> = 3 dB for metropolitan areas, otherwise 0</li>
<li>Small or medium city: <code>a(h<sub>m</sub>) = (1.1·log f − 0.7)·h<sub>m</sub> − (1.56·log f − 0.8)</code>. Large city (f ≥ 400 MHz): <code>3.2·(log 11.75h<sub>m</sub>)² − 4.97</code></li>
<li>Suburban: <code>− 2·(log(f/28))² − 5.4</code>. Rural/open: <code>− 4.78·(log f)² + 18.33·log f − 40.94</code></li>
<li>Loss is never allowed below free space, <code>32.45 + 20 log f + 20 log d</code>. The evaluation distance has a 10 m floor.</li>
<li>Outside the published validity ranges (f, h<sub>b</sub> 30–200 m, d 1–20 km) the formulas are <b>extrapolated</b>; the station editor and plan check flag this. COST-231 at 2.6 GHz and 3.5 GHz is an extrapolation, so treat NR n78 results as indicative only.</li>
</ul>

<h4>1b. Building-aware model: COST-231 Walfisch–Ikegami + OSM buildings</h4>
<p>With <i>Radio → Path-loss model → COST-231 Walfisch–Ikegami + OSM buildings</i>, OSM footprints are rasterised at 3 m. Heights come from <code>height</code>, otherwise <code>building:levels</code> × 3 m (+ roof levels), otherwise a typical height for the building type, otherwise the default. Each site casts 720 rays (0.5°) out to 4 km and evaluates the path at every 10 m:</p>
<ul>
<li><b>LOS test:</b> exact for the straight ray. A UE at distance d is blocked if any building sample at s &lt; d has <code>(h<sub>b</sub> − h)/s &lt; (h<sub>b</sub> − h<sub>m</sub>)/d</code>, so a running minimum along the ray decides LOS for every d.</li>
<li><b>LOS</b> (street canyon): <code>L = 42.6 + 26·log d + 20·log f</code>, never below free space.</li>
<li><b>NLOS:</b> <code>L = L<sub>0</sub> + L<sub>rts</sub> + L<sub>msd</sub></code>. L<sub>rts</sub> is rooftop-to-street diffraction, using the height of the <i>last building</i> before the UE, street width w = b/2 and φ = 90°. L<sub>msd</sub> is multi-screen diffraction, using the <i>mean roof height</i> of the buildings crossed, building separation b = d / crossings (15–100 m), and whether the antenna is above or below those roofs (k<sub>a</sub>, k<sub>d</sub>, L<sub>bsh</sub>).</li>
<li><b>Indoor:</b> a UE inside a footprint has its own building excluded from the path geometry, and gets the ITU-R P.2109 median building entry loss <code>r + s·log f + t·log² f</code> (f in GHz): traditional (12.64, 3.72, 0.96) or thermally efficient (28.19, −3.00, 8.48).</li>
<li>Beyond 4 km, or outside the building data, the Hata model is used. The validity range is 800–2000 MHz, h<sub>b</sub> 4–50 m, d 20 m–5 km. Terrain elevation and reflections are not modelled. Because buildings are now explicit, a smaller shadowing σ (≈ 4 dB) is appropriate.</li>
</ul>

<h4>2. Antenna pattern (3GPP TR 36.814)</h4>
<p><code>A<sub>H</sub>(φ) = −min(12(φ/φ<sub>3dB</sub>)², A<sub>m</sub>)</code>, <code>A<sub>V</sub>(θ) = −min(12((θ−θ<sub>tilt</sub>)/θ<sub>3dB</sub>)², 20)</code>, <code>A = −min(−(A<sub>H</sub>+A<sub>V</sub>), A<sub>m</sub>)</code>. A<sub>m</sub> is the front-to-back ratio; θ is the depression angle from the antenna to the UE. NR beamforming is approximated by a higher static gain.</p>

<h4>3. Shadowing</h4>
<p>Log-normal with standard deviation σ. It is spatially correlated: Gaussian samples sit on a lattice spaced by the decorrelation distance, one lattice per site position (shared by every station on the same mast, since obstructions affect all its carriers alike), and are smoothly interpolated and renormalised to unit variance. The variate is truncated at ±3σ, which avoids unphysical ±30 dB spots. The heatmap and the moving users see the same field.</p>

<h4>4. Link budget</h4>
<p><code>RSRP = P<sub>tx</sub> − L<sub>cable</sub> − 10·log₁₀(12·N<sub>RB</sub>) + G<sub>ant</sub> + A(φ,θ) − L<sub>path</sub> − X<sub>σ</sub></code>. For GSM, RxLev uses the whole BCCH carrier power (no per-RE division).</p>
<p><code>SINR = S / (Σ<sub>j</sub> P<sub>j</sub>·η<sub>j</sub>·ρ<sub>j</sub> + N)</code>, where S and P<sub>j</sub> are wideband received powers. η<sub>j</sub> is the fraction of interferer j's spectrum overlapping the victim carrier (all operators count; GSM adjacent channels are attenuated by the adjacent-channel rejection). ρ<sub>j</sub> is the interferer load (simulated PRB utilisation with a floor, or 100%). <code>N = −174 + 10·log₁₀(B) + NF</code>.</p>

<h4>5. Throughput</h4>
<p>Truncated Shannon (3GPP TR 36.942): <code>SE = 0</code> when SINR &lt; SINR<sub>min</sub>, otherwise <code>min(α·log₂(1+SINR), SE<sub>max</sub>)</code>, with SE<sub>max</sub> set by the station's max modulation (see 5c). Rate per RB = <code>SE · B<sub>RB</sub> · (1 − overhead)</code>. The "peak" heatmap gives one user all RBs. GSM data is modelled as GPRS CS-2 at 13.4 kbit/s per timeslot.</p>

<h4>5b. Antennas & MIMO</h4>
<p>Each station has an antenna configuration: SISO, 2T2R, 4T4R, 8T8R beamforming, or massive MIMO 32T32R / 64T64R. Beamforming types add a static array gain to the whole link (+3 / +6 / +7.5 dB), so they extend coverage. A UE receives r ≤ min(ports, UE Rx antennas, 4) layers, and <b>rank adaptation</b> picks the r that maximises <code>r · SE(SINR<sub>layer</sub>(r))</code>, where</p>
<p><code>SINR<sub>layer</sub>(r) = SINR − 10·log₁₀ r + 10·log₁₀(N<sub>rx</sub> − r + 1) [+ η<sub>pc</sub>·10·log₁₀(N<sub>tx</sub>/r) for codebook 2T/4T]</code></p>
<p>The terms are the power split across layers, the receive-combining gain (ZF/MMSE diversity order) and the transmit precoding gain. SE<sub>max</sub> applies per layer. At the cell edge users fall back to 1 layer; near the site they use 2–4. <b>MU-MIMO</b> (8T8R and massive MIMO) co-schedules up to 2 / 4 / 8 data users on the same RBs, multiplying the data RB pool by <code>1 + (min(n, N<sub>MU</sub>) − 1)·η<sub>MU</sub></code>. Interference rejection by the receiver is not modelled.</p>

<h4>5c. Modulation</h4>
<p>Each LTE/NR station has a <b>max modulation</b>: QPSK, 16QAM, 64QAM, 256QAM, or 1024QAM (NR only). It caps the spectral efficiency per layer at the top entry of the 3GPP CQI tables: 1.18 / 2.73 / 5.55 / 7.41 / 9.26 b/s/Hz (TS 36.213, 38.214). The modulation a UE actually uses is the lowest order whose top efficiency covers its per-layer Shannon efficiency, so high orders are reached only at high SINR. GSM uses GMSK. Missing values default to 64QAM (LTE) or 256QAM (NR).</p>

<h4>6. Capacity & scheduling</h4>
<ul>
<li><b>GSM</b>: <code>8·TRX − 2</code> traffic channels per sector, one per voice call. A call is blocked when none is free.</li>
<li><b>LTE/NR</b>: voice is GBR (30 kbit/s) and served first, with admission while GBR RBs stay at or below 90% of the cell. Data shares the remaining RBs by max-min fair water-filling, each user capped by its demand.</li>
<li><b>Data scheduler</b> (Radio → Scheduler, overridable per station) splits the RBs left after voice:
  <ul>
  <li><b>Round Robin:</b> equal RB share per user, channel-blind; unused shares are redistributed (work-conserving).</li>
  <li><b>Proportional Fair:</b> the same equal time share, but each user is served near its fading peaks. The model has no fast fading, so this is applied analytically as an SINR boost of <code>η<sub>PF</sub>·10·log₁₀(H<sub>n</sub>)</code>, where H<sub>n</sub> = Σ<sub>k=1..n</sub> 1/k is the Rayleigh multi-user diversity gain for n competing users (Choi &amp; Andrews 2007).</li>
  <li><b>Max C/I:</b> RBs go to the highest-rate users first, each up to its demand. It is channel-aware like PF, so it gets the same diversity boost.</li>
  <li><b>Equal throughput (max-min):</b> RBs are set so every user gets the same rate T, capped by demand: <code>Σ min(need<sub>i</sub>, T/rate<sub>i</sub>) = RBs</code>.</li>
  </ul></li>
<li>Every sector also has a <i>max active users</i> admission limit.</li>
</ul>

<h4>7. Mobility management</h4>
<ul>
<li><b>Idle</b>: the user camps on the best cell of the highest-priority RAT whose level is at least the minimum. Reselection needs 2 dB of hysteresis, unless it moves to a higher-priority RAT.</li>
<li><b>A3 handover</b> (same RAT, TS 36.331): <code>M<sub>n</sub> + CIO<sub>n</sub> &gt; M<sub>s</sub> + CIO<sub>s</sub> + Off + Hys</code> for the whole time to trigger. Hysteresis, offset and TTT are those of the <i>serving</i> cell. Each cell can override the RAT defaults, and its cell individual offset (CIO) makes it more (+) or less (−) attractive (station → Configure → Handover parameters). The handover fails if the target cannot admit the session (2 s back-off).</li>
<li><b>Inter-RAT (B2)</b>: serving drops below the B2 threshold while another RAT is at least min + 3 dB.</li>
<li><b>Radio link failure</b>: SINR below Q<sub>out</sub> (or level below the minimum) for the T310 time drops the session.</li>
<li><b>Ping-pong</b>: a handover back to the previous cell within the ping-pong window.</li>
</ul>

<h4>8. Traffic & mobility</h4>
<p>Each user has Poisson session arrivals (voice and data rates per hour) with exponentially distributed durations and data demand. Pedestrians use walkable OSM ways and vehicles use drivable ways, with one-way streets respected. Trips go to random destinations by A* shortest path, with random dwell times between them. A user given a target (user inspector → <i>Set target on map</i>) instead takes the shortest road path there from its start position, covers the last metres off the road in a straight line, and stops. Operators are assigned by market share, and device RAT support by the capability shares.</p>

<h4>9. Wi-Fi offloading</h4>
<ul>
<li><b>Path loss</b> (log-distance, ITU-R P.1238 style): <code>L = 20·log₁₀ f<sub>MHz</sub> − 27.55 + 10·n·log₁₀ d<sub>m</sub></code>, i.e. free space at 1 m plus slope n (indoor ≈ 3.0, outdoor street level ≈ 2.8), with its own correlated shadowing (σ, 20 m). RSSI = EIRP − L − X<sub>σ</sub>. The dashed circle around an AP is where the median RSSI equals the minimum RSSI.</li>
<li><b>SINR</b> over the AP's channel: co-channel APs whose channels overlap (bonded 40/80/160 MHz channels extend upwards from the primary) interfere, weighted by their airtime in use (at least 5% for beacons). Wi-Fi and cellular bands do not overlap.</li>
<li><b>Rate</b> with the whole airtime: <code>r · min(α·log₂(1+SINR/r), SE<sub>max</sub>) · B · η<sub>MAC</sub></code>, with the stream count r ≤ min(AP, phone streams) chosen to maximise it. SE<sub>max</sub> per stream is the top MCS: 802.11n 3.61, ac 4.33, ax 7.17 b/s/Hz. η<sub>MAC</sub> ≈ 0.65 covers CSMA/CA, ACKs and headers. Below −2 dB the link is unusable.</li>
<li><b>Airtime sharing</b>: VoWiFi calls (if enabled) take their 30 kbit/s first. Data then gets equal throughput (802.11 DCF gives every station the same transmit opportunities, so a slow, far station takes more airtime and slows everyone down: the "performance anomaly"), each capped by its demand. The AP total is capped by its backhaul.</li>
<li><b>Association</b>: a phone with Wi-Fi on measures every AP it may use (public, or its operator's, and not full). It joins the strongest one when RSSI ≥ min + hysteresis, it moves slower than the max speed, and the policy allows, for the whole association delay. It roams to another AP that is stronger by the hysteresis, and leaves below the min RSSI or when too fast.</li>
<li><b>Policies</b> (they only gate joining, so a user doesn't flip back because its own traffic left the cell): <i>always prefer Wi-Fi</i>; <i>only when Wi-Fi is faster</i> (AP rate ÷ (active users + 1), capped by backhaul, vs. the current cellular throughput × margin); <i>only when the cell is loaded</i> (serving cell PRB load ≥ threshold). A phone with no cellular service always joins.</li>
<li><b>Sessions</b>: a data session (and voice with VoWiFi) of an associated phone runs over the AP and uses no cellular resources; the phone stays camped on its cell. Joining moves an ongoing cellular session to Wi-Fi. Leaving moves it back through cellular admission control, or drops it if the cell can't take it.</li>
</ul>

<h4>10. Carrier aggregation</h4>
<ul>
<li><b>Who:</b> LTE/NR users with a data session on cellular (voice stays on the PCell, GSM has none). The serving cell is the <b>PCell</b>; handovers, RLF and admission use it alone.</li>
<li><b>SCells</b> (3GPP A4/A2-like): for each other carrier of the PCell's RAT and operator, the strongest cell whose RSRP is above the <i>SCell add threshold</i> and whose SINR is above Qout. With <i>Same site only</i> it must be within 50 m of the PCell (intra-eNB/gNB CA). A configured SCell is kept until 3 dB below the threshold. Up to <i>max component carriers</i> − 1 SCells, strongest first, none overlapping in frequency.</li>
<li><b>Scheduling:</b> the user's demand is split over its carriers in proportion to what each can give it, <code>SE(SINR<sub>k</sub>) × RB<sub>k</sub> × RB width</code>; each cell schedules its share with its own scheduler. Demand a congested carrier could not serve is then moved to the carriers that served their share in full, and those cells are scheduled again. Throughput = sum over carriers.</li>
<li>SCell users count in the cell's PRB load and served throughput, not in its admission limit. The scheduler what-if (throughput CDF comparison) counts PCells only.</li>
</ul>
<h4>KPI definitions</h4>
<ul>
<li>Drop rate = drops / admitted sessions</li>
<li>Block rate = blocked / attempted sessions (coverage and capacity reasons)</li>
<li>HO success = successful / attempted handovers</li>
<li>Coverage = users with a serving cell / all users</li>
<li>Wi-Fi offload = Wi-Fi throughput / (Wi-Fi + cellular served throughput)</li>
<li>Cell-edge throughput = 5th percentile of active data users</li>
<li>Fairness = Jain's index <code>(Σx)² / (n·Σx²)</code> over data users' satisfaction x = throughput / demand, computed per cell and averaged over cells with ≥ 2 data users (1 = all equally served). It is per cell because a scheduler only shares its own cell's resources.</li>
</ul>
</section>`;

export function helpPanel(): HTMLElement {
  const el = h('div', { class: 'panel' });
  el.innerHTML = HTML;
  return el;
}
