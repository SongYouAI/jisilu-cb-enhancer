(function (root) {
  'use strict';
  const headerAliases = {
    bondCode: ['转债代码', '债券代码', '代码'], bondName: ['转债名称', '债券名称', '名称'],
    stockCode: ['正股代码'], // Deliberately not relaxed to 「正股」: that substring also matches the 「正股价」 column.
    stockName: ['正股名称'], stockPrice: ['正股价', '正股现价'], requiredShares: ['配售10张所需股数', '配售十张所需股数'],
    issueSize: ['发行规模', '发行额'],
    // 上市首日盈利预估所需（转股价值 = 正股价/转股价×100）
    conversionPrice: ['转股价'], rating: ['评级'],
    // The free 待发转债 page has no 申购日期 column. 股权登记日 is the record date:
    // the last day shares must be held to qualify for allotment, so it is the real deadline.
    // Rows showing "-" are still pending and must stay calculable.
    registrationDate: ['股权登记日', '登记日'], progress: ['方案进展']
  };
  // Kept pure so the real header list captured from the page can be replayed in tests.
  function mapColumns(labels) {
    const map = {};
    for (const [key, aliases] of Object.entries(headerAliases)) {
      map[key] = labels.findIndex(label => aliases.some(alias => label === alias || label.includes(alias)));
    }
    return map;
  }
  const api = { table: 'table', headerAliases, mapColumns };
  root.JisiluSelectors = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
