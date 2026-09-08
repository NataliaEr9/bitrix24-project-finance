(function (global) {
  "use strict";

  function toCents(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Некорректная сумма");
      return Math.round(value * 100);
    }

    const normalized = String(value ?? "")
      .trim()
      .replace(/\s+/g, "")
      .replace(",", ".");

    if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
      throw new Error("Введите сумму с точностью не более двух знаков");
    }

    const sign = normalized.startsWith("-") ? -1 : 1;
    const unsigned = normalized.replace("-", "");
    const [whole, frac = ""] = unsigned.split(".");
    return sign * (Number(whole) * 100 + Number((frac + "00").slice(0, 2)));
  }

  function calcMetrics(operations) {
    let incomeCents = 0;
    let expenseCents = 0;

    for (const op of operations || []) {
      const amount = Number(op.amountCents || 0);
      if (!Number.isSafeInteger(amount)) {
        throw new Error("Сумма операции должна храниться целым числом копеек");
      }
      if (op.type === "income") incomeCents += amount;
      if (op.type === "expense") expenseCents += amount;
    }

    const profitCents = incomeCents - expenseCents;
    const marginPct = incomeCents === 0 ? null : (profitCents / incomeCents) * 100;
    const roiPct = expenseCents === 0 ? null : (profitCents / expenseCents) * 100;

    return { incomeCents, expenseCents, profitCents, marginPct, roiPct };
  }

  function formatMoney(cents, currency = "RUB") {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }).format(Number(cents || 0) / 100);
  }

  function formatPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value)}%`;
  }

  global.ProjectFinance = { toCents, calcMetrics, formatMoney, formatPercent };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { toCents, calcMetrics, formatMoney, formatPercent };
  }
})(typeof window !== "undefined" ? window : globalThis);
