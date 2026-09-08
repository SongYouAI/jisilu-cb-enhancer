(function (root) {
  'use strict';
  function parseDate(raw) {
    const match = String(raw || '').match(/(20\d{2})[\-/.年](\d{1,2})[\-/.月](\d{1,2})/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  // Issue dates are published in Beijing time, so "today" must be resolved in Asia/Shanghai
  // instead of whatever timezone the browser happens to run in.
  function shanghaiToday(now) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now || new Date());
    const value = type => Number((parts.find(part => part.type === type) || {}).value);
    return new Date(value('year'), value('month') - 1, value('day'));
  }
  // Conservative, and consistent with the P0 spec: a record date of today or earlier is no
  // longer actionable. A missing or unparsable date (the page renders "-" for pending issues)
  // must stay calculable, so it is never treated as expired.
  function isExpired(raw, today) {
    const date = parseDate(raw);
    if (!date) return false;
    return date <= (today || shanghaiToday());
  }
  const api = { parseDate, shanghaiToday, isExpired };
  root.JisiluDates = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
