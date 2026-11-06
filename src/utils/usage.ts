import type { UsageSnapshot, UsageWindow } from "../types/app";

export function percent(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "--";
  }
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

export function formatTokenCount(value: number | undefined | null, locale?: string): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "--";
  }

  const normalized = Math.max(0, value);
  if (normalized < 1000) {
    return new Intl.NumberFormat(locale).format(normalized);
  }

  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: normalized < 100_000 ? 1 : 0,
  }).format(normalized);
}

/** 所有主额度窗口：five_hour + one_week + windows[]（与后端耗尽判定口径一致）。 */
export function mainUsageWindows(
  usage: UsageSnapshot | null | undefined,
): UsageWindow[] {
  if (!usage) {
    return [];
  }
  return [
    ...(usage.fiveHour ? [usage.fiveHour] : []),
    ...(usage.oneWeek ? [usage.oneWeek] : []),
    ...(usage.windows ?? []).filter((window) =>
      Number.isFinite(window?.windowSeconds),
    ),
  ];
}

/**
 * 主额度展示窗口：优先 one_week；没有周窗口时取 windows[] 中最长的窗口。
 * 后端 M4 起 30 天窗口只放在 windows[]（不冒充周窗口），free 账号靠这里显示“30天”。
 */
export function primaryUsageWindow(
  usage: UsageSnapshot | null | undefined,
): UsageWindow | null {
  if (!usage) {
    return null;
  }
  if (usage.oneWeek) {
    return usage.oneWeek;
  }
  if (usage.fiveHour) {
    return usage.fiveHour;
  }
  const extra = (usage.windows ?? []).filter((window) =>
    Number.isFinite(window?.windowSeconds),
  );
  if (extra.length === 0) {
    return null;
  }
  return extra.reduce((longest, window) =>
    window.windowSeconds > longest.windowSeconds ? window : longest,
  );
}

/** credits 是否真的可用（与后端 usage_credits_available 对齐）。 */
export function usageCreditsAvailable(
  usage: UsageSnapshot | null | undefined,
): boolean {
  const credits = usage?.credits;
  if (!credits) {
    return false;
  }
  if (credits.unlimited) {
    return true;
  }
  if (!credits.hasCredits) {
    return false;
  }
  const rawBalance = credits.balance?.trim().replace(/^\$/, "").trim();
  if (!rawBalance) {
    return false;
  }
  const balance = Number(rawBalance);
  return Number.isFinite(balance) && balance > 0;
}

export function remainingPercent(window: UsageWindow | null): number | null {
  if (!window) {
    return null;
  }
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function toProgressWidth(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "0%";
  }
  const clamped = Math.max(0, Math.min(100, value));
  return `${clamped}%`;
}

/**
 * 中文档位显示名的兜底表（与后端 plan 归一化口径对齐）。
 * 优先使用 locale 的 planLabels；这里保证 prolite/promax 等新 slug 在
 * 仅中文界面下也有可读名称，未知值保留原值以免丢失后端信息。
 */
const PLAN_DISPLAY_ZH: Record<string, string> = {
  prolite: "Pro 100",
  pro: "Pro 200",
  promax: "Pro 500",
  free: "免费",
  free_workspace: "免费",
  guest: "免费",
  plus: "Plus",
  go: "Go",
  team: "Business",
  business: "Business",
  enterprise: "Enterprise",
  api: "API",
};

export type PlanGroup =
  | "pro"
  | "free"
  | "plus"
  | "go"
  | "business"
  | "enterprise"
  | "api"
  | "edu"
  | "unknown";

/** 把官方 plan slug 归入展示/筛选分组；Pro 三档（prolite/pro/promax）同组。 */
export function planGroup(plan: string | null | undefined): PlanGroup {
  const normalized = plan?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return "unknown";
  }
  if (
    normalized === "prolite" ||
    normalized === "pro" ||
    normalized === "promax"
  ) {
    return "pro";
  }
  if (
    normalized === "free" ||
    normalized === "free_workspace" ||
    normalized === "guest"
  ) {
    return "free";
  }
  if (normalized === "plus") return "plus";
  if (normalized === "go") return "go";
  if (normalized === "team" || normalized === "business") return "business";
  if (normalized === "enterprise") return "enterprise";
  if (normalized === "api" || normalized === "relay") return "api";
  if (normalized.startsWith("edu")) return "edu";
  return "unknown";
}

/** 中文档位显示名；未知值原样返回。 */
export function planDisplay(plan: string | null | undefined): string {
  const raw = plan?.trim() ?? "";
  if (!raw) {
    return "";
  }
  const normalized = raw.toLowerCase();
  const mapped = PLAN_DISPLAY_ZH[normalized];
  if (mapped) {
    return mapped;
  }
  if (planGroup(normalized) === "edu") {
    return "Edu";
  }
  return raw;
}

export function formatPlan(
  plan: string | null | undefined,
  labels?: Record<string, string>,
): string {
  const raw = plan?.trim() ?? "";
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return labels?.unknown ?? "未知";
  }
  const labeled = labels?.[normalized];
  if (labeled) {
    return labeled;
  }
  return planDisplay(raw) || labels?.unknown || "未知";
}

export function planTone(plan: string | null | undefined): string {
  const normalized = plan?.trim().toLowerCase() ?? "";
  // 与后端 plan_tone_group 对齐：team 与 business 的展示名同为 Business，
  // 但 tone 仍是两个不同色系，不能合并。
  if (normalized === "team") {
    return "team";
  }
  switch (planGroup(normalized)) {
    case "pro":
      return "pro";
    case "free":
      return "free";
    case "plus":
      return "plus";
    case "business":
      return "business";
    case "enterprise":
      return "enterprise";
    case "api":
      return "api";
    default:
      return "unknown";
  }
}

export function formatResetAt(epochSec: number | null | undefined, locale?: string): string {
  if (!epochSec) {
    return "--";
  }
  return new Date(epochSec * 1000).toLocaleString(locale);
}

type WindowLabelOptions = {
  fallback: string;
  oneWeek: string;
  hourSuffix: string;
  minuteSuffix: string;
};

const FIVE_HOUR_LABEL_MAX_SECONDS = 6 * 3_600;
const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_WINDOW_SECONDS = 604_800;
const ONE_WEEK_TOLERANCE_SECONDS = 12 * 3_600;

/**
 * 按后端返回的窗口秒数生成中文标签（秒是唯一可信单位）。
 * 口径：≈5 小时 → “5小时”；≈7 天 → “1周”；≥28 天 → “N天”；其余 → “N小时”。
 * locale 传入的 oneWeek/hourSuffix/minuteSuffix 仅用于保持调用方签名兼容。
 */
export function formatWindowLabel(
  window: UsageWindow | null,
  { fallback }: WindowLabelOptions,
): string {
  if (!window?.windowSeconds || !Number.isFinite(window.windowSeconds)) {
    return fallback;
  }
  const seconds = Math.max(0, window.windowSeconds);
  if (seconds <= FIVE_HOUR_LABEL_MAX_SECONDS) {
    return "5小时";
  }
  const roundedDays = Math.round(seconds / ONE_DAY_SECONDS);
  if (
    roundedDays === 7 ||
    Math.abs(seconds - ONE_WEEK_WINDOW_SECONDS) <= ONE_WEEK_TOLERANCE_SECONDS
  ) {
    return "1周";
  }
  if (seconds >= 28 * ONE_DAY_SECONDS) {
    return `${roundedDays}天`;
  }
  return `${Math.max(1, Math.round(seconds / 3_600))}小时`;
}
