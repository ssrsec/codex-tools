import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccountSummary,
  UsageSnapshot,
  UsageWindow,
} from "../src/types/app.ts";
import {
  accountCanBeCleaned,
  accountHasActiveExhaustedWindow,
  accountIsAvailableForAutomaticUse,
  averageAvailableWeeklyUsage,
  getAccountStatus,
} from "../src/utils/accountStatus.ts";

function usage(
  planType = "team",
  weeklyUsedPercent = 10,
  resetAt: number | null = 200,
): UsageSnapshot {
  return {
    fetchedAt: 100,
    planType,
    fiveHour: null,
    oneWeek: {
      usedPercent: weeklyUsedPercent,
      windowSeconds: 604_800,
      resetAt,
    },
    credits: null,
    resetCredits: null,
  };
}

function account(
  id: string,
  overrides: Partial<AccountSummary> = {},
): AccountSummary {
  return {
    id,
    label: id,
    sourceKind: "chatgpt",
    email: `${id}@example.com`,
    accountKey: id,
    accountId: id,
    planType: "team",
    subscriptionActiveUntil: null,
    apiBaseUrl: null,
    modelName: null,
    balanceText: null,
    profileAuthReady: true,
    profileConfigReady: true,
    profileIntegrityError: null,
    profileLastValidatedAt: null,
    profileLastValidationError: null,
    addedAt: 1,
    updatedAt: 1,
    usage: usage(),
    usageError: null,
    authRefreshBlocked: false,
    authRefreshError: null,
    apiProxyEnabled: true,
    isCurrent: false,
    ...overrides,
  };
}

test("Free and authorization failures are consistently marked unavailable", () => {
  const free = account("free", { usage: usage("free") });
  const forbidden = account("forbidden", { usageError: "403 Forbidden" });

  assert.equal(getAccountStatus(free, 150), "issue");
  assert.equal(getAccountStatus(forbidden, 150), "issue");
  assert.equal(accountIsAvailableForAutomaticUse(free, 150), false);
  assert.equal(accountIsAvailableForAutomaticUse(forbidden, 150), false);
});

test("transient refresh errors show check failed without blocking automatic use", () => {
  const exhausted = account("exhausted", {
    usage: usage("team", 100, 200),
    usageError: "503 Service Unavailable",
    authRefreshError: "temporary refresh failure",
  });

  assert.equal(getAccountStatus(exhausted, 150), "checkFailed");
  assert.equal(accountIsAvailableForAutomaticUse(exhausted, 150), false);
  assert.equal(getAccountStatus(exhausted, 201), "checkFailed");
  assert.equal(accountIsAvailableForAutomaticUse(exhausted, 201), true);
});

test("a global refresh failure is shown as check failed instead of available", () => {
  const healthyCachedAccount = account("cached");

  assert.equal(
    getAccountStatus(healthyCachedAccount, 150, "network unavailable"),
    "checkFailed",
  );
});

test("cleanup only targets definite, non-current failures", () => {
  assert.equal(accountCanBeCleaned(account("blocked", { authRefreshBlocked: true })), true);
  assert.equal(
    accountCanBeCleaned(account("authorization", { usageError: "403 Forbidden" })),
    true,
  );
  assert.equal(
    accountCanBeCleaned(
      account("removed-team-member", {
        planType: "k12",
        usage: usage("k12"),
        usageError: "该账号已被踢出 team 组织，请重新授权后再刷新。",
      }),
    ),
    true,
  );
  assert.equal(
    accountCanBeCleaned(
      account("current-blocked", {
        authRefreshBlocked: true,
        isCurrent: true,
      }),
    ),
    false,
  );
  assert.equal(
    accountCanBeCleaned(account("temporary", { usageError: "503 Service Unavailable" })),
    false,
  );
});

test("cleanup no longer deletes accounts by plan alone (M0)", () => {
  // 后端 M0 起清理只依据授权/停用信号；free、free_workspace 与任何 Pro 档
  // 都由 plan 误报风险驱动，不能仅凭套餐删除账号。
  assert.equal(accountCanBeCleaned(account("free", { usage: usage("free") })), false);
  assert.equal(
    accountCanBeCleaned(account("free-workspace", { usage: usage("free_workspace") })),
    false,
  );
  assert.equal(
    accountCanBeCleaned(account("pro-100", { planType: "prolite", usage: usage("prolite") })),
    false,
  );
  assert.equal(
    accountCanBeCleaned(account("pro-500", { planType: "promax", usage: usage("promax") })),
    false,
  );
  // 授权类 usage_error 仍然可清理。
  assert.equal(
    accountCanBeCleaned(account("deactivated", { usageError: "账号被封禁，请检查邮箱" })),
    true,
  );
});

