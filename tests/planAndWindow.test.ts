import assert from "node:assert/strict";
import test from "node:test";
import type { UsageSnapshot, UsageWindow } from "../src/types/app.ts";
import {
  formatPlan,
  formatWindowLabel,
  mainUsageWindows,
  planDisplay,
  planGroup,
  planTone,
  primaryUsageWindow,
  usageCreditsAvailable,
} from "../src/utils/usage.ts";

const windowLabelOptions = {
  fallback: "额度",
  oneWeek: "1周",
  hourSuffix: "小时",
  minuteSuffix: "分钟",
};

function windowWith(seconds: number): UsageWindow {
  return {
    usedPercent: 10,
    windowSeconds: seconds,
    resetAt: null,
  };
}

test("planDisplay 显示官方 Pro 三档与其它档位的中文名", () => {
  assert.equal(planDisplay("prolite"), "Pro 100");
  assert.equal(planDisplay("pro"), "Pro 200");
  assert.equal(planDisplay("promax"), "Pro 500");
  assert.equal(planDisplay("free"), "免费");
  assert.equal(planDisplay("free_workspace"), "免费");
  assert.equal(planDisplay("plus"), "Plus");
  assert.equal(planDisplay("go"), "Go");
  assert.equal(planDisplay("team"), "Business");
  assert.equal(planDisplay("business"), "Business");
  assert.equal(planDisplay("enterprise"), "Enterprise");
  assert.equal(planDisplay("api"), "API");
  assert.equal(planDisplay("edu"), "Edu");
  assert.equal(planDisplay("edu-cn"), "Edu");
});

test("planDisplay 对未知值保留原值，空值返回空串", () => {
  assert.equal(planDisplay("k12"), "k12");
  assert.equal(planDisplay("  SomePlan  "), "SomePlan");
  assert.equal(planDisplay("PROLITE"), "Pro 100");
  assert.equal(planDisplay(null), "");
  assert.equal(planDisplay("   "), "");
});

test("planGroup 把 Pro 三档归为同一组，free 组含 free_workspace", () => {
  assert.equal(planGroup("prolite"), "pro");
  assert.equal(planGroup("pro"), "pro");
  assert.equal(planGroup("promax"), "pro");
  assert.equal(planGroup("free"), "free");
  assert.equal(planGroup("free_workspace"), "free");
  assert.equal(planGroup("plus"), "plus");
  assert.equal(planGroup("go"), "go");
  assert.equal(planGroup("team"), "business");
  assert.equal(planGroup("business"), "business");
  assert.equal(planGroup("enterprise"), "enterprise");
  assert.equal(planGroup("api"), "api");
  assert.equal(planGroup("relay"), "api");
  assert.equal(planGroup("edu"), "edu");
  assert.equal(planGroup("edu-university"), "edu");
  assert.equal(planGroup("k12"), "unknown");
  assert.equal(planGroup(null), "unknown");
});

test("planTone 与 planGroup 对齐：Pro 三档同色，free 组统一 free", () => {
  assert.equal(planTone("prolite"), "pro");
  assert.equal(planTone("pro"), "pro");
  assert.equal(planTone("promax"), "pro");
  assert.equal(planTone("free"), "free");
  assert.equal(planTone("free_workspace"), "free");
  assert.equal(planTone("plus"), "plus");
  // team 与 business 展示名同为 Business，但 tone 是两个不同色系。
  assert.equal(planTone("team"), "team");
  assert.equal(planTone("business"), "business");
  assert.equal(planTone("enterprise"), "enterprise");
  assert.equal(planTone("api"), "api");
  assert.equal(planTone("go"), "unknown");
  assert.equal(planTone("k12"), "unknown");
  assert.equal(planTone(null), "unknown");
});

test("formatPlan 顺序：locale 标签 → planDisplay → 原值", () => {
  const labels = {
    unknown: "未知",
    pro: "自定义 Pro 标签",
  };

  assert.equal(formatPlan("pro", labels), "自定义 Pro 标签");
  // locale 没有 prolite 键时回落到中文档位表。
  assert.equal(formatPlan("prolite", labels), "Pro 100");
  assert.equal(formatPlan("promax"), "Pro 500");
  assert.equal(formatPlan("free"), "免费");
  assert.equal(formatPlan("k12"), "k12");
  assert.equal(formatPlan(null, labels), "未知");
  assert.equal(formatPlan("", labels), "未知");
  assert.equal(formatPlan("  "), "未知");
});

