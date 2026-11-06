import type { AccountSummary, UsageWindow } from "../types/app.ts";
import { classifyUsageRefreshError } from "./usageRefreshError.ts";
import {
  mainUsageWindows,
  planGroup,
  remainingPercent,
  usageCreditsAvailable,
} from "./usage.ts";

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
  return (
    account.sourceKind === "chatgpt" && planGroup(resolvedAccountPlan(account)) === "free"
  );
}

function usageWindowResetAt(window: UsageWindow, fetchedAt: number): number {
  return window.resetAt ?? fetchedAt + Math.max(0, window.windowSeconds);
}

function usageWindowIsBlocking(
  window: UsageWindow,
  fetchedAt: number,
  nowSeconds: number,
): boolean {
  return (
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 100 &&
    usageWindowResetAt(window, fetchedAt) > nowSeconds
  );
}

function usageWindowIsCurrent(
  window: UsageWindow | null | undefined,
  fetchedAt: number,
  nowSeconds: number,
): window is UsageWindow {
  if (!window) {
    return false;
  }
  return usageWindowResetAt(window, fetchedAt) > nowSeconds;
}

/**
 * 与后端 M4 真值表对齐：
 * included_blocked = allowed === false || limitReached === true ||
 *   任一主额度窗口（5h/周/windows[]）used >= 100 且未重置
 * exhausted = included_blocked && !credits 可用
 * 旧快照（allowed/limitReached 均缺省、windows 为空）自然退化为只看窗口。
 */
export function accountHasActiveExhaustedWindow(
  account: AccountSummary,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const usage = account.usage;
  if (!usage) {
    return false;
  }
  const fetchedAt = usage.fetchedAt ?? nowSeconds;
  // 服务端明确拒绝时，credits 也无法绕过，直接判耗尽。
  if (usage.allowed === false) {
    return true;
  }
  // credits 可用（unlimited 或有正余额）时不判耗尽；超出的部分由 credits 支付。
  if (usageCreditsAvailable(usage)) {
    return false;
  }
  return (
    usage.limitReached === true ||
    mainUsageWindows(usage).some((window) =>
      usageWindowIsBlocking(window, fetchedAt, nowSeconds),
    )
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

  const usage = account.usage;
  const fetchedAt = usage?.fetchedAt ?? nowSeconds;
  const remaining = mainUsageWindows(usage)
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
  // 与后端 M0 口径对齐：只清理“确定性不可用”的账号（授权失效/被停用）。
  // free 等套餐维度不再参与清理，避免上游误报 free 时误删 Pro 账号；
  // 套餐只影响可用性展示（accountHasBlockingIssue），不影响删除。
  return !account.isCurrent && (account.authRefreshBlocked || authorizationFailure);
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
