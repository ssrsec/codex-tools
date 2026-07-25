import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AccountSummary, CodexTokenUsageSnapshot, UsageWindow } from "../types/app";
import { useI18n } from "../i18n/I18nProvider";
import { compareAccountsByRemaining } from "../utils/accountRanking";
import { getAccountStatus, type AccountStatus } from "../utils/accountStatus";
import { classifyUsageRefreshError } from "../utils/usageRefreshError";
import {
  formatPlan,
  formatTokenCount,
  percent,
  planTone,
  remainingPercent,
  toProgressWidth,
} from "../utils/usage";

type AccountGroup = {
  id: string;
  variants: AccountSummary[];
};

type AccountRow = AccountGroup & {
  account: AccountSummary;
};

type StatusFilter = AccountStatus | "all";

type UiCopy = {
  searchPlaceholder: string;
  allStatuses: string;
  allPlans: string;
  proxyEnabled: string;
  statusUsing: string;
  statusAvailable: string;
  statusLow: string;
  statusExhausted: string;
  statusCheckFailed: string;
  statusIssue: string;
  issueFallbackReason: string;
  tokenUsageTitle: string;
  tokenUsageHint: string;
  tokenUsageError: string;
  weekUsage: string;
  remainingSuffix: (value: string) => string;
  subscriptionExpiry: string;
  subscriptionUnavailable: string;
  subscriptionUnavailableHint: string;
  nextResetTime: string;
  quickActions: string;
  testStatus: string;
  testingStatus: string;
  reauthorize: string;
  exportAccount: string;
  exportAll: string;
  deleteAccount: string;
  switchAccount: string;
  noMatchesTitle: string;
  noMatchesDescription: string;
  emptyValue: string;
};

type AccountsGridProps = {
  leadingContent?: ReactNode;
  toolbarActions?: ReactNode;
  accounts: AccountSummary[];
  tokenUsage: CodexTokenUsageSnapshot | null;
  tokenUsageError: string | null;
  loading: boolean;
  usageRefreshing: boolean;
  showInitialUsageRefresh: boolean;
  usageRefreshError: string | null;
  exportingAccounts: boolean;
  authBusy: boolean;
  switchingId: string | null;
  testingAccountId: string | null;
  pendingDeleteId: string | null;
  onExportAll: () => void;
  onExport: (account: AccountSummary) => void;
  onReauthorize: (account: AccountSummary) => void;
  onTestStatus: (account: AccountSummary) => Promise<void>;
  onToggleApiProxy: (account: AccountSummary, enabled: boolean) => Promise<boolean>;
  onSwitch: (account: AccountSummary) => Promise<boolean>;
  onDelete: (account: AccountSummary) => void;
};

const PLAN_PRIORITY: Record<string, number> = {
  api: 0,
  team: 0,
  enterprise: 1,
  business: 2,
  pro: 3,
  plus: 4,
  free: 5,
  unknown: 6,
};

function planPriority(planType: string | null | undefined): number {
  const normalized = planType?.trim().toLowerCase() ?? "";
  return PLAN_PRIORITY[normalized] ?? PLAN_PRIORITY.unknown;
}

function sortVariantsForGroup(left: AccountSummary, right: AccountSummary): number {
  const priorityDiff =
    planPriority(left.planType ?? left.usage?.planType) -
    planPriority(right.planType ?? right.usage?.planType);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  if (left.isCurrent !== right.isCurrent) {
    return left.isCurrent ? -1 : 1;
  }

  return compareAccountsByRemaining(left, right);
}

function accountIssueReason(
  account: AccountSummary,
  fallbackReason: string,
  refreshError: string | null,
): string | null {
  const usageAuthorizationFailure = Boolean(
    account.usageError &&
      classifyUsageRefreshError(account.usageError) === "authorization",
  );
  const isFreePlan =
    account.sourceKind === "chatgpt" &&
    (account.usage?.planType ?? account.planType ?? "").trim().toLowerCase() === "free";
  return (
    account.profileIntegrityError ||
    account.profileLastValidationError ||
    account.authRefreshError ||
    account.usageError ||
    refreshError ||
    (account.authRefreshBlocked || usageAuthorizationFailure || isFreePlan
      ? fallbackReason
      : null)
  );
}

