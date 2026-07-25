import type { AccountSummary, UsageWindow } from "../types/app.ts";
import { classifyUsageRefreshError } from "./usageRefreshError.ts";
import { remainingPercent } from "./usage.ts";

export type AccountStatus =
  | "using"
  | "available"
  | "low"
  | "exhausted"
  | "checkFailed"
  | "issue";

export function resolvedAccountPlan(account: AccountSummary): string {
  return (account.usage?.planType ?? account.planType ?? "").trim().toLowerCase();
}

export function accountIsFreePlan(account: AccountSummary): boolean {
  return account.sourceKind === "chatgpt" && resolvedAccountPlan(account) === "free";
}

function usageWindowIsActivelyExhausted(
  window: UsageWindow | null | undefined,
  fetchedAt: number,
  nowSeconds: number,
): boolean {
  if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 100) {
    return false;
  }
  const resetAt = window.resetAt ?? fetchedAt + Math.max(0, window.windowSeconds);
  return resetAt > nowSeconds;
}

function usageWindowIsCurrent(
  window: UsageWindow | null | undefined,
  fetchedAt: number,
  nowSeconds: number,
): window is UsageWindow {
  if (!window) {
    return false;
  }
  return (window.resetAt ?? fetchedAt + Math.max(0, window.windowSeconds)) > nowSeconds;
}

export function accountHasActiveExhaustedWindow(
  account: AccountSummary,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return usageWindowIsActivelyExhausted(
    account.usage?.oneWeek,
    account.usage?.fetchedAt ?? nowSeconds,
    nowSeconds,
  );
}

export function accountHasBlockingIssue(account: AccountSummary): boolean {
  const usageAuthorizationFailure = Boolean(
    account.usageError &&
      classifyUsageRefreshError(account.usageError) === "authorization",
  );
  return Boolean(
    account.authRefreshBlocked ||
      account.profileIntegrityError ||
      account.profileLastValidationError ||
      usageAuthorizationFailure ||
      accountIsFreePlan(account),
  );
}

export function getAccountStatus(
  account: AccountSummary,
  nowSeconds = Math.floor(Date.now() / 1000),
  refreshError: string | null = null,
): AccountStatus {
  if (accountHasBlockingIssue(account)) {
    return "issue";
  }
  if (account.usageError || refreshError) {
    return "checkFailed";
  }
  if (accountHasActiveExhaustedWindow(account, nowSeconds)) {
    return "exhausted";
  }

  const fetchedAt = account.usage?.fetchedAt ?? nowSeconds;
  const remaining = [account.usage?.oneWeek]
    .filter((window) => usageWindowIsCurrent(window, fetchedAt, nowSeconds))
    .map((window) => remainingPercent(window))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (remaining.length > 0 && Math.min(...remaining) < 15) {
    return "low";
  }
  return account.isCurrent ? "using" : "available";
}

export function accountCanBeCleaned(account: AccountSummary): boolean {
  const authorizationFailure = Boolean(
    account.usageError &&
      classifyUsageRefreshError(account.usageError) === "authorization",
  );
  return (
    !account.isCurrent &&
    (account.authRefreshBlocked || authorizationFailure || accountIsFreePlan(account))
  );
}

export function accountIsAvailableForAutomaticUse(
  account: AccountSummary,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return (
    !accountHasBlockingIssue(account) &&
    !accountHasActiveExhaustedWindow(account, nowSeconds)
  );
}

export function averageAvailableWeeklyUsage(
  accounts: AccountSummary[],
  nowSeconds = Math.floor(Date.now() / 1000),
  refreshError: string | null = null,
): number | null {
  const groups = new Map<string, AccountSummary[]>();
  for (const account of accounts) {
    const group = groups.get(account.accountKey) ?? [];
    group.push(account);
    groups.set(account.accountKey, group);
  }

  const weeklyUsage = Array.from(groups.values()).flatMap((group) => {
    const candidate = [...group]
      .filter((account) => {
        const status = getAccountStatus(account, nowSeconds, refreshError);
        const window = account.usage?.oneWeek;
        return (
          (status === "using" || status === "available" || status === "low") &&
          usageWindowIsCurrent(
            window,
            account.usage?.fetchedAt ?? nowSeconds,
            nowSeconds,
          ) &&
          Number.isFinite(window?.usedPercent)
        );
      })
      .sort(
        (left, right) =>
          Number(right.isCurrent) - Number(left.isCurrent) ||
          (right.usage?.fetchedAt ?? 0) - (left.usage?.fetchedAt ?? 0) ||
          right.updatedAt - left.updatedAt,
      )[0];
    if (!candidate?.usage?.oneWeek) {
      return [];
    }
    return [Math.max(0, Math.min(100, candidate.usage.oneWeek.usedPercent))];
  });

  if (weeklyUsage.length === 0) {
    return null;
  }
  return (
    Math.round(
      (weeklyUsage.reduce((total, value) => total + value, 0) /
        weeklyUsage.length) *
        10,
    ) / 10
  );
}
