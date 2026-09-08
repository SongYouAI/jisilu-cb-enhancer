(function (root) {
  'use strict';
  function validateThresholds(input) {
    const values = input.map(Number);
    if (values.length !== 4 || values.some(v => !Number.isFinite(v) || v < 0) || values.some((v, i) => i && v <= values[i - 1])) throw new Error('安全垫阈值必须是四个递增的非负数字');
    return values;
  }
  function safetyClass(rate, thresholds) {
    if (!Number.isFinite(rate)) return 'unknown';
    const [a, b, c, d] = validateThresholds(thresholds);
    if (rate < a) return 'danger'; if (rate < b) return 'warning'; if (rate < c) return 'caution'; if (rate < d) return 'good'; return 'excellent';
  }
  const api = { validateThresholds, safetyClass };
  root.JisiluColor = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
