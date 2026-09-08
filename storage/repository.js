(function (root) {
  'use strict';
  const KEY = 'jisilu-enhancer-v1';
  const defaults = Object.freeze({ defaultEstimatedProfitTen: null, defaultRestrictedRatio: 0, defaultAllocationRatio: 90, thresholds: [0.02, 0.04, 0.06, 0.08], cacheTtlSeconds: 30, mood: 'neutral' });
  function read() { return new Promise(resolve => chrome.storage.local.get(KEY, value => resolve(value[KEY] || { schemaVersion: 1, global: { ...defaults }, bonds: {} }))); }
  async function update(mutator) { const state = await read(); const next = mutator(state) || state; await chrome.storage.local.set({ [KEY]: next }); return next; }
  async function bondSettings(bondCode) { const state = await read(); return { ...state.global, ...(state.bonds[bondCode] || {}) }; }
  async function saveBond(bondCode, value) { return update(state => { state.bonds[bondCode] = { ...(state.bonds[bondCode] || {}), ...value, updatedAt: new Date().toISOString() }; return state; }); }
  async function resetBond(bondCode) { return update(state => { delete state.bonds[bondCode]; return state; }); }
  async function saveGlobal(value) { return update(state => { state.global = { ...state.global, ...value }; return state; }); }
  root.JisiluStorage = { defaults, read, bondSettings, saveBond, resetBond, saveGlobal };
})(globalThis);
