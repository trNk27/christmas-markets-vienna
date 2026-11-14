/*
 * MarketStatus — pure opening-hours logic for the Vienna Christmas market tracker.
 * All calendar/time reasoning happens in Europe/Vienna wall-clock time via Intl,
 * never in the viewer's local zone. No DOM access; loads in the browser
 * (window.MarketStatus) and in Node (module.exports) for testing.
 */
(function (root) {
  'use strict';

  var TZ = 'Europe/Vienna';
  var CLOSING_SOON_MIN = 45;
  var DAY = 1440;

  var partsFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** Vienna wall-clock parts for an instant. weekday: 0=Sun … 6=Sat. */
  function viennaParts(date) {
    var d = date instanceof Date ? date : new Date(date);
    var p = {};
    partsFmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    var y = +p.year, mo = +p.month, da = +p.day, h = +p.hour % 24, mi = +p.minute;
    var iso = y + '-' + pad(mo) + '-' + pad(da);
    return {
      isoDate: iso, year: y, month: mo, day: da,
      hour: h, minute: mi, second: +p.second,
      minutes: h * 60 + mi,
      time: pad(h) + ':' + pad(mi),
      weekday: weekdayOf(iso)
    };
  }

  // ---- ISO calendar helpers (timezone-free: computed on UTC midnight) ----
  function isoToUTC(iso) {
    var a = iso.split('-');
    return Date.UTC(+a[0], +a[1] - 1, +a[2]);
  }
  function utcToIso(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function addDays(iso, n) { return utcToIso(isoToUTC(iso) + n * 864e5); }
  function weekdayOf(iso) { return new Date(isoToUTC(iso)).getUTCDay(); }
  function daysBetween(a, b) { return Math.round((isoToUTC(b) - isoToUTC(a)) / 864e5); }

  function toMinutes(hhmm) {
    if (typeof hhmm === 'number') return hhmm;
    var a = String(hhmm).split(':');
    return (+a[0]) * 60 + (+a[1] || 0);
  }
  function fromMinutes(m) {
    m = ((m % DAY) + DAY) % DAY;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }

  /** The UTC instant for a Vienna wall-clock date + time ('HH:MM' or minutes). */
  function fromVienna(isoDate, time) {
    var mins = toMinutes(time == null ? 0 : time);
    var a = isoDate.split('-');
    var target = Date.UTC(+a[0], +a[1] - 1, +a[2], Math.floor(mins / 60), mins % 60);
    var guess = target;
    for (var i = 0; i < 3; i++) {
      var p = viennaParts(new Date(guess));
      var seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
      var diff = target - seen;
      if (!diff) break;
      guess += diff;
    }
    return new Date(guess);
  }

  // ---- formatting (dates are formatted on UTC midnight so the zone never shifts them) ----
  var fmtCache = {};
  function fmt(iso, opts) {
    var key = JSON.stringify(opts);
    if (!fmtCache[key]) {
      var o = { timeZone: 'UTC' };
      for (var k in opts) o[k] = opts[k];
      fmtCache[key] = new Intl.DateTimeFormat('en-GB', o);
    }
    return fmtCache[key].format(new Date(isoToUTC(iso)));
  }
  function fmtShort(iso) { return fmt(iso, { day: 'numeric', month: 'short' }); }            // 20 Nov
  function fmtDay(iso) { return fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' }); } // Fri 20 Nov
  function fmtWeekday(iso) { return fmt(iso, { weekday: 'short' }); }                           // Fri
  function fmtLong(iso) { return fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' }); }  // Friday 20 November
  function fmtYear(iso) { return fmt(iso, { day: 'numeric', month: 'short', year: 'numeric' }); } // 20 Nov 2026

  function seasonLabel(market) {
    var s = market.season || {};
    if (!s.start || !s.end) return '';
    var sameYear = s.start.slice(0, 4) === s.end.slice(0, 4);
    return (sameYear ? fmtShort(s.start) : fmtYear(s.start)) + ' – ' + fmtYear(s.end);
  }

  var HOLIDAYS = {
    '12-08': 'Public holiday', '12-24': 'Christmas Eve', '12-25': 'Christmas Day',
    '12-26': "St Stephen's Day", '12-31': "New Year's Eve", '01-01': "New Year's Day",
    '01-06': 'Epiphany'
  };
  function holidayLabel(iso) { return HOLIDAYS[iso.slice(5)] || null; }

  // ---- rule evaluation ----
  function inSeason(market, iso) {
    var s = market.season || {};
    return !!(s.start && s.end && iso >= s.start && iso <= s.end);
  }

  function ruleMatches(rule, iso, wd) {
    if (rule.dates) return rule.dates.indexOf(iso) !== -1;
    if (rule.from || rule.to) return (!rule.from || iso >= rule.from) && (!rule.to || iso <= rule.to);
    if (rule.days) return rule.days.indexOf(wd) !== -1;
    return false;
  }

  /** The first rule matching the date (inside season), or null. */
  function ruleForDate(market, iso) {
    if (!inSeason(market, iso)) return null;
    var wd = weekdayOf(iso), rules = market.hours || [];
    for (var i = 0; i < rules.length; i++) if (ruleMatches(rules[i], iso, wd)) return rules[i];
    return null;
  }

  /** { open, close, label? } or null when closed / out of season. */
  function hoursForDate(market, iso) {
    var r = ruleForDate(market, iso);
    if (!r || r.closed || !r.open || !r.close) return null;
    var out = { open: r.open, close: r.close };
    if (r.label) out.label = r.label;
    return out;
  }

  /** Opening interval in minutes relative to that day's midnight (close may exceed 1440). */
  function interval(h) {
    var o = toMinutes(h.open), c = toMinutes(h.close);
    if (c <= o) c += DAY;
    return { open: o, close: c };
  }

  function findNextOpen(market, fromIso, maxDays) {
    var end = (market.season && market.season.end) || fromIso;
    for (var i = 0, d = fromIso; i <= (maxDays || 400) && d <= end; i++, d = addDays(d, 1)) {
      var h = hoursForDate(market, d);
      if (h) return { isoDate: d, open: h.open, close: h.close };
    }
    return null;
  }

  function durationText(mins) {
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  function relDay(fromIso, iso, live) {
    var n = daysBetween(fromIso, iso);
    if (n === 0) return live ? 'today' : 'same day';
    if (n === 1) return live ? 'tomorrow' : 'next day';
    if (n < 7) return fmtWeekday(iso);
    return fmtShort(iso);
  }

  /**
   * Status of a market at an instant.
   * opts.live (default true): wording for "right now" ("Open now") vs a planned moment ("Open").
   */
  function statusAt(market, date, opts) {
    var live = !(opts && opts.live === false);
    var p = viennaParts(date || new Date());
    var iso = p.isoDate, t = p.minutes;
    var res;

    function openState(closeAbs, closeStr) {
      var left = closeAbs - t;
      var soon = left <= CLOSING_SOON_MIN;
      return {
        state: soon ? 'closing-soon' : 'open',
        label: soon ? 'Closing soon · ' + closeStr : (live ? 'Open now' : 'Open') + ' · until ' + closeStr,
        detail: 'Closes in ' + durationText(left),
        closesAt: closeStr, closesAtMin: closeAbs, minutesLeft: left
      };
    }

    // 1. Still open from yesterday's late session?
    var prev = hoursForDate(market, addDays(iso, -1));
    if (prev) {
      var pi = interval(prev);
      if (pi.close > DAY && t < pi.close - DAY) {
        res = openState(pi.close - DAY, prev.close);
        res.opensAt = prev.open;
        return res;
      }
    }

    // 2. Today's own hours.
    var h = hoursForDate(market, iso);
    if (h) {
      var iv = interval(h);
      if (t < iv.open) {
        var wait = iv.open - t;
        return {
          state: 'opens-today',
          label: (live ? 'Opens today at ' : 'Opens at ') + h.open,
          detail: (live ? 'In ' : 'Opens ') + durationText(wait) + (live ? '' : ' later') + ' · until ' + h.close,
          opensAt: h.open, closesAt: h.close, closesAtMin: iv.close, minutesUntilOpen: wait
        };
      }
      if (t < iv.close) {
        res = openState(iv.close, h.close);
        res.opensAt = h.open;
        return res;
      }
    }

    // 3. Closed for the rest of the day (or not opening today).
    var s = market.season || {};
    if (s.start && iso < s.start) {
      var first = findNextOpen(market, s.start);
      var openIso = first ? first.isoDate : s.start;
      var n = daysBetween(iso, openIso);
      return {
        state: 'pre-season',
        label: 'Opens ' + fmtShort(openIso),
        detail: n === 1 ? (live ? 'Tomorrow' : 'The next day') : (live ? 'In ' : '') + n + ' days' + (live ? '' : ' later'),
        nextOpen: first, daysUntil: n
      };
    }
    var next = (s.end && iso <= s.end) ? findNextOpen(market, addDays(iso, 1)) : null;
    if (!next) {
      var endedToday = s.end === iso;
      return {
        state: 'season-over',
        label: endedToday ? 'Season ended today' : 'Season ended ' + fmtShort(s.end || iso),
        detail: 'Back next winter'
      };
    }
    var when = relDay(iso, next.isoDate, live);
    var hadHoursToday = !!h;
    return {
      state: 'closed-today',
      label: (hadHoursToday ? (live ? 'Closed now' : 'Closed') : (live ? 'Closed today' : 'Closed that day')) +
        ' · opens ' + when + ' ' + next.open,
      detail: hadHoursToday ? 'Closed at ' + h.close : (ruleLabel(market, iso) || 'Closed on this day'),
      nextOpen: next
    };
  }

  function ruleLabel(market, iso) {
    var r = ruleForDate(market, iso);
    return (r && r.label) || null;
  }

  /** Rows for an hours table starting at fromIsoDate. */
  function weekSchedule(market, fromIsoDate, days) {
    days = days || 7;
    var rows = [];
    for (var i = 0; i < days; i++) {
      var d = addDays(fromIsoDate, i);
      var r = ruleForDate(market, d);
      var h = hoursForDate(market, d);
      var s = market.season || {};
      var reason = null;
      if (!h) reason = (s.start && d < s.start) ? 'pre-season' : (s.end && d > s.end) ? 'season-over' : 'closed';
      rows.push({
        isoDate: d,
        weekday: weekdayOf(d),
        dayLabel: fmtDay(d),
        open: h ? h.open : null,
        close: h ? h.close : null,
        closed: !h,
        reason: reason,
        pastMidnight: h ? toMinutes(h.close) <= toMinutes(h.open) : false,
        label: (r && r.label) || holidayLabel(d) || null
      });
    }
    return rows;
  }

  var api = {
    TZ: TZ,
    CLOSING_SOON_MIN: CLOSING_SOON_MIN,
    viennaParts: viennaParts,
    fromVienna: fromVienna,
    hoursForDate: hoursForDate,
    ruleForDate: ruleForDate,
    inSeason: inSeason,
    statusAt: statusAt,
    weekSchedule: weekSchedule,
    findNextOpen: findNextOpen,
    seasonLabel: seasonLabel,
    holidayLabel: holidayLabel,
    addDays: addDays,
    daysBetween: daysBetween,
    weekdayOf: weekdayOf,
    toMinutes: toMinutes,
    fromMinutes: fromMinutes,
    durationText: durationText,
    fmtShort: fmtShort,
    fmtDay: fmtDay,
    fmtWeekday: fmtWeekday,
    fmtLong: fmtLong,
    fmtYear: fmtYear
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarketStatus = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
