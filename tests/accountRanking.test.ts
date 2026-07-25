import assert from "node:assert/strict";
import test from "node:test";
import type { AccountSummary, UsageSnapshot } from "../src/types/app.ts";
import {
  accountIsAvailableForSmartSwitch,
  pickBestSmartSwitchAccount,
} from "../src/utils/accountRanking.ts";

function usage(
  planType: string,
  weeklyUsedPercent = 10,
  resetAt: number | null = null,
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
    usage: usage("team"),
    usageError: null,
    authRefreshBlocked: false,
    authRefreshError: null,
    apiProxyEnabled: true,
    isCurrent: false,
    ...overrides,
  };
}

test("smart switch excludes blocked, authorization-failed, Free, and exhausted accounts", () => {
  const candidates = [
    account("blocked", { authRefreshBlocked: true }),
    account("authorization", {
      usageError: "403 Forbidden",
    }),
    account("free", {
      planType: "pro",
      usage: usage("free"),
    }),
    account("exhausted", {
      usage: usage("team", 100, Math.floor(Date.now() / 1000) + 300),
    }),
    account("healthy", {
      usage: usage("team", 40),
    }),
  ];

  assert.equal(
    pickBestSmartSwitchAccount(candidates, false)?.id,
    "healthy",
  );
});

test("expired usage reset and transient refresh errors do not permanently exclude an account", () => {
  const candidate = account("recovered", {
    usage: usage("team", 100, 99),
    usageError: "503 Service Unavailable",
  });

  assert.equal(accountIsAvailableForSmartSwitch(candidate, 100), true);
});

test("active exhausted window is excluded until its reset time", () => {
  const candidate = account("cooldown", {
    usage: usage("team", 100, 200),
  });

  assert.equal(accountIsAvailableForSmartSwitch(candidate, 150), false);
  assert.equal(accountIsAvailableForSmartSwitch(candidate, 201), true);
});

test("missing reset time falls back to fetched time plus window duration", () => {
  const candidate = account("fallback-reset", {
    usage: usage("team", 100, null),
  });

  assert.equal(accountIsAvailableForSmartSwitch(candidate, 604_899), false);
  assert.equal(accountIsAvailableForSmartSwitch(candidate, 604_901), true);
});
