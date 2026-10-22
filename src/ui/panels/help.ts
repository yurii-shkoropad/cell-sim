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

<h4>2. Antenna pattern (3GPP TR 36.814)</h4>
<p><code>A<sub>H</sub>(φ) = −min(12(φ/φ<sub>3dB</sub>)², A<sub>m</sub>)</code>, <code>A<sub>V</sub>(θ) = −min(12((θ−θ<sub>tilt</sub>)/θ<sub>3dB</sub>)², 20)</code>, <code>A = −min(−(A<sub>H</sub>+A<sub>V</sub>), A<sub>m</sub>)</code>. A<sub>m</sub> is the front-to-back ratio; θ is the depression angle from the antenna to the UE. NR beamforming is approximated by a higher static gain.</p>

<h4>3. Shadowing</h4>
<p>Log-normal with standard deviation σ. It is spatially correlated: Gaussian samples sit on a lattice spaced by the decorrelation distance, one lattice per site, and are smoothly interpolated and renormalised to unit variance. The variate is truncated at ±3σ, which avoids unphysical ±30 dB spots. The heatmap and the moving users see the same field.</p>

<h4>4. Link budget</h4>
<p><code>RSRP = P<sub>tx</sub> − L<sub>cable</sub> − 10·log₁₀(12·N<sub>RB</sub>) + G<sub>ant</sub> + A(φ,θ) − L<sub>path</sub> − X<sub>σ</sub></code>. For GSM, RxLev uses the whole BCCH carrier power (no per-RE division).</p>
<p><code>SINR = S / (Σ<sub>j</sub> P<sub>j</sub>·η<sub>j</sub>·ρ<sub>j</sub> + N)</code>, where S and P<sub>j</sub> are wideband received powers. η<sub>j</sub> is the fraction of interferer j's spectrum overlapping the victim carrier (all operators count; GSM adjacent channels are attenuated by the adjacent-channel rejection). ρ<sub>j</sub> is the interferer load (simulated PRB utilisation with a floor, or 100%). <code>N = −174 + 10·log₁₀(B) + NF</code>.</p>

<h4>5. Throughput</h4>
<p>Truncated Shannon (3GPP TR 36.942): <code>SE = 0</code> when SINR &lt; SINR<sub>min</sub>, otherwise <code>min(α·log₂(1+SINR), SE<sub>max</sub>)</code>. Rate per RB = <code>SE · B<sub>RB</sub> · (1 − overhead)</code>. The "peak" heatmap gives one user all RBs. GSM data is modelled as GPRS CS-2 at 13.4 kbit/s per timeslot.</p>

<h4>6. Capacity & scheduling</h4>
<ul>
<li><b>GSM</b>: <code>8·TRX − 2</code> traffic channels per sector, one per voice call. A call is blocked when none is free.</li>
<li><b>LTE/NR</b>: voice is GBR (30 kbit/s) and served first, with admission while GBR RBs stay at or below 90% of the cell. Data shares the remaining RBs by max-min fair water-filling, each user capped by its demand.</li>
<li>Every sector also has a <i>max active users</i> admission limit.</li>
</ul>

<h4>7. Mobility management</h4>
<ul>
<li><b>Idle</b>: the user camps on the best cell of the highest-priority RAT whose level is at least the minimum. Reselection needs 2 dB of hysteresis, unless it moves to a higher-priority RAT.</li>
<li><b>A3 handover</b> (same RAT): the neighbour exceeds serving + offset + hysteresis for the whole time to trigger. It fails if the target cannot admit the session (2 s back-off).</li>
<li><b>Inter-RAT (B2)</b>: serving drops below the B2 threshold while another RAT is at least min + 3 dB.</li>
<li><b>Radio link failure</b>: SINR below Q<sub>out</sub> (or level below the minimum) for the T310 time drops the session.</li>
<li><b>Ping-pong</b>: a handover back to the previous cell within the ping-pong window.</li>
</ul>

<h4>8. Traffic & mobility</h4>
<p>Each user has Poisson session arrivals (voice and data rates per hour) with exponentially distributed durations and data demand. Pedestrians use walkable OSM ways and vehicles use drivable ways, with one-way streets respected. Trips go to random destinations by A* shortest path, with random dwell times between them. Operators are assigned by market share, and device RAT support by the capability shares.</p>

<h4>KPI definitions</h4>
<ul>
<li>Drop rate = drops / admitted sessions</li>
<li>Block rate = blocked / attempted sessions (coverage and capacity reasons)</li>
<li>HO success = successful / attempted handovers</li>
<li>Coverage = users with a serving cell / all users</li>
<li>Cell-edge throughput = 5th percentile of active data users</li>
</ul>
</section>`;

export function helpPanel(): HTMLElement {
  const el = h('div', { class: 'panel' });
  el.innerHTML = HTML;
  return el;
}