test("average weekly usage excludes issues and exhausted accounts and deduplicates groups", () => {
  const withWeeklyUsage = (
    planType: string,
    weeklyUsedPercent: number,
    resetAt: number | null = 200,
  ): UsageSnapshot => ({
    ...usage(planType, weeklyUsedPercent, resetAt),
  });
  const candidates = [
    account("group-a-old", {
      accountKey: "group-a",
      updatedAt: 1,
      usage: withWeeklyUsage("team", 90),
    }),
    account("group-a-current", {
      accountKey: "group-a",
      updatedAt: 2,
      isCurrent: true,
      usage: withWeeklyUsage("team", 20),
    }),
    account("group-b", {
      usage: withWeeklyUsage("team", 40),
    }),
    account("free", {
      usage: withWeeklyUsage("free", 80),
    }),
    account("exhausted", {
      usage: withWeeklyUsage("team", 100, 200),
    }),
  ];

  assert.equal(averageAvailableWeeklyUsage(candidates, 150), 30);
});

test("M4 真值表：windows/limitReached/allowed 与 credits 组合", () => {
  const snapshot = (overrides: Partial<UsageSnapshot>): UsageSnapshot => ({
    fetchedAt: 100,
    planType: "team",
    fiveHour: null,
    oneWeek: null,
    credits: null,
    resetCredits: null,
    ...overrides,
  });
  const thirtyDayWindow: UsageWindow = {
    usedPercent: 100,
    windowSeconds: 2_592_000,
    resetAt: 500,
  };

  // windows[] 中的 30 天窗口耗尽也应判为 exhausted，而不是“只看一周窗口”。
  const multiWindow = account("multi-window", {
    usage: snapshot({ windows: [thirtyDayWindow] }),
  });
  assert.equal(getAccountStatus(multiWindow, 150), "exhausted");
  assert.equal(accountIsAvailableForAutomaticUse(multiWindow, 150), false);
  assert.equal(getAccountStatus(multiWindow, 501), "available");

  // limit_reached 比百分比更权威。
  const limited = account("limited", {
    usage: snapshot({
      limitReached: true,
      oneWeek: { usedPercent: 10, windowSeconds: 604_800, resetAt: 500 },
    }),
  });
  assert.equal(getAccountStatus(limited, 150), "exhausted");
  assert.equal(accountHasActiveExhaustedWindow(limited, 150), true);

  // 有可用 credits 时不判耗尽。
  const limitedWithCredits = account("limited-credits", {
    usage: snapshot({
      limitReached: true,
      credits: { hasCredits: true, unlimited: false, balance: "$5.00" },
    }),
  });
  assert.equal(accountHasActiveExhaustedWindow(limitedWithCredits, 150), false);
  assert.equal(accountIsAvailableForAutomaticUse(limitedWithCredits, 150), true);

  // allowed === false（服务端拒绝）直接算被遏制，即使 credits 可用也无法绕过。
  const serverBlocked = account("server-blocked", {
    usage: snapshot({ allowed: false }),
  });
  assert.equal(accountHasActiveExhaustedWindow(serverBlocked, 150), true);

  const serverBlockedWithCredits = account("server-blocked-credits", {
    usage: snapshot({
      allowed: false,
      credits: { hasCredits: true, unlimited: false, balance: "$5.00" },
    }),
  });
  assert.equal(accountHasActiveExhaustedWindow(serverBlockedWithCredits, 150), true);

  // unlimited credits 视为可用，即使触及 limitReached 也不判耗尽。
  const unlimitedCredits = account("unlimited-credits", {
    usage: snapshot({
      limitReached: true,
      credits: { hasCredits: false, unlimited: true, balance: null },
    }),
  });
  assert.equal(accountHasActiveExhaustedWindow(unlimitedCredits, 150), false);

  // 旧快照（allowed/limitReached 缺省，windows 为空）只按窗口判断。
  const legacy = account("legacy", {
    usage: snapshot({
      oneWeek: { usedPercent: 100, windowSeconds: 604_800, resetAt: 500 },
    }),
  });
  assert.equal(accountHasActiveExhaustedWindow(legacy, 150), true);

  // 没有用量快照时不得判耗尽。
  assert.equal(
    accountHasActiveExhaustedWindow(account("no-usage", { usage: null }), 150),
    false,
  );
});