function usedPercent(window: UsageWindow | null): number | null {
  if (!window) {
    return null;
  }
  return Math.max(0, Math.min(100, window.usedPercent));
}

function getUiCopy(locale: string): UiCopy {
  if (locale === "zh-CN") {
    return {
      searchPlaceholder: "搜索账号 / 邮箱",
      allStatuses: "全部状态",
      allPlans: "所有套餐",
      proxyEnabled: "反代开启",
      statusUsing: "使用中",
      statusAvailable: "可用",
      statusLow: "即将耗尽",
      statusExhausted: "已耗尽",
      statusCheckFailed: "检测失败",
      statusIssue: "异常账号",
      issueFallbackReason: "查看账号授权和用量状态",
      tokenUsageTitle: "有效 Token",
      tokenUsageHint: "仅统计主会话的非缓存输入与输出，不含子任务和缓存输入",
      tokenUsageError: "Token 用量读取失败",
      weekUsage: "额度使用率",
      remainingSuffix: (value) => `剩余 ${value}`,
      subscriptionExpiry: "订阅到期",
      subscriptionUnavailable: "平台未提供",
      subscriptionUnavailableHint:
        "账号可用性来自用量接口；订阅到期日仅来自登录凭据，而此账号的凭据没有提供该字段。",
      nextResetTime: "下次重置",
      quickActions: "快捷操作",
      testStatus: "检测账号状态",
      testingStatus: "检测中…",
      reauthorize: "重新登录授权",
      exportAccount: "导出账号",
      exportAll: "全部导出",
      deleteAccount: "删除账号",
      switchAccount: "切换",
      noMatchesTitle: "没有匹配账号",
      noMatchesDescription: "调整搜索或筛选条件后再查看列表。",
      emptyValue: "--",
    };
  }

  return {
    searchPlaceholder: "Search account / email",
    allStatuses: "All statuses",
    allPlans: "All plans",
    proxyEnabled: "Proxy enabled",
    statusUsing: "In use",
    statusAvailable: "Available",
    statusLow: "Low quota",
    statusExhausted: "Exhausted",
    statusCheckFailed: "Check failed",
    statusIssue: "Needs attention",
    issueFallbackReason: "Check account auth and usage state",
    tokenUsageTitle: "Effective tokens",
    tokenUsageHint: "Main sessions only: uncached input plus output; excludes child tasks and cached input",
    tokenUsageError: "Token usage unavailable",
    weekUsage: "Quota usage",
    remainingSuffix: (value) => `${value} remaining`,
    subscriptionExpiry: "Subscription ends",
    subscriptionUnavailable: "Not provided",
    subscriptionUnavailableHint:
      "Availability comes from the usage API. This account's sign-in credential does not provide a subscription end date.",
    nextResetTime: "Next reset",
    quickActions: "Quick actions",
    testStatus: "Check account status",
    testingStatus: "Checking…",
    reauthorize: "Reauthorize login",
    exportAccount: "Export account",
    exportAll: "Export all",
    deleteAccount: "Delete",
    switchAccount: "Switch",
    noMatchesTitle: "No matching accounts",
    noMatchesDescription: "Change the search or filters to view accounts.",
    emptyValue: "--",
  };
}

function statusLabel(status: AccountStatus, text: UiCopy): string {
  if (status === "using") return text.statusUsing;
  if (status === "exhausted") return text.statusExhausted;
  if (status === "checkFailed") return text.statusCheckFailed;
  if (status === "low") return text.statusLow;
  if (status === "issue") return text.statusIssue;
  return text.statusAvailable;
}

function accountInitial(account: AccountSummary): string {
  const seed = account.email || account.label || account.accountId || account.accountKey;
  const normalized = seed.trim();
  return (normalized[0] || "?").toUpperCase();
}

