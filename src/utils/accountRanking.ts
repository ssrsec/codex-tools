import type { AccountSummary, UsageWindow } from "../types/app";
import { accountIsAvailableForAutomaticUse } from "./accountStatus.ts";

const UNKNOWN_REMAINING = -1;

function windowRemainingPercent(window: UsageWindow | null | undefined): number {
  if (!window || window.usedPercent === null || window.usedPercent === undefined) {
    return UNKNOWN_REMAINING;
  }
  const remaining = 100 - window.usedPercent;
  return Math.max(0, Math.min(100, remaining));
}

function accountRemainingScore(account: AccountSummary): {
  oneWeek: number;
} {
  return {
    oneWeek: windowRemainingPercent(account.usage?.oneWeek),
  };
}

function accountHasPositiveRemaining(account: AccountSummary): boolean {
  const score = accountRemainingScore(account);
  return score.oneWeek > 0;
}

function accountHasKnownRemaining(account: AccountSummary): boolean {
  const score = accountRemainingScore(account);
  return score.oneWeek >= 0;
}

export function accountIsAvailableForSmartSwitch(
  account: AccountSummary,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return accountIsAvailableForAutomaticUse(account, nowSeconds);
}

export function compareAccountsByRemaining(a: AccountSummary, b: AccountSummary): number {
  if (a.sourceKind !== b.sourceKind) {
    return a.sourceKind === "chatgpt" ? -1 : 1;
  }

  const left = accountRemainingScore(a);
  const right = accountRemainingScore(b);

  // Codex 当前只保留主额度窗口，按周额度余量排序。
  if (right.oneWeek !== left.oneWeek) {
    return right.oneWeek - left.oneWeek;
  }

  // 余量一致时，优先展示当前账号，再按标签稳定排序。
  if (a.isCurrent !== b.isCurrent) {
    return a.isCurrent ? -1 : 1;
  }
  return a.label.localeCompare(b.label, "zh-Hans-CN");
}

export function sortAccountsByRemaining(accounts: AccountSummary[]): AccountSummary[] {
  return [...accounts].sort(compareAccountsByRemaining);
}

export function pickBestRemainingAccount(accounts: AccountSummary[]): AccountSummary | null {
  if (accounts.length === 0) {
    return null;
  }
  return sortAccountsByRemaining(accounts)[0] ?? null;
}

export function pickBestSmartSwitchAccount(
  accounts: AccountSummary[],
  includeApiFallback: boolean,
): AccountSummary | null {
  const sorted = sortAccountsByRemaining(
    accounts.filter((account) => accountIsAvailableForSmartSwitch(account)),
  );
  if (sorted.length === 0) {
    return null;
  }

  if (!includeApiFallback) {
    return sorted[0] ?? null;
  }

  const chatgptAccounts = sorted.filter((account) => account.sourceKind === "chatgpt");
  if (chatgptAccounts.length === 0) {
    return sorted[0] ?? null;
  }

  const bestChatgptWithRemaining = chatgptAccounts.find(accountHasPositiveRemaining);
  if (bestChatgptWithRemaining) {
    return bestChatgptWithRemaining;
  }

  const allChatgptKnownExhausted = chatgptAccounts.every(
    (account) => accountHasKnownRemaining(account) && !accountHasPositiveRemaining(account),
  );
  if (!allChatgptKnownExhausted) {
    return chatgptAccounts[0] ?? sorted[0] ?? null;
  }

  const relayAccounts = sorted.filter((account) => account.sourceKind === "relay");
  return relayAccounts[0] ?? chatgptAccounts[0] ?? sorted[0] ?? null;
}
