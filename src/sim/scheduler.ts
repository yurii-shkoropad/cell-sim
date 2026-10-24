/**
 * Downlink schedulers for LTE/NR data flows (flow-level: each simulation step
 * stands for many 1 ms TTIs, so allocations are the long-run resource shares
 * each policy converges to).
 */

export type SchedulerKey = 'rr' | 'pf' | 'maxci' | 'maxmin';

export interface SchedulerInfo {
  key: SchedulerKey;
  label: string;
  note: string;
}

export const SCHEDULERS: SchedulerInfo[] = [
  { key: 'rr', label: 'Round Robin', note: 'Equal RB share per user, ignoring channel quality; unused RBs go to users that still need them.' },
  { key: 'pf', label: 'Proportional Fair', note: 'Equal time share, but each user is served near its own channel peaks (multi-user diversity gain).' },
  { key: 'maxci', label: 'Max C/I (max throughput)', note: 'RBs go to the users with the best channel first (also exploiting fading peaks); cell-edge users may starve.' },
  { key: 'maxmin', label: 'Equal throughput (max-min fair)', note: 'RBs are split so every user gets the same Mbps (capped by demand); edge users consume many RBs.' },
];

export const schedulerInfo = (k: string | undefined) => SCHEDULERS.find((s) => s.key === k);

export interface DataFlow {
  /** Achievable rate per RB(-equivalent), Mbps. */
  rate: number;
  /** RBs needed to fully serve the user's demand. */
  need: number;
}

/**
 * Split `pool` RBs among flows. Returns the RBs given to each flow, in input order.
 * PF uses the same equal-share split as RR; its gain comes from the boosted rates
 * the caller passes in (see pfDiversityGainDb).
 */
export function allocate(kind: SchedulerKey, flows: DataFlow[], pool: number): number[] {
  const n = flows.length;
  const out = new Array<number>(n).fill(0);
  if (!n || pool <= 0) return out;
  const order = flows.map((_, i) => i);

  if (kind === 'maxci') {
    order.sort((a, b) => flows[b].rate - flows[a].rate);
    let remaining = pool;
    for (const i of order) {
      const a = Math.min(flows[i].need, remaining);
      out[i] = a;
      remaining -= a;
      if (remaining <= 0) break;
    }
    return out;
  }

  if (kind === 'maxmin') {
    // Water-fill on throughput: find T so that Σ min(need_i, T/rate_i) = pool.
    order.sort((a, b) => flows[a].need * flows[a].rate - flows[b].need * flows[b].rate);
    let remaining = pool;
    for (let k = 0; k < n; k++) {
      let invSum = 0;
      for (let j = k; j < n; j++) invSum += 1 / flows[order[j]].rate;
      const T = remaining / invSum;
      const f = flows[order[k]];
      if (f.need * f.rate <= T) {
        out[order[k]] = f.need;
        remaining -= f.need;
      } else {
        for (let j = k; j < n; j++) out[order[j]] = T / flows[order[j]].rate;
        break;
      }
    }
    return out;
  }

  // 'rr' and 'pf': equal RB share, capped by need, leftovers redistributed.
  order.sort((a, b) => flows[a].need - flows[b].need);
  let remaining = pool;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const a = Math.min(remaining / (n - k), flows[i].need);
    out[i] = a;
    remaining -= a;
  }
  return out;
}

/**
 * Multi-user diversity gain of channel-aware schedulers (PF, Max C/I) with n competing users: under
 * i.i.d. Rayleigh fading the scheduled user's SNR is boosted by the harmonic number
 * H_n = Σ 1/k (Choi & Andrews 2007). Real channels are correlated and CQI is
 * quantised, so only a fraction `efficiency` of that gain (in dB) is applied.
 */
export function pfDiversityGainDb(n: number, efficiency: number): number {
  if (n <= 1) return 0;
  let h = 0;
  for (let k = 1; k <= n; k++) h += 1 / k;
  return efficiency * 10 * Math.log10(h);
}

/** Jain's fairness index of a set of throughputs: 1 = perfectly equal, 1/n = one user takes all. */
export function jainIndex(x: number[]): number {
  if (!x.length) return 1;
  let s = 0;
  let s2 = 0;
  for (const v of x) {
    s += v;
    s2 += v * v;
  }
  return s2 > 0 ? (s * s) / (x.length * s2) : 1;
}
