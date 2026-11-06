use std::collections::HashMap;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::auth::account_group_key;
use crate::auth::account_variant_key;
use crate::auth::chatgpt_subscription_active_until;
use crate::auth::extract_auth;
use crate::utils::now_unix_seconds;

pub(crate) const DEFAULT_API_PROXY_MODEL: &str = "gpt-5.6-sol";
pub(crate) const DEFAULT_API_PROXY_REASONING_EFFORT: &str = "xhigh";
pub(crate) const DEFAULT_API_PROXY_SERVICE_TIER: &str = "default";

fn default_api_proxy_service_tier() -> String {
    DEFAULT_API_PROXY_SERVICE_TIER.to_string()
}

fn default_api_proxy_port() -> u16 {
    8787
}

pub(crate) fn default_api_proxy_enabled() -> bool {
    true
}

pub(crate) fn default_api_proxy_sequential_five_hour_limit_percent() -> f64 {
    80.0
}

pub(crate) fn normalize_api_proxy_sequential_five_hour_limit_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        default_api_proxy_sequential_five_hour_limit_percent()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AccountsStore {
    #[serde(default = "default_store_version")]
    pub(crate) version: u8,
    #[serde(default)]
    pub(crate) accounts: Vec<StoredAccount>,
    #[serde(default)]
    pub(crate) settings: AppSettings,
}

fn default_store_version() -> u8 {
    2
}

