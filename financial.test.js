const assert = require("assert");
const { toCents, calcMetrics } = require("../financial.js");

assert.strictEqual(toCents("100"), 10000);
assert.strictEqual(toCents("100,50"), 10050);
assert.strictEqual(toCents("0.01"), 1);
assert.strictEqual(toCents(12.34), 1234);
assert.throws(() => toCents("12.345"));
assert.throws(() => toCents("abc"));

let m = calcMetrics([
  { type: "income", amountCents: 100000 },
  { type: "expense", amountCents: 25000 },
  { type: "expense", amountCents: 15000 }
]);

assert.strictEqual(m.incomeCents, 100000);
assert.strictEqual(m.expenseCents, 40000);
assert.strictEqual(m.profitCents, 60000);
assert.strictEqual(m.marginPct, 60);
assert.strictEqual(m.roiPct, 150);

m = calcMetrics([{ type: "expense", amountCents: 5000 }]);
assert.strictEqual(m.profitCents, -5000);
assert.strictEqual(m.marginPct, null);
assert.strictEqual(m.roiPct, -100);

m = calcMetrics([]);
assert.deepStrictEqual(m, {
  incomeCents: 0,
  expenseCents: 0,
  profitCents: 0,
  marginPct: null,
  roiPct: null
});

assert.throws(() => calcMetrics([{ type: "income", amountCents: 12.5 }]));

console.log("✓ Финансовые расчёты: все тесты пройдены");
