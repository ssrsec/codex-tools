import assert from "node:assert/strict";
import test from "node:test";
import type { AccountSummary, UsageSnapshot } from "../src/types/app.ts";
import {
  accountCanBeCleaned,
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
  assert.equal(accountCanBeCleaned(account("free", { usage: usage("free") })), true);
  assert.equal(
    accountCanBeCleaned(
      account("current-free", {
        usage: usage("free"),
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
