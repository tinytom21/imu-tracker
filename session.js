// Session statistics: several runs of the same measurement combined into a mean with an error bar.
// Pure functions (no DOM) so they can be tested and reused.
//
// A run is { id, points: [[x, y, z], ...] } in mm - one entry per measured point (a single move
// or 1-point loop has one point; a survey has one per antenna), plus optional baselines in mm.

// Systematic allowance (mm, X/Y/Z): repeating runs shrinks random error but not consistent
// offsets. From the native-app field sessions of 30 Sep - 1 Oct 2026 (5 sessions, 27 runs), the
// session means were off by RMS 54 / 52 / 31 mm vs tape references (which carry their own error).
// The 95% CI alone excluded the truth on Y or Z in 4 of 5 sessions, so the suggested accuracy
// combines both. Rounded up to 60/60/40 (covers 14 of 15 session axes, vs 13 at 50/50/30 and
// 9 with the CI alone) since it was fitted on the same data. Refine as the dataset grows.
export const SYSTEMATIC_MM = [60, 60, 40];

// Two-sided 95% Student-t multipliers by degrees of freedom (n - 1); 2.0 beyond the table.
const T95 = [NaN, 12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13,
  2.12, 2.11, 2.10, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05];
export const t95 = (df) => (df >= 1 && df < T95.length ? T95.at(df) : 2.0);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s.at(m) : (s.at(m - 1) + s.at(m)) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/**
 * Flag outliers robustly: a run is an outlier if any axis of any point is further from the median
 * than max(k x robust sigma, floorMm). Needs at least 3 runs (with 2 there is no majority).
 * Robust sigma = 1.4826 x median absolute deviation.
 */
export function findOutliers(runs, { k = 3, floorMm = 50 } = {}) {
  const flagged = new Set();
  if (runs.length < 3) return flagged;
  const nPts = Math.min(...runs.map((r) => r.points.length));
  for (let p = 0; p < nPts; p++) {
    for (let a = 0; a < 3; a++) {
      const vals = runs.map((r) => r.points.at(p).at(a));
      const med = median(vals);
      const sigma = 1.4826 * median(vals.map((v) => Math.abs(v - med)));
      const limit = Math.max(k * sigma, floorMm);
      runs.forEach((r, i) => { if (Math.abs(vals.at(i) - med) > limit) flagged.add(r.id); });
    }
  }
  return flagged;
}

// Mean, spread and 95% confidence interval of the mean for a list of numbers.
export function stats(xs) {
  const n = xs.length;
  const s = std(xs);
  return { n, mean: n ? mean(xs) : NaN, std: s, ci95: n >= 2 ? t95(n - 1) * s / Math.sqrt(n) : NaN,
           min: n ? Math.min(...xs) : NaN, max: n ? Math.max(...xs) : NaN };
}

/**
 * Summarise a session. `include` lets the user force an outlier back in (ids), `exclude` force a
 * run out. Returns per point and axis: mean, std (run-to-run), ci95 (of the mean), plus baselines.
 */
export function summarize(runs, { include = [], exclude = [], ...opts } = {}) {
  const outliers = findOutliers(runs, opts);
  const used = runs.filter((r) => !exclude.includes(r.id) && (!outliers.has(r.id) || include.includes(r.id)));
  const nPts = used.length ? Math.min(...used.map((r) => r.points.length)) : 0;
  const points = [];
  // suggested = what to enter as the accuracy (e.g. NAVconfig): CI of the mean combined with the
  // systematic allowance; needs >= 3 runs to say anything about repeatability.
  const sys = opts.systematicMm || SYSTEMATIC_MM;
  for (let p = 0; p < nPts; p++) points.push([0, 1, 2].map((a) => {
    const st = stats(used.map((r) => r.points.at(p).at(a)));
    return { ...st, sys: sys.at(a), suggested: st.n >= 3 ? Math.hypot(st.ci95, sys.at(a)) : NaN };
  }));
  const nBase = used.length ? Math.min(...used.map((r) => (r.baselines || []).length)) : 0;
  const baselines = [];
  for (let b = 0; b < nBase; b++) {
    const first = used[0].baselines.at(b);
    baselines.push({ from: first.from, to: first.to, ...stats(used.map((r) => r.baselines.at(b).mm)) });
  }
  return { runs: runs.length, used: used.map((r) => r.id), outliers: [...outliers], points, baselines };
}

// One-line text per point for copying into notes / NAVconfig (mm, mean +/- 95% CI, run-to-run std).
export function summaryText(sum, label = (p) => `Point ${p + 1}`) {
  const f = (v) => (Number.isFinite(v) ? Math.round(v) : '-');
  const lines = sum.points.map((ax, p) =>
    `${label(p)}: X ${f(ax[0].mean)} ± ${f(ax[0].suggested)}, Y ${f(ax[1].mean)} ± ${f(ax[1].suggested)}, Z ${f(ax[2].mean)} ± ${f(ax[2].suggested)} mm` +
    ` (suggested accuracy; run-to-run SD ${f(ax[0].std)}/${f(ax[1].std)}/${f(ax[2].std)} mm; ${sum.used.length} of ${sum.runs} runs)`);
  for (const b of sum.baselines) lines.push(`Point ${b.from} ↔ ${b.to}: ${f(b.mean)} ± ${f(b.ci95)} mm`);
  return lines.join('\n');
}
