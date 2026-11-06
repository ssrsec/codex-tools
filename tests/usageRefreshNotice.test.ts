import assert from "node:assert/strict";
import test from "node:test";
import type { AccountSummary } from "../src/types/app.ts";
import {
  buildUsageRefreshNotice,
  resolveUsageRefreshNotice,
} from "../src/utils/usageRefreshNotice.ts";
import type { UsageRefreshNoticeCopy } from "../src/utils/usageRefreshNotice.ts";

// 只测试本模块的逻辑；copy 用中文 mock，避免 node:test 按值加载 i18n 的 JSON import。
const copy: UsageRefreshNoticeCopy = {
  accountsGrid: {
    usageFailureTimeout: "请求超时",
    usageFailureNetwork: "网络连接失败",
    usageFailureAuthorization: "授权异常",
    usageFailureRateLimited: "已达用量或请求限制",
    usageFailureServer: "服务暂不可用",
    usageFailureInvalidResponse: "返回数据无效",
    usageFailureUnknown: "未知错误",
  },
  notices: {
    usageRefreshed: "用量已刷新",
    refreshFailed: (error) => `刷新失败：${error}`,
  },
};

function account(
  overrides: Partial<AccountSummary> & { accountKey?: string; usageError?: string | null },
): AccountSummary {
  const accountKey = overrides.accountKey ?? overrides.id ?? "account";
  return {
    id: overrides.id ?? accountKey,
    label: overrides.label ?? accountKey,
    sourceKind: overrides.sourceKind ?? "chatgpt",
    email: null,
    accountKey,
    accountId: overrides.accountId ?? accountKey,
    planType: null,
    subscriptionActiveUntil: null,
    apiBaseUrl: null,
    modelName: null,
    balanceText: null,
    profileAuthReady: true,
    profileConfigReady: true,
    profileIntegrityError: null,
    profileLastValidatedAt: null,
    profileLastValidationError: null,
    addedAt: 0,
    updatedAt: 0,
    usage: null,
    usageError: overrides.usageError ?? null,
    authRefreshBlocked: false,
    authRefreshError: null,
    apiProxyEnabled: true,
    isCurrent: false,
    ...overrides,
  };
}

test("空账号列表：build 返回 null，resolve 给出既有“用量已刷新”", () => {
  assert.equal(buildUsageRefreshNotice([], copy), null);
  assert.deepEqual(
    resolveUsageRefreshNotice([], copy, { quiet: false, promptedRelogin: false }),
    { type: "ok", message: "用量已刷新" },
  );
});

test("0 失败：build 返回 null（调用方展示 ok）", () => {
  const accounts = [account({ accountKey: "a" }), account({ accountKey: "b" })];
  assert.equal(buildUsageRefreshNotice(accounts, copy), null);
});

test("空白 usageError 视为无失败", () => {
  const accounts = [
    account({ accountKey: "a", usageError: "" }),
    account({ accountKey: "b", usageError: "   " }),
  ];
  assert.equal(buildUsageRefreshNotice(accounts, copy), null);
});

test("不同 key 部分失败：info，带 failed/total 与短原因", () => {
  const accounts = [
    account({ accountKey: "ok" }),
    account({ accountKey: "timeout", usageError: "operation timed out" }),
    account({ accountKey: "server", usageError: "503 Service Unavailable" }),
  ];
  assert.deepEqual(buildUsageRefreshNotice(accounts, copy), {
    type: "info",
    message: "已刷新，但有 2/3 个账号失败：请求超时、服务暂不可用",
  });
});

test("全部失败：error，复用 refreshFailed 与短原因", () => {
  const accounts = [
    account({ accountKey: "timeout", usageError: "operation timed out" }),
    account({ accountKey: "network", usageError: "DNS lookup failed" }),
  ];
  assert.deepEqual(buildUsageRefreshNotice(accounts, copy), {
    type: "error",
    message: "刷新失败：请求超时、网络连接失败",
  });
});

test("同 key 多套餐变体只计 1（部分失败）", () => {
  const accounts = [
    account({ accountKey: "multi", usageError: "operation timed out" }),
    account({ accountKey: "multi", usageError: "operation timed out" }),
    account({ accountKey: "ok" }),
  ];
  assert.deepEqual(buildUsageRefreshNotice(accounts, copy), {
    type: "info",
    message: "已刷新，但有 1/2 个账号失败：请求超时",
  });
});

test("同 key 多套餐变体全部失败也只计 1（全部失败）", () => {
  const accounts = [
    account({ accountKey: "multi", usageError: "operation timed out" }),
    account({ accountKey: "multi", usageError: "operation timed out" }),
  ];
  assert.deepEqual(buildUsageRefreshNotice(accounts, copy), {
    type: "error",
    message: "刷新失败：请求超时",
  });
});