test("formatWindowLabel 按秒数生成中文窗口标签", () => {
  assert.equal(formatWindowLabel(windowWith(18_000), windowLabelOptions), "5小时");
  assert.equal(formatWindowLabel(windowWith(21_600), windowLabelOptions), "5小时");
  assert.equal(formatWindowLabel(windowWith(604_800), windowLabelOptions), "1周");
  // 允许 ±12 小时容差，仍归为 1 周。
  assert.equal(formatWindowLabel(windowWith(561_600), windowLabelOptions), "1周");
  assert.equal(formatWindowLabel(windowWith(2_592_000), windowLabelOptions), "30天");
  assert.equal(formatWindowLabel(windowWith(2_419_200), windowLabelOptions), "28天");
  assert.equal(formatWindowLabel(windowWith(86_400), windowLabelOptions), "24小时");
  assert.equal(
    formatWindowLabel(windowWith(1_296_000), windowLabelOptions),
    "360小时",
  );
});

test("formatWindowLabel 在窗口缺失时返回 fallback", () => {
  assert.equal(formatWindowLabel(null, windowLabelOptions), "额度");
  assert.equal(formatWindowLabel(windowWith(0), windowLabelOptions), "额度");
});

function snapshotWith(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    fetchedAt: 100,
    planType: "free",
    fiveHour: null,
    oneWeek: null,
    credits: null,
    resetCredits: null,
    ...overrides,
  };
}

test("primaryUsageWindow 优先周窗口，其次 5h，最后取 windows[] 中最长窗口", () => {
  const fiveHour: UsageWindow = {
    usedPercent: 30,
    windowSeconds: 18_000,
    resetAt: 3,
  };
  const weekly: UsageWindow = {
    usedPercent: 10,
    windowSeconds: 604_800,
    resetAt: 1,
  };
  const monthly: UsageWindow = {
    usedPercent: 20,
    windowSeconds: 2_592_000,
    resetAt: 2,
  };

  assert.equal(
    primaryUsageWindow(snapshotWith({ oneWeek: weekly, windows: [monthly] })),
    weekly,
  );
  assert.equal(
    primaryUsageWindow(snapshotWith({ windows: [fiveHour, monthly] })),
    monthly,
  );
  // 只有 5h 窗口时回退到 5h，避免主额度列显示 "--"。
  assert.equal(primaryUsageWindow(snapshotWith({ fiveHour })), fiveHour);
  assert.equal(primaryUsageWindow(null), null);

  // free 账号只有 30 天窗口：主额度标签应为“30天”，不能显示“1周”。
  const primary = primaryUsageWindow(snapshotWith({ windows: [monthly] }));
  assert.equal(formatWindowLabel(primary, windowLabelOptions), "30天");
});

test("mainUsageWindows 汇总 five_hour/one_week/windows[]", () => {
  const fiveHour: UsageWindow = {
    usedPercent: 30,
    windowSeconds: 18_000,
    resetAt: 3,
  };
  const weekly: UsageWindow = {
    usedPercent: 10,
    windowSeconds: 604_800,
    resetAt: 1,
  };
  const monthly: UsageWindow = {
    usedPercent: 20,
    windowSeconds: 2_592_000,
    resetAt: 2,
  };

  assert.deepEqual(mainUsageWindows(null), []);
  assert.deepEqual(mainUsageWindows(snapshotWith({})), []);
  assert.deepEqual(
    mainUsageWindows(
      snapshotWith({ fiveHour, oneWeek: weekly, windows: [monthly] }),
    ),
    [fiveHour, weekly, monthly],
  );
});

test("usageCreditsAvailable 只在 creds 真实可用时返回 true", () => {
  assert.equal(usageCreditsAvailable(null), false);
  assert.equal(
    usageCreditsAvailable(
      snapshotWith({ credits: { hasCredits: false, unlimited: false, balance: "$5" } }),
    ),
    false,
  );
  assert.equal(
    usageCreditsAvailable(
      snapshotWith({ credits: { hasCredits: true, unlimited: true, balance: "$5" } }),
    ),
    true,
  );
  assert.equal(
    usageCreditsAvailable(
      snapshotWith({ credits: { hasCredits: false, unlimited: true, balance: null } }),
    ),
    true,
  );
  assert.equal(
    usageCreditsAvailable(
      snapshotWith({ credits: { hasCredits: true, unlimited: false, balance: null } }),
    ),
    false,
  );
  assert.equal(
    usageCreditsAvailable(
      snapshotWith({ credits: { hasCredits: true, unlimited: false, balance: "$5.00" } }),
    ),
    true,
  );
  assert.equal(
    usageCreditsAvailable(
      snapshotWith({ credits: { hasCredits: true, unlimited: false, balance: "$0.00" } }),
    ),
    false,
  );
  assert.equal(
    usageCreditsAvailable(
      snapshotWith({ credits: { hasCredits: true, unlimited: false, balance: "abc" } }),
    ),
    false,
  );
});