impl Default for AccountsStore {
    fn default() -> Self {
        Self {
            version: default_store_version(),
            accounts: Vec::new(),
            settings: AppSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AccountSourceKind {
    Chatgpt,
    Relay,
}

impl Default for AccountSourceKind {
    fn default() -> Self {
        Self::Chatgpt
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAccount {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) source_kind: AccountSourceKind,
    #[serde(default)]
    pub(crate) principal_id: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) account_id: String,
    pub(crate) plan_type: Option<String>,
    pub(crate) auth_json: Value,
    #[serde(default)]
    pub(crate) api_base_url: Option<String>,
    #[serde(default)]
    pub(crate) api_key: Option<String>,
    #[serde(default)]
    pub(crate) model_name: Option<String>,
    #[serde(default)]
    pub(crate) balance_text: Option<String>,
    #[serde(default)]
    pub(crate) profile_auth_path: Option<String>,
    #[serde(default)]
    pub(crate) profile_config_path: Option<String>,
    #[serde(default)]
    pub(crate) profile_auth_ready: bool,
    #[serde(default)]
    pub(crate) profile_config_ready: bool,
    #[serde(default)]
    pub(crate) profile_integrity_error: Option<String>,
    #[serde(default)]
    pub(crate) profile_last_validated_at: Option<i64>,
    #[serde(default)]
    pub(crate) profile_last_validation_error: Option<String>,
    pub(crate) added_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) usage: Option<UsageSnapshot>,
    pub(crate) usage_error: Option<String>,
    #[serde(default)]
    pub(crate) auth_refresh_blocked: bool,
    #[serde(default)]
    pub(crate) auth_refresh_error: Option<String>,
    #[serde(default = "default_api_proxy_enabled")]
    pub(crate) api_proxy_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSummary {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) source_kind: AccountSourceKind,
    pub(crate) email: Option<String>,
    pub(crate) account_key: String,
    pub(crate) account_id: String,
    pub(crate) plan_type: Option<String>,
    pub(crate) subscription_active_until: Option<i64>,
    pub(crate) api_base_url: Option<String>,
    pub(crate) model_name: Option<String>,
    pub(crate) balance_text: Option<String>,
    pub(crate) profile_auth_ready: bool,
    pub(crate) profile_config_ready: bool,
    pub(crate) profile_integrity_error: Option<String>,
    pub(crate) profile_last_validated_at: Option<i64>,
    pub(crate) profile_last_validation_error: Option<String>,
    pub(crate) added_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) usage: Option<UsageSnapshot>,
    pub(crate) usage_error: Option<String>,
    pub(crate) auth_refresh_blocked: bool,
    pub(crate) auth_refresh_error: Option<String>,
    pub(crate) api_proxy_enabled: bool,
    pub(crate) is_current: bool,
}

/// Marks the summary that represents the active Codex identity.
///
/// A subscription plan is a state of an account, not the account's durable
/// identity. We therefore prefer an exact account-plus-plan match, but when a
/// refresh changes the plan label (for example, Plus to Pro), fall back to the
/// unique matching account group. If multiple historical plan variants remain,
/// the last account explicitly selected in this app is the safe tiebreaker.
pub(crate) fn mark_current_account_summary(
    summaries: &mut [AccountSummary],
    current_account_key: Option<&str>,
    active_account_id: Option<&str>,
) {
    if summaries.iter().any(|account| account.is_current) {
        return;
    }

    let matching_group_indexes = current_account_key
        .map(|current_account_key| {
            summaries
                .iter()
                .enumerate()
                .filter_map(|(index, account)| {
                    (account.account_key == current_account_key).then_some(index)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    match matching_group_indexes.as_slice() {
        [index] => {
            summaries[*index].is_current = true;
            return;
        }
        [] => {}
        _ => {
            if let Some(active_account_id) = active_account_id {
                if let Some(index) = matching_group_indexes
                    .into_iter()
                    .find(|index| summaries[*index].id == active_account_id)
                {
                    summaries[index].is_current = true;
                }
            }
            return;
        }
    }

    // Preserve the existing last-selected fallback when the current auth file
    // is unavailable or refers to an account that is not in this store.
    if let Some(active_account_id) = active_account_id {
        if let Some(account) = summaries
            .iter_mut()
            .find(|account| account.id == active_account_id)
        {
            account.is_current = true;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSnapshot {
    pub(crate) fetched_at: i64,
    pub(crate) plan_type: Option<String>,
    pub(crate) five_hour: Option<UsageWindow>,
    pub(crate) one_week: Option<UsageWindow>,
    /// 非 5h/周的标准窗口（如 30 天）。只用于判定与展示，不写入 five_hour/one_week。
    #[serde(default)]
    pub(crate) windows: Vec<UsageWindow>,
    /// 服务端是否允许继续使用（缺失 = 未知，按窗口判断）。
    #[serde(default)]
    pub(crate) allowed: Option<bool>,
    /// 服务端是否已判定触顶（比百分比更权威）。
    #[serde(default)]
    pub(crate) limit_reached: Option<bool>,
    /// 触顶类型对象里的 type 字段（如 workspace_member_credits_depleted）。
    #[serde(default)]
    pub(crate) rate_limit_reached_type: Option<String>,
    pub(crate) credits: Option<CreditSnapshot>,
    #[serde(default)]
    pub(crate) reset_credits: Option<ResetCreditsSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageWindow {
    pub(crate) used_percent: f64,
    pub(crate) window_seconds: i64,
    pub(crate) reset_at: Option<i64>,
}

pub(crate) fn plan_type_is_free(plan_type: Option<&str>) -> bool {
    plan_type
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("free"))
}

/// 归一化 plan slug：trim + 小写；空值 → `unknown`。
///
/// 官方枚举（来源：openai/codex 的 plan 枚举）按原值返回；未知值也原样保留，
/// **不做别名猜测**（避免把上游新增档位或别名误判成已知档位）。
pub(crate) fn normalize_plan_slug(raw: &str) -> String {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "unknown".to_string();
    }
    // 官方枚举按原值返回；未知值也原样保留（不做别名猜测，避免把上游新增档位误判）。
    normalized
}

/// 官方 plan 枚举（来源：openai/codex 的 plan 枚举；用于测试与排查，不做别名映射）。
#[cfg(test)]
const OFFICIAL_PLAN_SLUGS: &[&str] = &[
    "guest",
    "free",
    "free_workspace",
    "go",
    "plus",
    "pro",
    "prolite",
    "promax",
    "team",
    "self_serve_business_prolite",
    "self_serve_business_usage_based",
    "business",
    "ent26",
    "enterprise_cbp_automation",
    "enterprise_cbp_usage_based",
    "enterprise",
    "education",
    "edu",
    "edu_plus",
    "edu_pro",
    "quorum",
    "k12",
    "sci",
    "sci_plus",
    "unknown",
];

/// Pro 档位/套餐的中文展示名。
///
/// 说明：Rust 侧目前没有消费点（前端有独立的 TS 映射），这里先作为唯一事实源沉淀，
/// 供后续托盘/CLI/通知等 Rust 文案复用，避免各处再写一遍映射。
#[allow(dead_code)] // 桌面端 CLI/托盘使用；proxyd 独立 crate 不引用。
pub(crate) fn plan_display_zh(plan: Option<&str>) -> String {
    let slug = normalize_plan_slug(plan.unwrap_or_default());
    match slug.as_str() {
        "prolite" => "Pro 100".to_string(),
        "pro" => "Pro 200".to_string(),
        "promax" => "Pro 500".to_string(),
        "free" => "免费".to_string(),
        "plus" => "Plus".to_string(),
        "go" => "Go".to_string(),
        "team" | "business" => "Business".to_string(),
        "enterprise" => "Enterprise".to_string(),
        "edu" | "education" | "edu_plus" | "edu_pro" => "Edu".to_string(),
        _ => slug,
    }
}

/// 账号是否还有可用的 credits：unlimited 视为可用；
/// 否则要求 has_credits 且余额可解析 > 0。
pub(crate) fn usage_credits_available(usage: &UsageSnapshot) -> bool {
    let Some(credits) = usage.credits.as_ref() else {
        return false;
    };
    if credits.unlimited {
        return true;
    }
    if !credits.has_credits {
        return false;
    }
    credits
        .balance
        .as_deref()
        .and_then(parse_credit_balance)
        .is_some_and(|balance| balance > 0.0)
}

fn parse_credit_balance(raw: &str) -> Option<f64> {
    raw.trim()
        .trim_start_matches('$')
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|balance| balance.is_finite())
}

fn main_usage_windows(usage: &UsageSnapshot) -> impl Iterator<Item = &UsageWindow> {
    usage
        .five_hour
        .iter()
        .chain(usage.one_week.iter())
        .chain(usage.windows.iter())
}

/// 展示用的主额度窗口：优先周窗口，其次 5h，最后 windows[] 中 window_seconds 最大者。
///
/// 用于托盘/CLI 等只展示一个额度的位置；30 天等非标准窗口不写入 one_week，
/// 但仍应能作为主额度展示，避免显示成 --（两个短横线）。
#[allow(dead_code)] // 桌面端托盘/CLI 使用；proxyd 独立 crate 不引用。
pub(crate) fn usage_primary_window(usage: &UsageSnapshot) -> Option<&UsageWindow> {
    usage
        .one_week
        .as_ref()
        .or(usage.five_hour.as_ref())
        .or_else(|| {
            usage
                .windows
                .iter()
                .max_by(|left, right| left.window_seconds.cmp(&right.window_seconds))
        })
}

fn usage_window_is_blocking(window: &UsageWindow, usage: &UsageSnapshot, now: i64) -> bool {
    if !window.used_percent.is_finite() || window.used_percent < 100.0 {
        return false;
    }
    let reset_at = window.reset_at.unwrap_or_else(|| {
        usage
            .fetched_at
            .saturating_add(window.window_seconds.max(0))
    });
    reset_at > now
}

/// 主额度是否处于“被遏制”状态：服务端拒绝、服务端判触顶，或任一主窗口已满且未重置。
pub(crate) fn usage_included_blocked(usage: &UsageSnapshot, now: i64) -> bool {
    usage.allowed == Some(false)
        || usage.limit_reached == Some(true)
        || main_usage_windows(usage).any(|window| usage_window_is_blocking(window, usage, now))
}

/// 真值表：
/// - 服务端明确拒绝（allowed=false）→ 无条件耗尽（credits 也无法绕过）；
/// - credits 可用（unlimited 或有正余额）→ 不判耗尽；
/// - 否则按 limit_reached / 任一主窗口满且未重置判断。
/// 旧快照（allowed/limit_reached 均为 None、windows 为空）自然退化为“只看窗口”。
pub(crate) fn usage_has_active_exhausted_window(usage: Option<&UsageSnapshot>, now: i64) -> bool {
    let Some(usage) = usage else {
        return false;
    };

    if usage.allowed == Some(false) {
        return true;
    }
    if usage_credits_available(usage) {
        return false;
    }
    usage_included_blocked(usage, now)
}

/// 距离恢复可用的最晚重置时间（供反代冷却使用）；未处于遏制状态或没有可用的重置时间时返回 None。
pub(crate) fn usage_exhaustion_reset_at(usage: Option<&UsageSnapshot>, now: i64) -> Option<i64> {
    let usage = usage?;
    if !usage_has_active_exhausted_window(Some(usage), now) {
        return None;
    }

    main_usage_windows(usage)
        .filter(|window| usage_window_is_blocking(window, usage, now))
        .map(|window| {
            window.reset_at.unwrap_or_else(|| {
                usage
                    .fetched_at
                    .saturating_add(window.window_seconds.max(0))
            })
        })
        .filter(|reset_at| *reset_at > now)
        .max()
}

/// 反代排序用：所有主窗口中最紧的已用百分比（跳过已过期窗口，避免旧快照抬升排序）。
pub(crate) fn usage_most_constrained_used_percent(
    usage: Option<&UsageSnapshot>,
    now: i64,
) -> Option<f64> {
    let usage = usage?;
    main_usage_windows(usage)
        .filter(|window| match window.reset_at {
            // reset 未知时保留该窗口（老快照/测试 fixture），避免被误判为已过期而抬高排序。
            Some(reset_at) => reset_at > now,
            None => true,
        })
        .filter(|window| window.used_percent.is_finite())
        .map(|window| window.used_percent.clamp(0.0, 100.0))
        .reduce(f64::max)
}

pub(crate) fn usage_error_indicates_authorization_failure(error: Option<&str>) -> bool {
    let Some(error) = error else {
        return false;
    };
    let normalized = error.to_ascii_lowercase();
    normalized.contains("401")
        || normalized.contains("403")
        || normalized.contains("unauthorized")
        || normalized.contains("forbidden")
        || normalized.contains("invalid_token")
        || normalized.contains("authentication token")
        || normalized.contains("登录授权")
        || normalized.contains("账号被封禁")
        || normalized.contains("deactivated")
        || normalized.contains("被踢出 team 组织")
        || normalized.contains("被移出 team 组织")
        || normalized.contains("被移出工作区")
        || normalized.contains("不再是 team 组织成员")
        || normalized.contains("not a member of this workspace")
        || normalized.contains("not a member of the workspace")
        || normalized.contains("no longer a member of the workspace")
        || ((normalized.contains("removed from") || normalized.contains("lost access to"))
            && (normalized.contains("workspace")
                || normalized.contains("team")
                || normalized.contains("organization")))
}

pub(crate) fn account_is_eligible_for_automatic_use(account: &StoredAccount, now: i64) -> bool {
    if account.auth_refresh_blocked
        || usage_error_indicates_authorization_failure(account.usage_error.as_deref())
    {
        return false;
    }
    if matches!(account.source_kind, AccountSourceKind::Chatgpt)
        && plan_type_is_free(account.resolved_plan_type().as_deref())
    {
        return false;
    }
    !usage_has_active_exhausted_window(account.usage.as_ref(), now)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditSnapshot {
    pub(crate) has_credits: bool,
    pub(crate) unlimited: bool,
    pub(crate) balance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetCreditsSnapshot {
    pub(crate) available_count: Option<i64>,
    #[serde(default)]
    pub(crate) credits: Vec<ResetCredit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetCredit {
    pub(crate) granted_at: Option<i64>,
    pub(crate) expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchAccountResult {
    pub(crate) account_id: String,
    #[serde(default)]
    pub(crate) no_op: bool,
    pub(crate) launched_app_path: Option<String>,
    pub(crate) used_fallback_cli: bool,
    pub(crate) opencode_synced: bool,
    pub(crate) opencode_sync_error: Option<String>,
    pub(crate) opencode_desktop_restarted: bool,
    pub(crate) opencode_desktop_restart_error: Option<String>,
    pub(crate) restarted_editor_apps: Vec<EditorAppId>,
    pub(crate) editor_restart_error: Option<String>,
    pub(crate) provider_sync_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedOauthLogin {
    pub(crate) auth_url: String,
    pub(crate) redirect_uri: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ExtractedAuth {
    pub(crate) principal_id: String,
    pub(crate) account_id: String,
    pub(crate) access_token: String,
    pub(crate) email: Option<String>,
    pub(crate) plan_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthJsonImportInput {
    pub(crate) source: String,
    pub(crate) content: String,
    pub(crate) label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateApiAccountInput {
    pub(crate) label: String,
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    pub(crate) model_name: String,
    #[serde(default)]
    pub(crate) force_save: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestApiAccountConnectionInput {
    pub(crate) label: String,
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    pub(crate) model_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestApiAccountConnectionResult {
    pub(crate) ok: bool,
    pub(crate) balance_text: Option<String>,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestAccountStatusResult {
    pub(crate) account: AccountSummary,
    pub(crate) ok: bool,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupUnusableAccountsResult {
    pub(crate) deleted_ids: Vec<String>,
    pub(crate) deleted_count: usize,
    pub(crate) skipped_current_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCodexSessionResult {
    pub(crate) session_id: String,
    pub(crate) deleted_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportAccountFailure {
    pub(crate) source: String,
    pub(crate) error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportAccountsResult {
    pub(crate) total_count: usize,
    pub(crate) imported_count: usize,
    pub(crate) updated_count: usize,
    pub(crate) failures: Vec<ImportAccountFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OauthCallbackFinishedEvent {
    pub(crate) result: Option<ImportAccountsResult>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProxyStatus {
    pub(crate) running: bool,
    pub(crate) port: Option<u16>,
    pub(crate) api_key: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) lan_base_url: Option<String>,
    pub(crate) codex_proxy_bound: bool,
    pub(crate) codex_proxy_restore_available: bool,
    pub(crate) codex_proxy_base_url: Option<String>,
    pub(crate) codex_proxy_config_path: Option<String>,
    pub(crate) active_account_key: Option<String>,
    pub(crate) active_account_id: Option<String>,
    pub(crate) active_account_label: Option<String>,
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ApiProxyKey {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) key: String,
    pub(crate) enabled: bool,
    pub(crate) allowed_models: Vec<String>,
    pub(crate) allowed_reasoning_efforts: Vec<String>,
    pub(crate) allowed_service_tiers: Vec<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

impl Default for ApiProxyKey {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            key: String::new(),
            enabled: true,
            allowed_models: Vec::new(),
            allowed_reasoning_efforts: Vec::new(),
            allowed_service_tiers: Vec::new(),
            created_at: 0,
            updated_at: 0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateApiProxyKeyInput {
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) key: Option<String>,
    #[serde(default)]
    pub(crate) allowed_models: Vec<String>,
    #[serde(default)]
    pub(crate) allowed_reasoning_efforts: Vec<String>,
    #[serde(default)]
    pub(crate) allowed_service_tiers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateApiProxyKeyInput {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) enabled: Option<bool>,
    #[serde(default)]
    pub(crate) allowed_models: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) allowed_reasoning_efforts: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) allowed_service_tiers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProxyKeyUsageLogEntry {
    pub(crate) timestamp: i64,
    pub(crate) key_id: Option<String>,
    pub(crate) key_label: Option<String>,
    pub(crate) model: String,
    pub(crate) route: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) service_tier: Option<String>,
    pub(crate) calls: i64,
    pub(crate) tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProxyUsagePoint {
    pub(crate) timestamp: i64,
    pub(crate) calls: i64,
    pub(crate) tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProxyUsageSeries {
    pub(crate) model: String,
    pub(crate) total_calls: i64,
    pub(crate) total_tokens: i64,
    pub(crate) points: Vec<ApiProxyUsagePoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProxyUsageStats {
    pub(crate) updated_at: i64,
    pub(crate) range_seconds: i64,
    pub(crate) bucket_seconds: i64,
    pub(crate) series: Vec<ApiProxyUsageSeries>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ApiProxyLoadBalanceMode {
    #[default]
    Average,
    Sequential,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteAuthMode {
    KeyContent,
    KeyFile,
    KeyPath,
    Password,
}

impl Default for RemoteAuthMode {
    fn default() -> Self {
        Self::KeyPath
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteServerConfig {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) host: String,
    pub(crate) ssh_port: u16,
    pub(crate) ssh_user: String,
    #[serde(default)]
    pub(crate) auth_mode: RemoteAuthMode,
    #[serde(default)]
    pub(crate) identity_file: Option<String>,
    #[serde(default)]
    pub(crate) private_key: Option<String>,
    #[serde(default)]
    pub(crate) password: Option<String>,
    pub(crate) remote_dir: String,
    pub(crate) listen_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteProxyStatus {
    pub(crate) installed: bool,
    pub(crate) service_installed: bool,
    pub(crate) running: bool,
    pub(crate) enabled: bool,
    pub(crate) service_name: String,
    pub(crate) pid: Option<u32>,
    pub(crate) base_url: String,
    pub(crate) api_key: Option<String>,
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeployRemoteProxyInput {
    pub(crate) server: RemoteServerConfig,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CloudflaredTunnelMode {
    Quick,
    Named,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudflaredStatus {
    pub(crate) installed: bool,
    pub(crate) binary_path: Option<String>,
    pub(crate) running: bool,
    pub(crate) tunnel_mode: Option<CloudflaredTunnelMode>,
    pub(crate) public_url: Option<String>,
    pub(crate) custom_hostname: Option<String>,
    pub(crate) use_http2: bool,
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NamedCloudflaredTunnelInput {
    pub(crate) api_token: String,
    pub(crate) account_id: String,
    pub(crate) zone_id: String,
    pub(crate) hostname: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartCloudflaredTunnelInput {
    pub(crate) api_proxy_port: u16,
    pub(crate) use_http2: bool,
    pub(crate) mode: CloudflaredTunnelMode,
    pub(crate) named: Option<NamedCloudflaredTunnelInput>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrayUsageDisplayMode {
    Used,
    Hidden,
    FiveHourRemaining,
    #[default]
    OneWeekRemaining,
    Remaining,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EditorAppId {
    Vscode,
    VscodeInsiders,
    Cursor,
    Antigravity,
    Kiro,
    Trae,
    Qoder,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub(crate) enum AppLocale {
    #[default]
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "ja-JP")]
    JaJp,
    #[serde(rename = "ko-KR")]
    KoKr,
    #[serde(rename = "ru-RU")]
    RuRu,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledEditorApp {
    pub(crate) id: EditorAppId,
    pub(crate) label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AppSettings {
    pub(crate) launch_at_startup: bool,
    pub(crate) tray_usage_display_mode: TrayUsageDisplayMode,
    #[serde(default)]
    pub(crate) tray_usage_title_show_window_labels: bool,
    pub(crate) launch_codex_after_switch: bool,
    #[serde(default)]
    pub(crate) smart_switch_include_api: bool,
    #[serde(default)]
    pub(crate) launch_codex_as_admin: bool,
    pub(crate) codex_launch_path: Option<String>,
    #[serde(default)]
    pub(crate) proxy_url: Option<String>,
    #[serde(default)]
    pub(crate) active_account_id: Option<String>,
    pub(crate) sync_opencode_openai_auth: bool,
    pub(crate) restart_opencode_desktop_on_switch: bool,
    pub(crate) restart_editors_on_switch: bool,
    pub(crate) restart_editor_targets: Vec<EditorAppId>,
    pub(crate) auto_start_api_proxy: bool,
    #[serde(default = "default_api_proxy_port")]
    pub(crate) api_proxy_port: u16,
    #[serde(default)]
    pub(crate) api_proxy_load_balance_mode: ApiProxyLoadBalanceMode,
    #[serde(default = "default_api_proxy_service_tier")]
    pub(crate) api_proxy_default_service_tier: String,
    #[serde(default = "default_api_proxy_sequential_five_hour_limit_percent")]
    pub(crate) api_proxy_sequential_five_hour_limit_percent: f64,
    #[serde(default)]
    pub(crate) api_proxy_disabled_models: Vec<String>,
    #[serde(default)]
    pub(crate) api_proxy_sequential_account_key: Option<String>,
    pub(crate) remote_servers: Vec<RemoteServerConfig>,
    pub(crate) api_proxy_api_key: Option<String>,
    pub(crate) locale: AppLocale,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            launch_at_startup: false,
            tray_usage_display_mode: TrayUsageDisplayMode::OneWeekRemaining,
            tray_usage_title_show_window_labels: false,
            launch_codex_after_switch: true,
            smart_switch_include_api: false,
            launch_codex_as_admin: false,
            codex_launch_path: None,
            proxy_url: None,
            active_account_id: None,
            sync_opencode_openai_auth: false,
            restart_opencode_desktop_on_switch: false,
            restart_editors_on_switch: false,
            restart_editor_targets: Vec::new(),
            auto_start_api_proxy: false,
            api_proxy_port: default_api_proxy_port(),
            api_proxy_load_balance_mode: ApiProxyLoadBalanceMode::default(),
            api_proxy_default_service_tier: default_api_proxy_service_tier(),
            api_proxy_sequential_five_hour_limit_percent:
                default_api_proxy_sequential_five_hour_limit_percent(),
            api_proxy_disabled_models: Vec::new(),
            api_proxy_sequential_account_key: None,
            remote_servers: Vec::new(),
            api_proxy_api_key: None,
            locale: AppLocale::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettingsPatch {
    pub(crate) launch_at_startup: Option<bool>,
    pub(crate) tray_usage_display_mode: Option<TrayUsageDisplayMode>,
    pub(crate) tray_usage_title_show_window_labels: Option<bool>,
    pub(crate) launch_codex_after_switch: Option<bool>,
    pub(crate) smart_switch_include_api: Option<bool>,
    pub(crate) launch_codex_as_admin: Option<bool>,
    pub(crate) codex_launch_path: Option<Option<String>>,
    pub(crate) proxy_url: Option<Option<String>>,
    pub(crate) sync_opencode_openai_auth: Option<bool>,
    pub(crate) restart_opencode_desktop_on_switch: Option<bool>,
    pub(crate) restart_editors_on_switch: Option<bool>,
    pub(crate) restart_editor_targets: Option<Vec<EditorAppId>>,
    pub(crate) auto_start_api_proxy: Option<bool>,
    pub(crate) api_proxy_port: Option<u16>,
    pub(crate) api_proxy_load_balance_mode: Option<ApiProxyLoadBalanceMode>,
    pub(crate) api_proxy_default_service_tier: Option<String>,
    pub(crate) api_proxy_sequential_five_hour_limit_percent: Option<f64>,
    pub(crate) api_proxy_disabled_models: Option<Vec<String>>,
    pub(crate) remote_servers: Option<Vec<RemoteServerConfig>>,
    pub(crate) locale: Option<AppLocale>,
}

impl StoredAccount {
    pub(crate) fn principal_key(&self) -> String {
        if matches!(self.source_kind, AccountSourceKind::Relay) {
            return format!("relay:{}", self.id);
        }

        normalized_identity_key(self.principal_id.as_deref())
            .or_else(|| {
                extract_auth(&self.auth_json)
                    .ok()
                    .map(|auth| auth.principal_id)
            })
            .or_else(|| normalized_email_key(self.email.as_deref()))
            .unwrap_or_else(|| self.account_id.clone())
    }

    pub(crate) fn account_key(&self) -> String {
        if matches!(self.source_kind, AccountSourceKind::Relay) {
            return crate::profile_files::relay_account_key(&self.id);
        }

        account_group_key(&self.principal_key(), &self.account_id)
    }

    pub(crate) fn resolved_plan_type(&self) -> Option<String> {
        if matches!(self.source_kind, AccountSourceKind::Relay) {
            return self.plan_type.clone();
        }

        self.usage
            .as_ref()
            .and_then(|usage| usage.plan_type.clone())
            .or_else(|| self.plan_type.clone())
            .or_else(|| {
                extract_auth(&self.auth_json)
                    .ok()
                    .and_then(|auth| auth.plan_type)
            })
    }

    pub(crate) fn variant_key(&self) -> String {
        if matches!(self.source_kind, AccountSourceKind::Relay) {
            return self.account_key();
        }

        account_variant_key(
            &self.principal_key(),
            &self.account_id,
            self.resolved_plan_type().as_deref(),
        )
    }

    pub(crate) fn to_summary(
        &self,
        current_account_key: Option<&str>,
        current_variant_key: Option<&str>,
    ) -> AccountSummary {
        let account_key = self.account_key();
        let is_current = current_variant_key
            .map(|variant_key| variant_key == self.variant_key())
            .unwrap_or_else(|| {
                current_account_key
                    .map(|key| key == account_key)
                    .unwrap_or(false)
            });

        AccountSummary {
            id: self.id.clone(),
            label: self.label.clone(),
            source_kind: self.source_kind.clone(),
            email: self.email.clone(),
            account_key,
            account_id: self.account_id.clone(),
            plan_type: self.resolved_plan_type(),
            subscription_active_until: chatgpt_subscription_active_until(&self.auth_json)
                .filter(|active_until| *active_until > now_unix_seconds()),
            api_base_url: self.api_base_url.clone(),
            model_name: self.model_name.clone(),
            balance_text: self.balance_text.clone(),
            profile_auth_ready: self.profile_auth_ready,
            profile_config_ready: self.profile_config_ready,
            profile_integrity_error: self.profile_integrity_error.clone(),
            profile_last_validated_at: self.profile_last_validated_at,
            profile_last_validation_error: self.profile_last_validation_error.clone(),
            added_at: self.added_at,
            updated_at: self.updated_at,
            usage: self.usage.clone(),
            usage_error: self.usage_error.clone(),
            auth_refresh_blocked: self.auth_refresh_blocked,
            auth_refresh_error: self.auth_refresh_error.clone(),
            api_proxy_enabled: self.api_proxy_enabled,
            is_current,
        }
    }
}

fn normalized_email_key(email: Option<&str>) -> Option<String> {
    email
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn normalized_identity_key(value: Option<&str>) -> Option<String> {
    let trimmed = value.map(str::trim).filter(|value| !value.is_empty())?;
    if trimmed.contains('@') {
        Some(trimmed.to_ascii_lowercase())
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn dedupe_account_variants(accounts: &mut Vec<StoredAccount>) -> bool {
    let mut changed = false;
    let mut merged_accounts: Vec<StoredAccount> = Vec::with_capacity(accounts.len());
    let mut index_by_variant: HashMap<String, usize> = HashMap::new();

    for account in std::mem::take(accounts) {
        let variant_key = account.variant_key();
        if let Some(existing_index) = index_by_variant.get(&variant_key).copied() {
            let merged =
                merge_duplicate_account_variant(merged_accounts[existing_index].clone(), account);
            merged_accounts[existing_index] = merged;
            changed = true;
        } else {
            index_by_variant.insert(variant_key, merged_accounts.len());
            merged_accounts.push(account);
        }
    }

    *accounts = merged_accounts;

    changed
}

fn merge_duplicate_account_variant(left: StoredAccount, right: StoredAccount) -> StoredAccount {
    let left_score = duplicate_account_merge_score(&left);
    let right_score = duplicate_account_merge_score(&right);
    let (mut preferred, alternate) = if right_score > left_score {
        (right, left)
    } else {
        (left, right)
    };

    preferred.added_at = preferred.added_at.min(alternate.added_at);
    preferred.updated_at = preferred.updated_at.max(alternate.updated_at);

    if preferred.email.is_none() {
        preferred.email = alternate.email.clone();
    }
    if preferred.plan_type.is_none() {
        preferred.plan_type = alternate.plan_type.clone();
    }
    if preferred.usage.is_none() {
        preferred.usage = alternate.usage.clone();
    }
    if preferred.usage_error.is_none() {
        preferred.usage_error = alternate.usage_error.clone();
    }
    // 去重时不能让 alternate 的 blocked 状态“复活”健康的 preferred：
    // 只有 preferred 自己就是 blocked 且缺文案时，才继承 alternate 的错误文案。
    if preferred.auth_refresh_blocked && preferred.auth_refresh_error.is_none() {
        preferred.auth_refresh_error = alternate.auth_refresh_error.clone();
    } else if !preferred.auth_refresh_blocked {
        preferred.auth_refresh_error = None;
    }
    preferred.api_proxy_enabled = preferred.api_proxy_enabled && alternate.api_proxy_enabled;
    if preferred.auth_json.is_null() && !alternate.auth_json.is_null() {
        preferred.auth_json = alternate.auth_json.clone();
    }
    if preferred.api_base_url.is_none() {
        preferred.api_base_url = alternate.api_base_url.clone();
    }
    if preferred.api_key.is_none() {
        preferred.api_key = alternate.api_key.clone();
    }
    if preferred.model_name.is_none() {
        preferred.model_name = alternate.model_name.clone();
    }
    if preferred.balance_text.is_none() {
        preferred.balance_text = alternate.balance_text.clone();
    }
    if preferred.profile_auth_path.is_none() {
        preferred.profile_auth_path = alternate.profile_auth_path.clone();
    }
    if preferred.profile_config_path.is_none() {
        preferred.profile_config_path = alternate.profile_config_path.clone();
    }
    preferred.profile_auth_ready = preferred.profile_auth_ready || alternate.profile_auth_ready;
    preferred.profile_config_ready =
        preferred.profile_config_ready || alternate.profile_config_ready;
    if preferred.profile_integrity_error.is_none() {
        preferred.profile_integrity_error = alternate.profile_integrity_error.clone();
    }
    if preferred.profile_last_validated_at.is_none() {
        preferred.profile_last_validated_at = alternate.profile_last_validated_at;
    }
    if preferred.profile_last_validation_error.is_none() {
        preferred.profile_last_validation_error = alternate.profile_last_validation_error.clone();
    }

    preferred
}

fn duplicate_account_merge_score(account: &StoredAccount) -> (u8, u8, u8, u8, i64, i64) {
    (
        u8::from(account.usage.is_some() && account.usage_error.is_none()),
        u8::from(!account.auth_refresh_blocked),
        u8::from(account.resolved_plan_type().is_some()),
        u8::from(
            account
                .email
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some(),
        ),
        account.updated_at,
        account.added_at,
    )
}

#[cfg(test)]
mod tests {
    use super::account_is_eligible_for_automatic_use;
    use super::dedupe_account_variants;
    use super::OFFICIAL_PLAN_SLUGS;
    use super::mark_current_account_summary;
    use super::usage_error_indicates_authorization_failure;
    use super::AppSettings;
    use super::AppSettingsPatch;
    use super::StoredAccount;
    use super::TrayUsageDisplayMode;
    use super::UsageSnapshot;
    use super::UsageWindow;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use serde_json::json;

    fn usage_snapshot(plan_type: &str) -> UsageSnapshot {
        UsageSnapshot {
            fetched_at: 10,
            plan_type: Some(plan_type.to_string()),
            five_hour: Some(UsageWindow {
                used_percent: 10.0,
                window_seconds: 18_000,
                reset_at: Some(20),
            }),
            one_week: Some(UsageWindow {
                used_percent: 20.0,
                window_seconds: 604_800,
                reset_at: Some(30),
            }),
            windows: Vec::new(),
            allowed: None,
            limit_reached: None,
            rate_limit_reached_type: None,
            credits: None,
            reset_credits: None,
        }
    }

    #[test]
    fn normalize_plan_slug_keeps_official_slugs_and_unknown_values() {
        for slug in OFFICIAL_PLAN_SLUGS {
            assert_eq!(
                super::normalize_plan_slug(slug),
                *slug,
                "官方枚举必须原样保留"
            );
        }
        assert_eq!(super::normalize_plan_slug(" PROLITE "), "prolite");
        assert_eq!(super::normalize_plan_slug("Pro"), "pro");
        assert_eq!(super::normalize_plan_slug("promax"), "promax");
        assert_eq!(super::normalize_plan_slug("free_workspace"), "free_workspace");
        assert_eq!(super::normalize_plan_slug("   "), "unknown");
        // 未在官方枚举中的值不做别名猜测，保留小写原串。
        assert_eq!(super::normalize_plan_slug(" pro_5x "), "pro_5x");
        assert_eq!(super::normalize_plan_slug("Pro_500"), "pro_500");
    }

    #[test]
    fn plan_display_zh_maps_pro_tiers_and_common_plans() {
        assert_eq!(super::plan_display_zh(Some("prolite")), "Pro 100");
        assert_eq!(super::plan_display_zh(Some("pro")), "Pro 200");
        assert_eq!(super::plan_display_zh(Some("promax")), "Pro 500");
        assert_eq!(super::plan_display_zh(Some("free")), "免费");
        assert_eq!(super::plan_display_zh(Some("plus")), "Plus");
        assert_eq!(super::plan_display_zh(Some("go")), "Go");
        assert_eq!(super::plan_display_zh(Some("team")), "Business");
        assert_eq!(super::plan_display_zh(Some("business")), "Business");
        assert_eq!(super::plan_display_zh(Some("enterprise")), "Enterprise");
        assert_eq!(super::plan_display_zh(Some("edu_plus")), "Edu");
        assert_eq!(super::plan_display_zh(None), "unknown");
        assert_eq!(super::plan_display_zh(Some("pro_5x")), "pro_5x");
    }

    #[test]
    fn variant_key_is_stable_across_plan_case_and_whitespace() {
        let with_padding = crate::auth::account_variant_key("principal", "account", Some(" PRO "));
        let canonical = crate::auth::account_variant_key("principal", "account", Some("pro"));
        let missing = crate::auth::account_variant_key("principal", "account", None);

        assert_eq!(with_padding, canonical);
        assert_eq!(missing, "principal|account|unknown");
    }

    #[test]
    fn new_settings_default_to_one_week_remaining_without_overwriting_existing_modes() {
        assert_eq!(
            AppSettings::default().tray_usage_display_mode,
            TrayUsageDisplayMode::OneWeekRemaining
        );
        assert!(!AppSettings::default().tray_usage_title_show_window_labels);

        let missing_mode: AppSettings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(
            missing_mode.tray_usage_display_mode,
            TrayUsageDisplayMode::OneWeekRemaining
        );
        assert!(!missing_mode.tray_usage_title_show_window_labels);

        assert_eq!(
            serde_json::to_value(TrayUsageDisplayMode::OneWeekRemaining).unwrap(),
            json!("oneWeekRemaining")
        );

        let existing_mode: AppSettings =
            serde_json::from_value(json!({ "trayUsageDisplayMode": "remaining" })).unwrap();
        assert_eq!(
            existing_mode.tray_usage_display_mode,
            TrayUsageDisplayMode::Remaining
        );
        assert!(!existing_mode.tray_usage_title_show_window_labels);

        let patch: AppSettingsPatch = serde_json::from_value(json!({
            "trayUsageDisplayMode": "oneWeekRemaining",
            "trayUsageTitleShowWindowLabels": true
        }))
        .unwrap();
        assert_eq!(
            patch.tray_usage_display_mode,
            Some(TrayUsageDisplayMode::OneWeekRemaining)
        );
        assert_eq!(patch.tray_usage_title_show_window_labels, Some(true));
    }

    fn jwt_with_plan(plan_type: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(
            r#"{{"email":"shared@example.com","https://api.openai.com/auth":{{"chatgpt_account_id":"account-1","chatgpt_plan_type":"{plan_type}"}}}}"#
        ));
        format!("header.{payload}.signature")
    }

    fn stored_account(
        id: &str,
        label: &str,
        account_id: &str,
        plan_type: Option<&str>,
        usage_plan_type: Option<&str>,
        updated_at: i64,
    ) -> StoredAccount {
        StoredAccount {
            id: id.to_string(),
            label: label.to_string(),
            source_kind: Default::default(),
            principal_id: Some("shared@example.com".to_string()),
            email: Some("shared@example.com".to_string()),
            account_id: account_id.to_string(),
            plan_type: plan_type.map(ToString::to_string),
            auth_json: json!({ "id": id }),
            api_base_url: None,
            api_key: None,
            model_name: None,
            balance_text: None,
            profile_auth_path: None,
            profile_config_path: None,
            profile_auth_ready: false,
            profile_config_ready: false,
            profile_integrity_error: None,
            profile_last_validated_at: None,
            profile_last_validation_error: None,
            added_at: updated_at - 1,
            updated_at,
            usage: usage_plan_type.map(usage_snapshot),
            usage_error: None,
            auth_refresh_blocked: false,
            auth_refresh_error: None,
            api_proxy_enabled: true,
        }
    }

    #[test]
    fn automatic_account_selection_excludes_known_unusable_accounts() {
        let free = stored_account("free", "free", "account-1", Some("pro"), Some("free"), 100);
        let mut blocked =
            stored_account("blocked", "blocked", "account-2", Some("team"), None, 100);
        blocked.auth_refresh_blocked = true;
        let mut forbidden = stored_account(
            "forbidden",
            "forbidden",
            "account-3",
            Some("team"),
            None,
            100,
        );
        forbidden.usage_error = Some("403 Forbidden".to_string());

        assert!(!account_is_eligible_for_automatic_use(&free, 15));
        assert!(!account_is_eligible_for_automatic_use(&blocked, 15));
        assert!(!account_is_eligible_for_automatic_use(&forbidden, 15));
    }

    #[test]
    fn removed_team_membership_is_a_permanent_authorization_failure() {
        let messages = [
            "该账号已被踢出 team 组织，请重新授权后再刷新。",
            "账号已被移出工作区",
            "This account is not a member of this workspace",
            "User was removed from the organization",
        ];

        for message in messages {
            assert!(
                usage_error_indicates_authorization_failure(Some(message)),
                "membership failure should be rejected: {message}"
            );
        }

        assert!(!usage_error_indicates_authorization_failure(Some(
            "503 Service Unavailable"
        )));
    }

    #[test]
    fn automatic_account_selection_respects_usage_reset_time() {
        let mut account = stored_account(
            "usage",
            "usage",
            "account-1",
            Some("team"),
            Some("team"),
            100,
        );
        account
            .usage
            .as_mut()
            .and_then(|usage| usage.one_week.as_mut())
            .expect("active usage")
            .used_percent = 100.0;

        assert!(!account_is_eligible_for_automatic_use(&account, 15));
        assert!(account_is_eligible_for_automatic_use(&account, 31));
    }


    fn snapshot_with_windows(
        five_hour_percent: Option<f64>,
        one_week_percent: Option<f64>,
        extra_windows: Vec<UsageWindow>,
    ) -> UsageSnapshot {
        UsageSnapshot {
            fetched_at: 100,
            plan_type: Some("pro".to_string()),
            five_hour: five_hour_percent.map(|used_percent| UsageWindow {
                used_percent,
                window_seconds: 18_000,
                reset_at: Some(200),
            }),
            one_week: one_week_percent.map(|used_percent| UsageWindow {
                used_percent,
                window_seconds: 604_800,
                reset_at: Some(200),
            }),
            windows: extra_windows,
            allowed: None,
            limit_reached: None,
            rate_limit_reached_type: None,
            credits: None,
            reset_credits: None,
        }
    }

    fn credits_snapshot(has_credits: bool, unlimited: bool, balance: Option<&str>) -> super::CreditSnapshot {
        super::CreditSnapshot {
            has_credits,
            unlimited,
            balance: balance.map(str::to_string),
        }
    }


    #[test]
    fn old_usage_snapshot_without_new_fields_deserializes() {
        let usage: UsageSnapshot = serde_json::from_value(json!({
            "fetchedAt": 10,
            "planType": "pro",
            "fiveHour": null,
            "oneWeek": {
                "usedPercent": 20.0,
                "windowSeconds": 604800,
                "resetAt": 30
            },
            "credits": null,
            "resetCredits": null
        }))
        .expect("旧 accounts.json 里的 usage 必须能反序列化");

        assert!(usage.windows.is_empty());
        assert_eq!(usage.allowed, None);
        assert_eq!(usage.limit_reached, None);
        assert_eq!(usage.rate_limit_reached_type, None);
        assert_eq!(
            usage.one_week.expect("weekly window").used_percent,
            20.0
        );
    }


    #[test]
    fn primary_window_prefers_weekly_then_five_hour_then_longest_extra() {
        let both_standard = snapshot_with_windows(Some(30.0), Some(40.0), vec![]);
        assert_eq!(
            super::usage_primary_window(&both_standard)
                .expect("primary window")
                .window_seconds,
            604_800,
            "优先周窗口"
        );

        let five_only = snapshot_with_windows(Some(30.0), None, vec![]);
        assert_eq!(
            super::usage_primary_window(&five_only)
                .expect("primary window")
                .window_seconds,
            18_000,
            "无周窗口时回退 5h"
        );

        let extra_only = snapshot_with_windows(
            None,
            None,
            vec![
                UsageWindow {
                    used_percent: 10.0,
                    window_seconds: 86_400,
                    reset_at: Some(500),
                },
                UsageWindow {
                    used_percent: 20.0,
                    window_seconds: 2_592_000,
                    reset_at: Some(600),
                },
            ],
        );
        assert_eq!(
            super::usage_primary_window(&extra_only)
                .expect("primary window")
                .window_seconds,
            2_592_000,
            "只有非标准窗口时取最长者（30 天）"
        );
        assert!(super::usage_primary_window(&snapshot_with_windows(None, None, vec![])).is_none());
    }

    #[test]
    fn exhaustion_truth_table_handles_allowed_limit_reached_and_credits() {
        // 1) allowed=false：服务端明确拒绝，无条件判耗尽（credits 也无法绕过）。
        let mut allowed_false = snapshot_with_windows(None, Some(100.0), Vec::new());
        allowed_false.allowed = Some(false);
        allowed_false.credits = Some(credits_snapshot(true, false, Some("5.00")));
        assert!(
            super::usage_has_active_exhausted_window(Some(&allowed_false), 150),
            "allowed=false 必须硬阻断，即使 credits 可用"
        );

        let mut allowed_false_without_credits = snapshot_with_windows(None, Some(10.0), Vec::new());
        allowed_false_without_credits.allowed = Some(false);
        assert!(super::usage_has_active_exhausted_window(
            Some(&allowed_false_without_credits),
            150
        ));

        // 2) 任一主窗口 100% 且未重置、无 credits → 耗尽。
        let weekly_full = snapshot_with_windows(None, Some(100.0), Vec::new());
        assert!(super::usage_has_active_exhausted_window(Some(&weekly_full), 150));

        // 3) 5h 满、周未满 → 耗尽（两个窗口都要有余量）。
        let five_full = snapshot_with_windows(Some(100.0), Some(40.0), Vec::new());
        assert!(super::usage_has_active_exhausted_window(Some(&five_full), 150));

        // 4) 窗口已过重置时间 → 不判耗尽。
        let mut reset_passed = snapshot_with_windows(None, Some(100.0), Vec::new());
        reset_passed.one_week.as_mut().expect("weekly").reset_at = Some(120);
        assert!(!super::usage_has_active_exhausted_window(Some(&reset_passed), 150));

        // 5) has_credits 但余额为 0 → 不可用 credits。
        let mut zero_balance = snapshot_with_windows(None, Some(100.0), Vec::new());
        zero_balance.credits = Some(credits_snapshot(true, false, Some("0")));
        assert!(super::usage_has_active_exhausted_window(Some(&zero_balance), 150));

        // 6) has_credits 但余额不可解析 → 不可用 credits。
        let mut unparsable_balance = snapshot_with_windows(None, Some(100.0), Vec::new());
        unparsable_balance.credits = Some(credits_snapshot(true, false, Some("n/a")));
        assert!(super::usage_has_active_exhausted_window(Some(&unparsable_balance), 150));

        // 7) unlimited=true 视为 credits 可用 → 窗口满也不判耗尽。
        let mut unlimited = snapshot_with_windows(None, Some(100.0), Vec::new());
        unlimited.credits = Some(credits_snapshot(true, true, Some("5")));
        assert!(!super::usage_has_active_exhausted_window(Some(&unlimited), 150));

        let mut unlimited_without_balance =
            snapshot_with_windows(None, Some(100.0), Vec::new());
        unlimited_without_balance.credits = Some(credits_snapshot(false, true, None));
        assert!(!super::usage_has_active_exhausted_window(
            Some(&unlimited_without_balance),
            150
        ));

        // 8) 旧快照（allowed/limit_reached 均为 None）只按窗口判断：无窗口即不判耗尽。
        assert!(!super::usage_has_active_exhausted_window(
            Some(&snapshot_with_windows(None, None, Vec::new())),
            150
        ));

        // 9) limit_reached=true 比百分比更权威。
        let mut limit_reached = snapshot_with_windows(None, Some(20.0), Vec::new());
        limit_reached.limit_reached = Some(true);
        assert!(super::usage_has_active_exhausted_window(Some(&limit_reached), 150));

        // 10) windows[] 里的 30 天窗口同样参与判定。
        let month_full = snapshot_with_windows(
            None,
            None,
            vec![UsageWindow {
                used_percent: 100.0,
                window_seconds: 2_592_000,
                reset_at: Some(2_000_000),
            }],
        );
        assert!(super::usage_has_active_exhausted_window(Some(&month_full), 150));
    }

    #[test]
    fn exhaustion_reset_at_uses_the_latest_blocking_window() {
        let mut usage = snapshot_with_windows(Some(100.0), Some(100.0), Vec::new());
        usage.five_hour.as_mut().expect("five hour").reset_at = Some(300);
        usage.one_week.as_mut().expect("weekly").reset_at = Some(400);

        assert_eq!(super::usage_exhaustion_reset_at(Some(&usage), 150), Some(400));

        usage.credits = Some(credits_snapshot(true, false, Some("5")));
        assert_eq!(
            super::usage_exhaustion_reset_at(Some(&usage), 150),
            None,
            "credits 可用时不应产生配额冷却"
        );
    }

    #[test]
    fn most_constrained_used_percent_uses_all_main_windows() {
        let usage = snapshot_with_windows(Some(90.0), Some(10.0), Vec::new());
        assert_eq!(
            super::usage_most_constrained_used_percent(Some(&usage), 150),
            Some(90.0)
        );

        let mut reset_passed = snapshot_with_windows(Some(100.0), Some(10.0), Vec::new());
        reset_passed.five_hour.as_mut().expect("five hour").reset_at = Some(120);
        assert_eq!(
            super::usage_most_constrained_used_percent(Some(&reset_passed), 150),
            Some(10.0),
            "已过重置时间的旧窗口不参与排序"
        );
    }

    #[test]
    fn dedupe_account_variants_keeps_newest_variant_record() {
        let mut accounts = vec![
            stored_account(
                "old",
                "legacy",
                "account-1",
                Some("team"),
                Some("team"),
                100,
            ),
            stored_account("new", "fresh", "account-1", Some("team"), Some("team"), 200),
        ];

        let changed = dedupe_account_variants(&mut accounts);

        assert!(changed);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "new");
        assert_eq!(accounts[0].label, "fresh");
        assert_eq!(accounts[0].added_at, 99);
        assert_eq!(accounts[0].updated_at, 200);
    }

    #[test]
    fn dedupe_does_not_revive_blocked_state_from_alternate() {
        let healthy = stored_account(
            "healthy",
            "healthy",
            "account-1",
            Some("pro"),
            Some("pro"),
            200,
        );
        let mut blocked = stored_account(
            "blocked",
            "blocked",
            "account-1",
            Some("pro"),
            Some("pro"),
            100,
        );
        blocked.auth_refresh_blocked = true;
        blocked.auth_refresh_error = Some("refresh_token_reused".to_string());

        let mut accounts = vec![healthy, blocked];
        assert!(dedupe_account_variants(&mut accounts));

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "healthy");
        assert!(
            !accounts[0].auth_refresh_blocked,
            "健康 preferred 不能被 alternate 的 blocked 状态复活"
        );
        assert_eq!(
            accounts[0].auth_refresh_error, None,
            "健康 preferred 不应继承 alternate 的错误文案"
        );
    }

    #[test]
    fn dedupe_inherits_blocked_error_when_preferred_is_blocked_without_error() {
        let mut preferred = stored_account(
            "blocked-new",
            "blocked-new",
            "account-1",
            Some("pro"),
            Some("pro"),
            200,
        );
        preferred.auth_refresh_blocked = true;
        let mut alternate = stored_account(
            "blocked-old",
            "blocked-old",
            "account-1",
            Some("pro"),
            Some("pro"),
            100,
        );
        alternate.auth_refresh_blocked = true;
        alternate.auth_refresh_error = Some("refresh token expired".to_string());

        let mut accounts = vec![preferred, alternate];
        assert!(dedupe_account_variants(&mut accounts));

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "blocked-new");
        assert!(accounts[0].auth_refresh_blocked);
        assert_eq!(
            accounts[0].auth_refresh_error.as_deref(),
            Some("refresh token expired"),
            "preferred 已 blocked 且无文案时应继承 alternate 的错误文案"
        );
    }

    #[test]
    fn dedupe_account_variants_merges_when_usage_reveals_same_variant() {
        let mut accounts = vec![
            stored_account("unknown", "legacy", "account-1", None, Some("team"), 100),
            stored_account(
                "team",
                "current",
                "account-1",
                Some("team"),
                Some("team"),
                200,
            ),
        ];

        let changed = dedupe_account_variants(&mut accounts);

        assert!(changed);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "team");
    }

    #[test]
    fn resolved_plan_type_prefers_usage_plan_type_over_stored_plan_type() {
        let account = StoredAccount {
            id: "mixed".to_string(),
            label: "mixed".to_string(),
            source_kind: Default::default(),
            principal_id: Some("shared@example.com".to_string()),
            email: Some("shared@example.com".to_string()),
            account_id: "account-1".to_string(),
            plan_type: Some("team".to_string()),
            auth_json: json!({ "kind": "mixed" }),
            api_base_url: None,
            api_key: None,
            model_name: None,
            balance_text: None,
            profile_auth_path: None,
            profile_config_path: None,
            profile_auth_ready: false,
            profile_config_ready: false,
            profile_integrity_error: None,
            profile_last_validated_at: None,
            profile_last_validation_error: None,
            added_at: 1,
            updated_at: 1,
            usage: Some(usage_snapshot("plus")),
            usage_error: None,
            auth_refresh_blocked: false,
            auth_refresh_error: None,
            api_proxy_enabled: true,
        };

        assert_eq!(account.resolved_plan_type().as_deref(), Some("plus"));
        assert_eq!(
            account.to_summary(None, None).plan_type.as_deref(),
            Some("plus")
        );
        assert_eq!(account.variant_key(), "shared@example.com|account-1|plus");
    }

    #[test]
    fn marks_unique_account_group_current_when_usage_plan_differs_from_auth_plan() {
        let account = stored_account(
            "upgraded",
            "upgraded",
            "account-1",
            Some("plus"),
            Some("pro"),
            10,
        );
        let current_account_key = account.account_key();
        let current_variant_key = format!("{current_account_key}|plus");
        let mut summaries =
            vec![account.to_summary(Some(&current_account_key), Some(&current_variant_key))];

        assert!(!summaries[0].is_current);

        mark_current_account_summary(&mut summaries, Some(&current_account_key), None);

        assert!(summaries[0].is_current);
    }

    #[test]
    fn uses_active_account_to_disambiguate_multiple_plan_variants_in_one_group() {
        let plus = stored_account("plus", "plus", "account-1", Some("plus"), Some("plus"), 10);
        let pro = stored_account("pro", "pro", "account-1", Some("pro"), Some("pro"), 20);
        let current_account_key = plus.account_key();
        let current_variant_key = format!("{current_account_key}|team");
        let mut summaries = vec![
            plus.to_summary(Some(&current_account_key), Some(&current_variant_key)),
            pro.to_summary(Some(&current_account_key), Some(&current_variant_key)),
        ];

        mark_current_account_summary(&mut summaries, Some(&current_account_key), Some("pro"));

        assert!(!summaries[0].is_current);
        assert!(summaries[1].is_current);
    }

    #[test]
    fn avoids_selecting_an_unrelated_active_account_when_group_is_ambiguous() {
        let plus = stored_account("plus", "plus", "account-1", Some("plus"), Some("plus"), 10);
        let pro = stored_account("pro", "pro", "account-1", Some("pro"), Some("pro"), 20);
        let other = stored_account(
            "other",
            "other",
            "account-2",
            Some("plus"),
            Some("plus"),
            30,
        );
        let current_account_key = plus.account_key();
        let current_variant_key = format!("{current_account_key}|team");
        let mut summaries = vec![
            plus.to_summary(Some(&current_account_key), Some(&current_variant_key)),
            pro.to_summary(Some(&current_account_key), Some(&current_variant_key)),
            other.to_summary(Some(&current_account_key), Some(&current_variant_key)),
        ];

        mark_current_account_summary(&mut summaries, Some(&current_account_key), Some("other"));

        assert!(summaries.iter().all(|account| !account.is_current));
    }

    #[test]
    fn resolved_plan_type_prefers_usage_plan_type_over_auth_claim() {
        let account = StoredAccount {
            id: "auth".to_string(),
            label: "auth".to_string(),
            source_kind: Default::default(),
            principal_id: Some("shared@example.com".to_string()),
            email: Some("shared@example.com".to_string()),
            account_id: "account-1".to_string(),
            plan_type: None,
            auth_json: json!({
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": "token",
                    "id_token": jwt_with_plan("team")
                }
            }),
            api_base_url: None,
            api_key: None,
            model_name: None,
            balance_text: None,
            profile_auth_path: None,
            profile_config_path: None,
            profile_auth_ready: false,
            profile_config_ready: false,
            profile_integrity_error: None,
            profile_last_validated_at: None,
            profile_last_validation_error: None,
            added_at: 1,
            updated_at: 1,
            usage: Some(usage_snapshot("plus")),
            usage_error: None,
            auth_refresh_blocked: false,
            auth_refresh_error: None,
            api_proxy_enabled: true,
        };

        assert_eq!(account.resolved_plan_type().as_deref(), Some("plus"));
    }

    #[test]
    fn resolved_plan_type_falls_back_to_auth_claim_when_usage_plan_missing() {
        let account = StoredAccount {
            id: "auth-fallback".to_string(),
            label: "auth-fallback".to_string(),
            source_kind: Default::default(),
            principal_id: Some("shared@example.com".to_string()),
            email: Some("shared@example.com".to_string()),
            account_id: "account-1".to_string(),
            plan_type: None,
            auth_json: json!({
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": "token",
                    "id_token": jwt_with_plan("team")
                }
            }),
            api_base_url: None,
            api_key: None,
            model_name: None,
            balance_text: None,
            profile_auth_path: None,
            profile_config_path: None,
            profile_auth_ready: false,
            profile_config_ready: false,
            profile_integrity_error: None,
            profile_last_validated_at: None,
            profile_last_validation_error: None,
            added_at: 1,
            updated_at: 1,
            usage: Some(UsageSnapshot {
                fetched_at: 1,
                plan_type: None,
                five_hour: None,
                one_week: None,
                windows: Vec::new(),
                allowed: None,
                limit_reached: None,
                rate_limit_reached_type: None,
                credits: None,
                reset_credits: None,
            }),
            usage_error: None,
            auth_refresh_blocked: false,
            auth_refresh_error: None,
            api_proxy_enabled: true,
        };

        assert_eq!(account.resolved_plan_type().as_deref(), Some("team"));
    }

    #[test]
    fn persisted_principal_id_keeps_same_workspace_different_users_separate() {
        let mut accounts = vec![
            StoredAccount {
                id: "first".to_string(),
                label: "first".to_string(),
                source_kind: Default::default(),
                principal_id: Some("first@example.com".to_string()),
                email: None,
                account_id: "workspace-1".to_string(),
                plan_type: Some("team".to_string()),
                auth_json: json!({ "kind": "legacy" }),
                api_base_url: None,
                api_key: None,
                model_name: None,
                balance_text: None,
                profile_auth_path: None,
                profile_config_path: None,
                profile_auth_ready: false,
                profile_config_ready: false,
                profile_integrity_error: None,
                profile_last_validated_at: None,
                profile_last_validation_error: None,
                added_at: 1,
                updated_at: 1,
                usage: None,
                usage_error: None,
                auth_refresh_blocked: false,
                auth_refresh_error: None,
                api_proxy_enabled: true,
            },
            StoredAccount {
                id: "second".to_string(),
                label: "second".to_string(),
                source_kind: Default::default(),
                principal_id: Some("second@example.com".to_string()),
                email: None,
                account_id: "workspace-1".to_string(),
                plan_type: Some("team".to_string()),
                auth_json: json!({ "kind": "legacy" }),
                api_base_url: None,
                api_key: None,
                model_name: None,
                balance_text: None,
                profile_auth_path: None,
                profile_config_path: None,
                profile_auth_ready: false,
                profile_config_ready: false,
                profile_integrity_error: None,
                profile_last_validated_at: None,
                profile_last_validation_error: None,
                added_at: 2,
                updated_at: 2,
                usage: None,
                usage_error: None,
                auth_refresh_blocked: false,
                auth_refresh_error: None,
                api_proxy_enabled: true,
            },
        ];

        let changed = dedupe_account_variants(&mut accounts);

        assert!(!changed);
        assert_eq!(accounts.len(), 2);
        assert_ne!(accounts[0].account_key(), accounts[1].account_key());
    }

    #[test]
    fn app_settings_defaults_proxy_url_to_none() {
        let settings = super::AppSettings::default();

        assert_eq!(settings.proxy_url, None);
    }

    #[test]
    fn app_settings_deserializes_proxy_url_from_camel_case() {
        let settings: super::AppSettings = serde_json::from_value(json!({
            "proxyUrl": "http://127.0.0.1:7890"
        }))
        .expect("deserialize settings");

        assert_eq!(settings.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
    }
}
