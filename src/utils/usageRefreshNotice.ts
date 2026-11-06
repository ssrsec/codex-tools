import type { AccountSummary, Notice } from "../types/app";
import {
  classifyUsageRefreshError,
  type UsageRefreshFailureKind,
} from "./usageRefreshError.ts";

// 本模块只做“用量刷新结果的提示文案”这一件事：
// - 不按值引入 i18n/catalog（node:test 无法加载 JSON import），copy 只用本地结构类型；
// - 不输出上游原始错误（可能含英文/URL/HTML），统一用既有 reason 分类 + 短中文标签；
// - partial 文案固定中文，避免为此新增多语言键引发生成期缺键崩溃。

/** 本模块用到的多语言文案子集（由调用方传入 useI18n() 的 copy 即可）。 */
export type UsageRefreshNoticeCopy = {
  accountsGrid: Record<UsageRefreshFailureKey, string>;
  notices: {
    usageRefreshed: string;
    refreshFailed: (error: string) => string;
  };
};

type UsageRefreshFailureKey =
  | "usageFailureTimeout"
  | "usageFailureNetwork"
  | "usageFailureAuthorization"
  | "usageFailureRateLimited"
  | "usageFailureServer"
  | "usageFailureInvalidResponse"
  | "usageFailureUnknown";

const FAILURE_LABEL_KEYS: Record<UsageRefreshFailureKind, UsageRefreshFailureKey> = {
  timeout: "usageFailureTimeout",
  network: "usageFailureNetwork",
  authorization: "usageFailureAuthorization",
  rateLimited: "usageFailureRateLimited",
  server: "usageFailureServer",
  invalidResponse: "usageFailureInvalidResponse",
  unknown: "usageFailureUnknown",
};

export type UsageRefreshNotice = {
  type: "info" | "error";
  message: string;
};

export type UsageRefreshNoticeOptions = {
  quiet: boolean;
  promptedRelogin: boolean;
};

/** 把单条 usageError 收敛为既有的短中文标签，绝不回显原始错误文本。 */
function failureReasonLabel(
  error: string,
  copy: UsageRefreshNoticeCopy,
): string {
  return copy.accountsGrid[FAILURE_LABEL_KEYS[classifyUsageRefreshError(error)]];
}

/**
 * 汇总一次 refresh_all_usage 结果的失败提示。
 *
 * 规则（与方案 §3 一致）：
 * - 只统计 ChatGPT 账号：Relay 不在后端刷新目标里，其 usageError 不代表本次刷新失败；
 * - 按 accountKey 去重（同账号多套餐变体只算一次），同一 key 按输入顺序取第一个非空错误；
 * - 0 失败返回 null（调用方展示“用量已刷新”）；
 * - 部分失败返回 info，文案带 failed/total 与去重后的短原因；
 * - 全部失败返回 error，复用 copy.notices.refreshFailed(短原因)。
 */
export function buildUsageRefreshNotice(
  accounts: readonly AccountSummary[],
  copy: UsageRefreshNoticeCopy,
): UsageRefreshNotice | null {
  const errorsByAccountKey = new Map<string, string | null>();

  for (const account of accounts) {
    if (account.sourceKind === "relay") {
      continue;
    }
    const accountKey = account.accountKey || account.id;
    const error = account.usageError?.trim() || null;
    if (!errorsByAccountKey.has(accountKey)) {
      errorsByAccountKey.set(accountKey, error);
      continue;
    }
    // 同一 key 的多个套餐变体：第一项没错误时，继续用后续出现的首个非空错误。
    if (errorsByAccountKey.get(accountKey) === null && error !== null) {
      errorsByAccountKey.set(accountKey, error);
    }
  }

  const total = errorsByAccountKey.size;
  const failures = [...errorsByAccountKey.values()].filter(
    (error): error is string => error !== null,
  );
  if (failures.length === 0) {
    return null;
  }

  const reasons: string[] = [];
  for (const failure of failures) {
    const label = failureReasonLabel(failure, copy);
    if (!reasons.includes(label)) {
      reasons.push(label);
    }
  }
  const reason = reasons.join("、");

  if (failures.length === total) {
    return { type: "error", message: copy.notices.refreshFailed(reason) };
  }
  return {
    type: "info",
    message: `已刷新，但有 ${failures.length}/${total} 个账号失败：${reason}`,
  };
}

/**
 * 供 refreshUsage 直接使用的最终提示：
 * quiet（轮询/启动）与 promptedRelogin（applyAccounts 已弹重新登录）时不追加提示；
 * 无失败时返回现有“用量已刷新”的 ok 提示。
 * 抽出纯函数以便覆盖 hook 的 quiet/relogin 分支（无需 React 渲染）。
 */
export function resolveUsageRefreshNotice(
  accounts: readonly AccountSummary[],
  copy: UsageRefreshNoticeCopy,
  options: UsageRefreshNoticeOptions,
): Notice | null {
  if (options.quiet || options.promptedRelogin) {
    return null;
  }
  const failureNotice = buildUsageRefreshNotice(accounts, copy);
  if (failureNotice) {
    return failureNotice;
  }
  return { type: "ok", message: copy.notices.usageRefreshed };
}
