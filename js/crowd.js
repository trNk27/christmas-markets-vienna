/*
 * Crowd — a TYPICAL busyness estimate (no live data exists yet).
 * Heuristic: popularity × time-of-day curve × day factor × first-weekend boost.
 * A future live source can be plugged in with Crowd.registerProvider(fn).
 */
(function (root) {
  'use strict';

  var MS = root.MarketStatus || (typeof require === 'function' ? require('./status.js') : null);
  var LABELS = ['Quiet', 'Moderate', 'Busy', 'Very busy', 'Packed'];
  var provider = null;

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function lerp(a, b, t) { return a + (b - a) * clamp(t, 0, 1); }

  /** Relative footfall by Vienna hour-of-day (fractional), peaking 18:00–20:30. */
  function timeOfDay(h) {
    if (h >= 24) h -= 24;
    if (h < 6) return 0.35;                         // after midnight
    if (h < 12) return lerp(0.15, 0.3, (h - 10) / 2);
    if (h < 16) return lerp(0.3, 0.45, (h - 12) / 4);
    if (h < 18) return lerp(0.45, 0.95, (h - 16) / 2);
    if (h < 20.5) return 1;
    if (h < 22) return lerp(1, 0.55, (h - 20.5) / 1.5);
    return lerp(0.55, 0.35, (h - 22) / 2);
  }

  /** Day factor for a Vienna calendar date at a given hour. */
  function dayFactor(market, iso, h) {
    var wd = MS.weekdayOf(iso);
    var md = iso.slice(5);
    var f = [1.0, 0.72, 0.72, 0.75, 0.8, h >= 16 ? 1.0 : 0.82, 1.15][wd];
    var month = +iso.slice(5, 7), day = +iso.slice(8, 10);
    if (md === '12-08') f = Math.max(f, 1.15) * 1.08;                                  // holiday
    if (month === 12 && day < 24 && (wd === 0 || wd === 6)) f *= 1.1;                  // Advent weekend
    if (month === 12 && day >= 17 && day <= 23) f *= 1.15;                             // final rush
    if (md === '12-24') f *= h < 13 ? 0.95 : 0.7;
    if (month === 12 && day >= 25 || month === 1) f *= 0.8;                            // after Christmas
    var s = market.season && market.season.start;
    if (s && (wd === 0 || wd === 5 || wd === 6)) {
      var since = MS.daysBetween(s, iso);
      if (since >= 0 && since <= 9) f *= 1.08;                                         // first weekend
    }
    return f;
  }

  function score(market, iso, hourFloat) {
    var pop = clamp(+market.popularity || 3, 1, 5);
    var base = 0.32 + pop * 0.14;                      // 0.46 … 1.02
    return base * timeOfDay(hourFloat) * dayFactor(market, iso, hourFloat);
  }

  function toLevel(sc) {
    if (sc < 0.3) return 0;
    if (sc < 0.5) return 1;
    if (sc < 0.72) return 2;
    if (sc < 0.92) return 3;
    return 4;
  }

  function result(level) { return { level: level, label: LABELS[level], source: 'estimate' }; }

  /** Typical busyness at an instant, or null when the market is closed then. */
  function estimate(market, date) {
    var st = MS.statusAt(market, date);
    if (st.state !== 'open' && st.state !== 'closing-soon') return null;
    var p = MS.viennaParts(date);
    var iso = p.isoDate, h = p.minutes / 60;
    // After midnight the evening crowd belongs to the previous calendar day.
    if (h < 6) { iso = MS.addDays(iso, -1); h += 24; }
    var lvl = toLevel(score(market, iso, h));
    if (st.state === 'closing-soon' && lvl > 0) lvl -= 1;   // stalls winding down
    return result(lvl);
  }

  /** [{hour, level, label}] for each opening hour of that Vienna day ([] when closed). */
  function hourlyProfile(market, isoDate) {
    var hrs = MS.hoursForDate(market, isoDate);
    if (!hrs) return [];
    var o = MS.toMinutes(hrs.open), c = MS.toMinutes(hrs.close);
    if (c <= o) c += 1440;
    var out = [];
    for (var hr = Math.floor(o / 60); hr * 60 < c; hr++) {
      var mid = Math.max(hr * 60, o) + Math.min(30, (c - Math.max(hr * 60, o)) / 2);
      var lvl = toLevel(score(market, isoDate, mid / 60));
      out.push({ hour: hr % 24, level: lvl, label: LABELS[lvl] });
    }
    return out;
  }

  /** Register a future live source: async (market) => ({ level 0–4, updatedAt }) | null. */
  function registerProvider(fn) { provider = typeof fn === 'function' ? fn : null; }
  function hasProvider() { return !!provider; }

  /** Resolve live data via the provider, or null when none / no data / failure. */
  function live(market) {
    if (!provider) return Promise.resolve(null);
    var pr;
    try { pr = Promise.resolve(provider(market)); } catch (e) { return Promise.resolve(null); }
    return pr.then(function (d) {
      if (!d || typeof d.level !== 'number') return null;
      var lvl = clamp(Math.round(d.level), 0, 4);
      return { level: lvl, label: LABELS[lvl], source: 'live', updatedAt: d.updatedAt || null };
    }, function () { return null; });
  }

  var api = {
    LABELS: LABELS,
    estimate: estimate,
    hourlyProfile: hourlyProfile,
    registerProvider: registerProvider,
    hasProvider: hasProvider,
    live: live,
    ESTIMATE_NOTE: 'Typical for this time — estimate, not live data'
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Crowd = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
