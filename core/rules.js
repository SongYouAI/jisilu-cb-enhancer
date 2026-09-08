(function (root) {
  'use strict';
  const dates = root.JisiluDates || (typeof require !== 'undefined' && require('./dates.js'));
  // Pure so the real rows captured from the page can be replayed in tests.
  // A missing record date (rendered as "-") means the issue is pending and stays calculable.
  function inactiveReason(row, today) {
    if (!row || !row.stockCode) return '未识别正股代码';
    if (/上市/.test(row.progress || '')) return '已上市，无需潜伏';
    if (dates.isExpired(row.registrationDate, today)) return `股权登记日 ${row.registrationDate} 已到或已过，不可潜伏`;
    return '';
  }
  const api = { inactiveReason };
  root.JisiluRules = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