test("全 Relay（含错误）：返回 null，不产生刷新失败提示", () => {
  const accounts = [
    account({ accountKey: "relay-a", sourceKind: "relay", usageError: "balance failed" }),
    account({ accountKey: "relay-b", sourceKind: "relay", usageError: "timeout" }),
  ];
  assert.equal(buildUsageRefreshNotice(accounts, copy), null);
  assert.deepEqual(
    resolveUsageRefreshNotice(accounts, copy, { quiet: false, promptedRelogin: false }),
    { type: "ok", message: "用量已刷新" },
  );
});

test("Relay 不计入 total；ChatGPT 失败数按去重后的 ChatGPT 账号计算", () => {
  const relayError = account({
    accountKey: "relay",
    sourceKind: "relay",
    usageError: "network failed",
  });
  const chatGptOk = account({ accountKey: "chatgpt-ok" });
  const chatGptFail = account({ accountKey: "chatgpt-fail", usageError: "operation timed out" });

  assert.deepEqual(buildUsageRefreshNotice([relayError, chatGptOk], copy), null);
  assert.deepEqual(buildUsageRefreshNotice([relayError, chatGptOk, chatGptFail], copy), {
    type: "info",
    message: "已刷新，但有 1/2 个账号失败：请求超时",
  });
});

test("同 key 按输入顺序取第一个错误（顺序敏感的确定性）", () => {
  const firstTimeout = account({ accountKey: "multi", usageError: "operation timed out" });
  const secondServer = account({ accountKey: "multi", usageError: "503 Service Unavailable" });
  const ok = account({ accountKey: "ok" });

  assert.deepEqual(buildUsageRefreshNotice([firstTimeout, secondServer, ok], copy), {
    type: "info",
    message: "已刷新，但有 1/2 个账号失败：请求超时",
  });
  assert.deepEqual(buildUsageRefreshNotice([secondServer, firstTimeout, ok], copy), {
    type: "info",
    message: "已刷新，但有 1/2 个账号失败：服务暂不可用",
  });
});

test("同 key 首个为空时取后续首个非空错误", () => {
  const accounts = [
    account({ accountKey: "multi", usageError: "" }),
    account({ accountKey: "multi", usageError: "operation timed out" }),
    account({ accountKey: "ok" }),
  ];
  assert.deepEqual(buildUsageRefreshNotice(accounts, copy), {
    type: "info",
    message: "已刷新，但有 1/2 个账号失败：请求超时",
  });
});

test("原因去重并保持首次出现顺序", () => {
  const accounts = [
    account({ accountKey: "a", usageError: "operation timed out" }),
    account({ accountKey: "b", usageError: "503 Service Unavailable" }),
    account({ accountKey: "c", usageError: "another timeout" }),
  ];
  assert.deepEqual(buildUsageRefreshNotice(accounts, copy), {
    type: "error",
    message: "刷新失败：请求超时、服务暂不可用",
  });
});

test("未知错误归类为“未知错误”", () => {
  const accounts = [
    account({ accountKey: "weird", usageError: "totally unexpected failure !!!" }),
    account({ accountKey: "ok" }),
  ];
  assert.deepEqual(buildUsageRefreshNotice(accounts, copy), {
    type: "info",
    message: "已刷新，但有 1/2 个账号失败：未知错误",
  });
});

test("message 不包含 raw 错误、URL、英文原文", () => {
  const accounts = [
    account({
      accountKey: "raw",
      usageError:
        "primary -> 503 Service Unavailable: https://chatgpt.com/backend-api/wham/usage <html>",
    }),
    account({ accountKey: "ok" }),
  ];
  const notice = buildUsageRefreshNotice(accounts, copy);
  assert.equal(notice?.type, "info");
  assert.equal(notice?.message, "已刷新，但有 1/2 个账号失败：服务暂不可用");
  assert.doesNotMatch(notice?.message ?? "", /https?:\/\//);
  assert.doesNotMatch(notice?.message ?? "", /<html>/);
  assert.doesNotMatch(notice?.message ?? "", /Service|Unavailable|primary/);
});

test("resolve：quiet 与 promptedRelogin 均不设置提示", () => {
  const failed = [
    account({ accountKey: "dead", usageError: "operation timed out" }),
    account({ accountKey: "ok" }),
  ];
  assert.equal(
    resolveUsageRefreshNotice(failed, copy, { quiet: true, promptedRelogin: false }),
    null,
  );
  assert.equal(
    resolveUsageRefreshNotice(failed, copy, { quiet: false, promptedRelogin: true }),
    null,
  );
  assert.deepEqual(
    resolveUsageRefreshNotice(failed, copy, { quiet: false, promptedRelogin: false }),
    {
      type: "info",
      message: "已刷新，但有 1/2 个账号失败：请求超时",
    },
  );
});

test("不修改传入的账号数组/对象", () => {
  const accounts = [
    account({ accountKey: "a", usageError: "operation timed out" }),
    account({ accountKey: "b" }),
  ];
  const snapshot = structuredClone(accounts);
  buildUsageRefreshNotice(accounts, copy);
  assert.deepEqual(accounts, snapshot);
});
