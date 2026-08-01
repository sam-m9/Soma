/* Ported from index.html's schedule engine — kept logically identical so the
   Worker computes the same "is a dose due today" answer as the app itself.
   Dates are represented as UTC-midnight Date objects standing in for a plain
   calendar date (never compared against a real UTC instant), so arithmetic
   stays consistent regardless of the Worker runtime's own clock. */

const pad = n => String(n).padStart(2, '0');

export const keyOf = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const dateFromKey = k => {
  const [y, m, dd] = k.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
};

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

function mondayOnOrBefore(date) {
  const d = new Date(date);
  const wd = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - wd);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/* Returns {y, mo, d, h, mi} for a timezone's current wall-clock time. */
export function localParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    // Intl reports midnight as "24" with hour12:false in some engines; normalize.
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute)
  };
}

/* Mirrors the app's logicalNow(): a "day" runs 3:00 AM to 3:00 AM local time,
   so late-night logging before 3 AM still counts for the prior calendar day. */
export function logicalNowInTZ(tz, date = new Date()) {
  const p = localParts(tz, date);
  let d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  if (p.h < 3) d = addDays(d, -1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function cycleOn(p, date, nowFallback) {
  const anchorKey = p.startDate || p.schedule.anchor;
  const anchor = anchorKey ? dateFromKey(anchorKey) : mondayOnOrBefore(nowFallback);
  const mult = p.schedule.cycleUnit === 'weeks' ? 7 : 1;
  const on = (Number(p.schedule.on) || 0) * mult;
  const off = (Number(p.schedule.off) || 0) * mult;
  const per = on + off;
  if (per <= 0) return true;
  const diff = Math.floor((date - anchor) / 86400000);
  const idx = ((diff % per) + per) % per;
  return idx < on;
}

function weeksSince(startKey, date) {
  const diff = Math.floor((date - dateFromKey(startKey)) / 86400000);
  return Math.floor(diff / 7);
}

function courseEndKey(p) {
  if (p.endDate) return p.endDate;
  if (p.startDate && p.courseWeeks) return keyOf(addDays(dateFromKey(p.startDate), Number(p.courseWeeks) * 7 - 1));
  return '';
}

/* Returns 'on' | 'off' (rest day, still tracked) | false (not scheduled). */
export function runsOn(p, date, nowFallback) {
  const k = keyOf(date);
  if (p.startDate && k < p.startDate) return false;
  const endK = courseEndKey(p);
  if (endK && k > endK) return false;
  if ((p.pauses || []).some(w => w && w.from && w.to && k >= w.from && k <= w.to)) return false;
  if (p.skipWeekends && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) return false;
  const t = p.schedule.type;
  if (t === 'everyday') return 'on';
  if (t === 'prn') return false;
  if (t === 'specific') return p.schedule.days.includes(date.getUTCDay()) ? 'on' : false;
  if (t === 'cycle') return cycleOn(p, date, nowFallback) ? 'on' : 'off';
  return false;
}

export function effectiveBase(p, date) {
  const k = keyOf(date);
  let val = p.kind === 'peptide' && p.unit === 'U' ? p.doseMcg : p.dose;
  if (p.startDate && (p.phases || []).length) {
    const wk = weeksSince(p.startDate, date);
    const applic = (p.phases || []).filter(ph => Number(ph.week) - 1 <= wk).sort((a, b) => Number(a.week) - Number(b.week));
    if (applic.length) val = applic[applic.length - 1].dose;
  } else if ((p.titrations || []).length) {
    const tits = (p.titrations || []).filter(t => t.date <= k).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (tits.length) val = tits[tits.length - 1].dose;
  }
  return val;
}

function computeUnits(mcg, vialMg, bacMl) {
  if (!vialMg || !bacMl) return 0;
  const conc = (vialMg * 1000) / bacMl;
  const vol = mcg / conc;
  return vol * 100;
}

export function shownUnits(p, date) {
  if (p.unitsManual != null && p.unitsManual !== '') return Math.round(Number(p.unitsManual));
  return Math.round(computeUnits(effectiveBase(p, date), p.vialSizeMg, p.bacWaterMl));
}

/* Every active protocol due "on" today, alongside its display amount. */
export function dueProtocolsToday(protocols, todayDate, nowFallback) {
  return (protocols || [])
    .filter(p => p.status === 'active' && runsOn(p, todayDate, nowFallback) === 'on')
    .map(p => {
      const amount = p.unit === 'U' ? shownUnits(p, todayDate) + ' units' : effectiveBase(p, todayDate) + ' ' + p.unit;
      return { id: p.id, name: p.name, time: p.time, amount, route: p.route || '' };
    });
}