function displayAccountAddress(account: AccountSummary, emptyValue: string): string {
  return account.email || account.accountId || account.apiBaseUrl || emptyValue;
}

function formatDateTime(epochSec: number | null | undefined, locale: string, emptyValue: string): string {
  if (!epochSec) {
    return emptyValue;
  }

  return new Date(epochSec * 1000).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSubscriptionExpiry(
  epochSec: number | null | undefined,
  locale: string,
  emptyValue: string,
): string {
  if (!epochSec) {
    return emptyValue;
  }

  return new Date(epochSec * 1000).toLocaleDateString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function subscriptionExpiryDisplay(
  account: AccountSummary,
  locale: string,
  text: UiCopy,
): { label: string; title?: string } {
  if (account.subscriptionActiveUntil) {
    return {
      label: formatSubscriptionExpiry(
        account.subscriptionActiveUntil,
        locale,
        text.emptyValue,
      ),
    };
  }

  if (account.sourceKind === "chatgpt") {
    return {
      label: text.subscriptionUnavailable,
      title: text.subscriptionUnavailableHint,
    };
  }

  return { label: text.emptyValue };
}

function nextUsageResetAt(account: AccountSummary): number | null {
  const window = account.usage?.oneWeek;
  if (!window) {
    return null;
  }
  return window.resetAt ?? account.usage!.fetchedAt + Math.max(0, window.windowSeconds);
}

type UsageFreshnessCopy = {
  usageRefreshing: string;
  usageRefreshingCached: (updatedAt: string) => string;
  usageRefreshFailed: (reason: string) => string;
  usageRefreshFailedCached: (reason: string, updatedAt: string) => string;
  usageFailureTimeout: string;
  usageFailureNetwork: string;
  usageFailureAuthorization: string;
  usageFailureRateLimited: string;
  usageFailureServer: string;
  usageFailureInvalidResponse: string;
  usageFailureUnknown: string;
  usageUnavailable: string;
};

type UsageFreshnessTone = "refreshing" | "error" | "unknown";

function summarizeUsageRefreshError(
  error: string,
  copy: UsageFreshnessCopy,
): string {
  switch (classifyUsageRefreshError(error)) {
    case "timeout":
      return copy.usageFailureTimeout;
    case "network":
      return copy.usageFailureNetwork;
    case "authorization":
      return copy.usageFailureAuthorization;
    case "rateLimited":
      return copy.usageFailureRateLimited;
    case "server":
      return copy.usageFailureServer;
    case "invalidResponse":
      return copy.usageFailureInvalidResponse;
    case "unknown":
      return copy.usageFailureUnknown;
  }
}

function formatUsageFetchedAt(epochSec: number | null | undefined, locale: string): string | null {
  if (!epochSec) {
    return null;
  }

  return new Date(epochSec * 1000).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function UsageFreshnessBadge({
  account,
  refreshing,
  showInitialRefresh,
  refreshError,
  locale,
  copy,
}: {
  account: AccountSummary;
  refreshing: boolean;
  showInitialRefresh: boolean;
  refreshError: string | null;
  locale: string;
  copy: UsageFreshnessCopy;
}) {
  const fetchedAt = formatUsageFetchedAt(account.usage?.fetchedAt, locale);
  const error = account.usageError || refreshError;
  let tone: UsageFreshnessTone = "unknown";
  let label = copy.usageUnavailable;

  if (showInitialRefresh && refreshing) {
    tone = "refreshing";
    label = fetchedAt
      ? copy.usageRefreshingCached(fetchedAt)
      : copy.usageRefreshing;
  } else if (error) {
    tone = "error";
    const reason = summarizeUsageRefreshError(error, copy);
    label = fetchedAt
      ? copy.usageRefreshFailedCached(reason, fetchedAt)
      : copy.usageRefreshFailed(reason);
  } else if (fetchedAt) {
    return null;
  }

  return (
    <span
      className={`usageFreshnessBadge tone-${tone}`}
      title={error ?? label}
      aria-label={label}
    >
      <span className="usageFreshnessDot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function UsageMeter({
  label,
  windowLabel,
  window,
  text,
  className,
}: {
  label: string;
  windowLabel: "1w";
  window: UsageWindow | null;
  text: UiCopy;
  className?: string;
}) {
  const value = usedPercent(window);
  const remaining = remainingPercent(window);
  const tone = remaining !== null && remaining <= 0 ? "danger" : remaining !== null && remaining < 15 ? "warning" : "normal";

  return (
    <div className={`usageMeter tone-${tone}${className ? ` ${className}` : ""}`}>
      <div className="usageMeterHead">
        <span>{label}</span>
        <strong>{percent(value)}</strong>
      </div>
      <div className="usageBar" aria-hidden="true">
        <span style={{ width: toProgressWidth(value) }} />
      </div>
      <div className="usageMeterFoot">
        <span>{text.remainingSuffix(percent(remaining))}</span>
        <span>{windowLabel}</span>
      </div>
      <span className="visuallyHidden">
        {label} {percent(value)} {text.remainingSuffix(percent(remaining))}
      </span>
    </div>
  );
}

function TokenUsageStrip({
  tokenUsage,
  tokenUsageError,
  locale,
  text,
  accountCount,
  exportingAccounts,
  onExportAll,
}: {
  tokenUsage: CodexTokenUsageSnapshot | null;
  tokenUsageError: string | null;
  locale: string;
  text: UiCopy;
  accountCount: number;
  exportingAccounts: boolean;
  onExportAll: () => void;
}) {
  const items = [
    { label: "24H", value: tokenUsage?.last24hEffectiveTokens },
    { label: "3D", value: tokenUsage?.last3dEffectiveTokens },
    { label: "7D", value: tokenUsage?.last7dEffectiveTokens },
    { label: "30D", value: tokenUsage?.last30dEffectiveTokens },
  ];

  return (
    <section className="accountTokenUsageStrip" aria-label={text.tokenUsageTitle}>
      <strong title={text.tokenUsageHint}>{text.tokenUsageTitle}</strong>
      <div className="accountTokenUsageItems">
        {items.map((item) => (
          <span key={item.label} className="accountTokenUsageItem">
            <em>{item.label}</em>
            <b>{formatTokenCount(item.value, locale)}</b>
          </span>
        ))}
      </div>
      <div className="accountTokenUsageActions">
        {tokenUsageError ? <span className="accountTokenUsageError">{text.tokenUsageError}</span> : null}
        <button
          className="ghost accountTokenExportButton"
          type="button"
          onClick={onExportAll}
          disabled={exportingAccounts || accountCount === 0}
          aria-label={text.exportAll}
        >
          <ActionIcon type="export" />
          <span>{text.exportAll}</span>
        </button>
      </div>
    </section>
  );
}

function copyAccountText(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function SearchIcon() {
  return (
    <svg className="searchIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg className="rowIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 6h.01" />
      <path d="M12 12h.01" />
      <path d="M12 18h.01" />
    </svg>
  );
}

function ActionIcon({ type }: { type: "login" | "test" | "export" | "delete" | "switch" }) {
  if (type === "delete") {
    return (
      <svg className="actionIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="m19 6-1 14H6L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
      </svg>
    );
  }

  if (type === "export") {
    return (
      <svg className="actionIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="8" y="8" width="10" height="12" rx="2" />
        <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }

  if (type === "login") {
    return (
      <svg className="actionIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }

  if (type === "test") {
    return (
      <svg className="actionIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 12h3l2-5 4 10 2-5h5" />
      </svg>
    );
  }

  return (
    <svg className="actionIconGlyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

export function AccountsGrid({
  leadingContent,
  toolbarActions,
  accounts,
  tokenUsage,
  tokenUsageError,
  loading,
  usageRefreshing,
  showInitialUsageRefresh,
  usageRefreshError,
  exportingAccounts,
  authBusy,
  switchingId,
  testingAccountId,
  pendingDeleteId,
  onExportAll,
  onExport,
  onReauthorize,
  onTestStatus,
  onToggleApiProxy,
  onSwitch,
  onDelete,
}: AccountsGridProps) {
  const { copy, locale } = useI18n();
  const text = getUiCopy(locale);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [preferredVariantByGroup, setPreferredVariantByGroup] = useState<Record<string, string>>({});
  const [openMenuAccountId, setOpenMenuAccountId] = useState<string | null>(null);
  const openMenuRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenuAccountId || typeof document === "undefined") {
      return undefined;
    }

    const closeOpenMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && openMenuRootRef.current?.contains(target)) {
        return;
      }

      setOpenMenuAccountId(null);
    };

    document.addEventListener("pointerdown", closeOpenMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOpenMenu, true);
    };
  }, [openMenuAccountId]);

  const groupedAccounts = useMemo<AccountGroup[]>(() => {
    const groups = new Map<string, AccountSummary[]>();

    for (const account of accounts) {
      const existing = groups.get(account.accountKey);
      if (existing) {
        existing.push(account);
      } else {
        groups.set(account.accountKey, [account]);
      }
    }

    return Array.from(groups.entries()).map(([id, variants]) => ({
      id,
      variants: [...variants].sort(sortVariantsForGroup),
    }));
  }, [accounts]);

  const rows = useMemo<AccountRow[]>(() => {
    const mapped = groupedAccounts.map((group) => {
      const fallbackVariant = group.variants[0];
      if (!fallbackVariant) {
        throw new Error(`Account group ${group.id} has no variants`);
      }

      const preferredId = preferredVariantByGroup[group.id];
      const preferred = preferredId
        ? group.variants.find((account) => account.id === preferredId)
        : null;
      const activeVariant =
        group.variants.find((account) => account.id === switchingId) ||
        group.variants.find((account) => account.isCurrent) ||
        preferred ||
        fallbackVariant;

      return {
        ...group,
        account: activeVariant,
      };
    });

    return mapped.sort((left, right) => {
      if (left.account.isCurrent !== right.account.isCurrent) {
        return left.account.isCurrent ? -1 : 1;
      }
      return compareAccountsByRemaining(left.account, right.account);
    });
  }, [groupedAccounts, preferredVariantByGroup, switchingId]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rows.filter((row) => {
      const account = row.account;
      const status = getAccountStatus(account, undefined, usageRefreshError);
      const normalizedPlan = (account.planType || account.usage?.planType || "unknown").toLowerCase();
      const haystack = [
        account.label,
        account.email,
        account.accountId,
        account.accountKey,
        account.apiBaseUrl,
        account.modelName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!normalizedQuery || haystack.includes(normalizedQuery)) &&
        (statusFilter === "all" || status === statusFilter) &&
        (planFilter === "all" || normalizedPlan === planFilter)
      );
    });
  }, [planFilter, query, rows, statusFilter, usageRefreshError]);

  const selectedRow =
    filteredRows.find((row) => row.account.id === selectedAccountId) ||
    rows.find((row) => row.account.id === selectedAccountId) ||
    filteredRows[0] ||
    rows[0] ||
    null;

  const selectAccount = (accountId: string) => {
    setOpenMenuAccountId(null);
    setSelectedAccountId(accountId);
  };

  const selectVariant = (groupId: string, account: AccountSummary) => {
    setPreferredVariantByGroup((current) => ({
      ...current,
      [groupId]: account.id,
    }));
    selectAccount(account.id);
  };

  const handleSwitch = async (account: AccountSummary) => {
    if (authBusy) {
      return;
    }

    setOpenMenuAccountId(null);
    await onSwitch(account);
  };

  return (
    <section className="accountsWorkspace" aria-busy={loading}>
      <div className="accountListStack">
        {leadingContent ? <div className="accountListLeading">{leadingContent}</div> : null}
        <div className="accountListPanel">
          <div className="accountToolbar">
            <label className="accountSearch">
              <SearchIcon />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={text.searchPlaceholder}
                aria-label={text.searchPlaceholder}
              />
            </label>
            <div className="accountFilters">
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as StatusFilter)}>
                <option value="all">{text.allStatuses}</option>
                <option value="using">{text.statusUsing}</option>
                <option value="available">{text.statusAvailable}</option>
                <option value="low">{text.statusLow}</option>
                <option value="exhausted">{text.statusExhausted}</option>
                <option value="checkFailed">{text.statusCheckFailed}</option>
                <option value="issue">{text.statusIssue}</option>
              </select>
              <select value={planFilter} onChange={(event) => setPlanFilter(event.currentTarget.value)}>
                <option value="all">{text.allPlans}</option>
                <option value="pro">PRO</option>
                <option value="plus">PLUS</option>
                <option value="team">TEAM</option>
                <option value="enterprise">ENTERPRISE</option>
                <option value="business">BUSINESS</option>
                <option value="api">API</option>
                <option value="free">FREE</option>
              </select>
            </div>
            {toolbarActions ? <div className="accountToolbarActions">{toolbarActions}</div> : null}
          </div>

          {filteredRows.length === 0 && !loading ? (
            <div className="emptyState accountEmptyState">
              <h3>{accounts.length === 0 ? copy.accountsGrid.emptyTitle : text.noMatchesTitle}</h3>
              <p>{accounts.length === 0 ? copy.accountsGrid.emptyDescription : text.noMatchesDescription}</p>
            </div>
          ) : (
            <div className="accountListFrame">
              <TokenUsageStrip
                tokenUsage={tokenUsage}
                tokenUsageError={tokenUsageError}
                locale={locale}
                text={text}
                accountCount={accounts.length}
                exportingAccounts={exportingAccounts}
                onExportAll={onExportAll}
              />
              <div className="accountListHeader" aria-hidden="true">
                <span>{copy.bottomDock.accounts}</span>
                <span>{text.weekUsage}</span>
                <span>{text.subscriptionExpiry}</span>
                <span>{text.nextResetTime}</span>
                <span>{text.proxyEnabled}</span>
                <span>{text.switchAccount}</span>
              </div>
              <div className="accountRows">
                {filteredRows.map((row) => {
                const account = row.account;
                const status = getAccountStatus(account, undefined, usageRefreshError);
                const normalizedPlan = account.planType || account.usage?.planType;
                const isSelected = selectedRow?.account.id === account.id;
                const isSwitching = switchingId === account.id;
                // 统一锁住切换入口，避免登录/导入/切换流程互相并发。
                const switchDisabled = authBusy;
                const isDeletePending = pendingDeleteId === account.id;
                const isMenuOpen = openMenuAccountId === account.id;
                const accountAddress = displayAccountAddress(account, text.emptyValue);
                const issueReason = accountIssueReason(
                  account,
                  text.issueFallbackReason,
                  usageRefreshError,
                );
                const subscriptionExpiry = subscriptionExpiryDisplay(
                  account,
                  locale,
                  text,
                );

                return (
                  <article
                    key={row.id}
                    className={`accountRow status-${status}${isSelected ? " isSelected" : ""}${isMenuOpen ? " isMenuOpen" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectAccount(account.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectAccount(account.id);
                      }
                    }}
                  >
                    <div className="accountIdentityCell">
                      <span className={`accountAvatar tone-${planTone(normalizedPlan)}`}>
                        {accountInitial(account)}
                      </span>
                      <span className="accountIdentityText">
                        <span className="accountTitleLine">
                          {row.variants.map((variant) => {
                            const plan = formatPlan(
                              variant.planType || variant.usage?.planType,
                              copy.accountCard.planLabels,
                            );
                            const isVariantSelected = variant.id === account.id;

                            return (
                              <button
                                key={variant.id}
                                type="button"
                                className={`planChip tone-${planTone(variant.planType || variant.usage?.planType)}${
                                  isVariantSelected ? " isSelected" : ""
                                }`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectVariant(row.id, variant);
                                }}
                                aria-pressed={isVariantSelected}
                              >
                              {plan}
                            </button>
                          );
                          })}
                          <button
                            type="button"
                            className="accountAddressButton accountPrimaryAddress"
                            title={accountAddress}
                            onClick={(event) => {
                              event.stopPropagation();
                              copyAccountText(accountAddress);
                            }}
                          >
                            {accountAddress}
                          </button>
                        </span>
                        <span className="accountStateLine">
                          <span
                            className={`statusText status-${status}`}
                            title={
                              status === "issue" || status === "checkFailed"
                                ? (issueReason ?? text.issueFallbackReason)
                                : statusLabel(status, text)
                            }
                          >
                            <span className="statusDot" />
                            <span className="statusLabel">{statusLabel(status, text)}</span>
                            {status === "issue" || status === "checkFailed" ? (
                              <span className="statusReason">{issueReason ?? text.issueFallbackReason}</span>
                            ) : null}
                          </span>
                          <UsageFreshnessBadge
                            account={account}
                            refreshing={usageRefreshing}
                            showInitialRefresh={showInitialUsageRefresh}
                            refreshError={usageRefreshError}
                            locale={locale}
                            copy={copy.accountsGrid}
                          />
                        </span>
                      </span>
                    </div>
                    <UsageMeter
                      className="accountUsageWeek"
                      label={text.weekUsage}
                      windowLabel="1w"
                      window={account.usage?.oneWeek ?? null}
                      text={text}
                    />
                    <div className="dateCell subscriptionCell">
                      <strong title={subscriptionExpiry.title}>
                        {subscriptionExpiry.label}
                      </strong>
                    </div>
                    <div className="resetCell">
                      <strong>{formatDateTime(nextUsageResetAt(account), locale, text.emptyValue)}</strong>
                    </div>
                    <label className="rowToggle" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={account.apiProxyEnabled}
                        onChange={(event) => {
                          void onToggleApiProxy(account, event.currentTarget.checked);
                        }}
                        aria-label={copy.accountCard.apiProxyToggle}
                      />
                      <span />
                    </label>
                    <div className="rowActions" ref={isMenuOpen ? openMenuRootRef : undefined}>
                      <button
                        type="button"
                        className="rowSwitchButton"
                        disabled={switchDisabled}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleSwitch(account);
                        }}
                      >
                        {isSwitching ? copy.accountCard.launching : text.switchAccount}
                      </button>
                      <button
                        type="button"
                        className={`rowMoreButton${isDeletePending ? " isPending" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenMenuAccountId(isMenuOpen ? null : account.id);
                        }}
                        title={text.quickActions}
                        aria-label={text.quickActions}
                        aria-expanded={isMenuOpen}
                      >
                        <MoreIcon />
                      </button>
                      {isMenuOpen ? (
                        <div className="rowActionMenu" onClick={(event) => event.stopPropagation()}>
                          <button
                            type="button"
                            disabled={testingAccountId === account.id}
                            onClick={() => {
                              setOpenMenuAccountId(null);
                              void onTestStatus(account);
                            }}
                          >
                            <ActionIcon type="test" />
                            {testingAccountId === account.id ? text.testingStatus : text.testStatus}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuAccountId(null);
                              onReauthorize(account);
                            }}
                          >
                            <ActionIcon type="login" />
                            {text.reauthorize}
                          </button>
                          <button
                            type="button"
                            disabled={exportingAccounts}
                            onClick={() => {
                              setOpenMenuAccountId(null);
                              onExport(account);
                            }}
                          >
                            <ActionIcon type="export" />
                            {text.exportAccount}
                          </button>
                          <button
                            type="button"
                            className="dangerMenuItem"
                            onClick={() => {
                              setOpenMenuAccountId(null);
                              onDelete(account);
                            }}
                          >
                            <ActionIcon type="delete" />
                            {text.deleteAccount}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
