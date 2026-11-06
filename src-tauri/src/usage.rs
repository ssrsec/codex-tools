use serde::Deserialize;
use serde::Deserializer;
use serde_json::Value;
use std::error::Error as StdError;

use crate::app_paths;
use crate::models::CreditSnapshot;
use crate::models::ResetCreditsSnapshot;
use crate::models::UsageSnapshot;
use crate::models::UsageWindow;
use crate::utils::now_unix_seconds;
use crate::utils::truncate_for_error;

const DEFAULT_CHATGPT_BASE_URL: &str = "https://chatgpt.com";
const CODEX_USAGE_PATH: &str = "/api/codex/usage";
const WHAM_USAGE_PATH: &str = "/wham/usage";
const BACKEND_API_PREFIX: &str = "/backend-api";

#[derive(Debug, Deserialize)]
struct UsageApiResponse {
    plan_type: Option<String>,
    rate_limit: Option<RateLimitDetails>,
    /// 按功能/模型划分的附加额度。本期只做“容忍解析”（不参与主额度判定）。
    #[serde(default)]
    #[allow(dead_code)]
    additional_rate_limits: Option<Vec<AdditionalRateLimitDetails>>,
    credits: Option<CreditDetails>,
    /// 形如 { "type": "workspace_member_credits_depleted" }，也可能直接是字符串。
    #[serde(default)]
    rate_limit_reached_type: Option<Value>,
    /// 内联的可用重置券数量（无需再请求 /wham/rate-limit-reset-credits）。
    #[serde(default)]
    rate_limit_reset_credits: Option<ResetCreditsSummary>,
}

#[derive(Debug, Deserialize)]
struct RateLimitDetails {
    #[serde(default)]
    allowed: Option<bool>,
    #[serde(default)]
    limit_reached: Option<bool>,
    primary_window: Option<UsageWindowRaw>,
    secondary_window: Option<UsageWindowRaw>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct AdditionalRateLimitDetails {
    #[serde(default)]
    limit_name: Option<String>,
    #[serde(default)]
    metered_feature: Option<String>,
    #[serde(default)]
    normal_model_slug: Option<String>,
    rate_limit: Option<RateLimitDetails>,
}

#[derive(Debug, Deserialize)]
struct UsageWindowRaw {
    #[serde(deserialize_with = "deserialize_number_or_string_f64")]
    used_percent: f64,
    #[serde(deserialize_with = "deserialize_number_or_string_i64")]
    limit_window_seconds: i64,
    #[serde(default, deserialize_with = "deserialize_opt_i64_number_or_string")]
    reset_at: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_i64_number_or_string")]
    reset_after_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CreditDetails {
    #[serde(default)]
    has_credits: bool,
    #[serde(default)]
    unlimited: bool,
    #[serde(default, deserialize_with = "deserialize_opt_string_or_number")]
    balance: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResetCreditsSummary {
    #[serde(
        default,
        alias = "availableCount",
        deserialize_with = "deserialize_opt_i64_number_or_string"
    )]
    available_count: Option<i64>,
}

pub(crate) async fn fetch_usage_snapshot(
    access_token: &str,
    account_id: &str,
) -> Result<UsageSnapshot, String> {
    let usage_urls = resolve_usage_urls();

    let client = reqwest::Client::builder()
        .user_agent("codex-tools/0.1")
        .timeout(std::time::Duration::from_secs(18))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut errors: Vec<String> = Vec::new();
    for usage_url in usage_urls {
        let response = match client
            .get(&usage_url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("ChatGPT-Account-Id", account_id)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                errors.push(format!("{usage_url} -> {}", format_reqwest_error(&err)));
                continue;
            }
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            errors.push(format!(
                "{usage_url} -> {status}: {}",
                truncate_for_error(&body, 140)
            ));
            continue;
        }

        let payload: UsageApiResponse = match response.json().await {
            Ok(payload) => payload,
            Err(err) => {
                errors.push(format!("{usage_url} -> 解析返回失败: {err}"));
                continue;
            }
        };
        // 重置券数量已内联在 /wham/usage 响应里，不再额外请求。
        return Ok(map_usage_payload(payload));
    }

    if errors.is_empty() {
        return Err("请求用量接口失败: 未命中任何候选地址".to_string());
    }
    let preview = errors
        .iter()
        .take(2)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" | ");
    if errors.len() > 2 {
        Err(format!(
            "请求用量接口失败: {preview} | 另有 {} 个候选地址失败",
            errors.len() - 2
        ))
    } else {
        Err(format!("请求用量接口失败: {preview}"))
    }
}

fn resolve_usage_urls() -> Vec<String> {
    let normalized = resolve_chatgpt_base_origin();
    let mut candidates = Vec::new();

    if let Some(origin) = normalized.strip_suffix(BACKEND_API_PREFIX) {
        // 优先 backend-api/wham/usage（兼容性最好）
        candidates.push(format!("{normalized}{WHAM_USAGE_PATH}"));
        candidates.push(format!("{origin}{BACKEND_API_PREFIX}{WHAM_USAGE_PATH}"));
        candidates.push(format!("{origin}{CODEX_USAGE_PATH}"));
    } else {
        candidates.push(format!("{normalized}{BACKEND_API_PREFIX}{WHAM_USAGE_PATH}"));
        candidates.push(format!("{normalized}{WHAM_USAGE_PATH}"));
        candidates.push(format!("{normalized}{CODEX_USAGE_PATH}"));
    }

    candidates.push("https://chatgpt.com/backend-api/wham/usage".to_string());
    candidates.push(format!("https://chatgpt.com{CODEX_USAGE_PATH}"));

    let mut deduped = Vec::new();
    for url in candidates {
        if !deduped.iter().any(|existing| existing == &url) {
            deduped.push(url);
        }
    }
    deduped
}

pub(crate) fn resolve_chatgpt_base_origin() -> String {
    let base_url =
        read_chatgpt_base_url_from_config().unwrap_or_else(|| DEFAULT_CHATGPT_BASE_URL.to_string());
    base_url.trim_end_matches('/').to_string()
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(next) = source {
        let text = next.to_string();
        if !parts.iter().any(|item| item == &text) {
            parts.push(text);
        }
        source = next.source();
    }
    parts.join(" -> ")
}

fn read_chatgpt_base_url_from_config() -> Option<String> {
    let config_path = app_paths::codex_config_path().ok()?;
    let contents = std::fs::read_to_string(config_path).ok()?;

    for line in contents.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("chatgpt_base_url") {
            continue;
        }

        let (_, value) = trimmed.split_once('=')?;
        let cleaned = value.trim().trim_matches('"').trim_matches('\'');
        if !cleaned.is_empty() {
            return Some(cleaned.to_string());
        }
    }

    None
}

const FIVE_HOUR_SECONDS: i64 = 18_000;
const ONE_WEEK_SECONDS: i64 = 604_800;

fn map_usage_payload(payload: UsageApiResponse) -> UsageSnapshot {
    map_usage_payload_at(payload, now_unix_seconds())
}

fn map_usage_payload_at(payload: UsageApiResponse, fetched_at: i64) -> UsageSnapshot {
    let rate_limit = payload.rate_limit;
    let allowed = rate_limit.as_ref().and_then(|details| details.allowed);
    let limit_reached = rate_limit.as_ref().and_then(|details| details.limit_reached);
    let additional_without_main = rate_limit.is_none()
        && payload
            .additional_rate_limits
            .as_deref()
            .is_some_and(|limits| !limits.is_empty());
    let (five_hour, one_week, windows) = classify_usage_windows(rate_limit, fetched_at);
    if additional_without_main {
        // 主额度缺失时 additional_rate_limits 只是按功能划分的附加额度，不能当作主额度判定，
        // 否则会把“没有主额度信息”误当成“额度充足”。这里只记录，便于线上定位异常响应。
        log::debug!("用量响应缺少主额度窗口，additional_rate_limits 未参与主额度判定");
    }

    UsageSnapshot {
        fetched_at,
        plan_type: payload.plan_type,
        five_hour,
        one_week,
        windows,
        allowed,
        limit_reached,
        rate_limit_reached_type: map_rate_limit_reached_type(payload.rate_limit_reached_type),
        credits: payload.credits.map(|credit| CreditSnapshot {
            has_credits: credit.has_credits,
            unlimited: credit.unlimited,
            balance: credit.balance,
        }),
        reset_credits: payload
            .rate_limit_reset_credits
            .map(|summary| ResetCreditsSnapshot {
                available_count: summary.available_count,
                credits: Vec::new(),
            }),
    }
}

/// 按秒分类主额度窗口：18000→5 小时，604800→1 周，其余只进 windows[]。
///
/// 注意：30 天窗口**不得**当作周窗口，避免把月额度按周展示/按周判定耗尽。
fn classify_usage_windows(
    rate_limit: Option<RateLimitDetails>,
    fetched_at: i64,
) -> (Option<UsageWindow>, Option<UsageWindow>, Vec<UsageWindow>) {
    let mut five_hour = None;
    let mut one_week = None;
    let mut windows = Vec::new();

    let Some(rate_limit) = rate_limit else {
        return (None, None, windows);
    };

    for raw in [rate_limit.primary_window, rate_limit.secondary_window]
        .into_iter()
        .flatten()
    {
        let window = to_usage_window(raw, fetched_at);
        match window.window_seconds {
            FIVE_HOUR_SECONDS => keep_most_constrained(&mut five_hour, window),
            ONE_WEEK_SECONDS => keep_most_constrained(&mut one_week, window),
            _ => windows.push(window),
        }
    }
    windows.sort_by_key(|window| window.window_seconds);

    (five_hour, one_week, windows)
}

fn keep_most_constrained(slot: &mut Option<UsageWindow>, window: UsageWindow) {
    let should_replace = slot
        .as_ref()
        .map(|current| window.used_percent > current.used_percent)
        .unwrap_or(true);
    if should_replace {
        *slot = Some(window);
    }
}

fn to_usage_window(raw: UsageWindowRaw, fetched_at: i64) -> UsageWindow {
    let reset_at = raw
        .reset_at
        .map(normalize_epoch_seconds)
        .or_else(|| {
            raw.reset_after_seconds
                .map(|seconds| fetched_at.saturating_add(seconds))
        })
        .or_else(|| Some(fetched_at.saturating_add(raw.limit_window_seconds.max(0))));

    UsageWindow {
        used_percent: raw.used_percent,
        window_seconds: raw.limit_window_seconds,
        reset_at,
    }
}

fn map_rate_limit_reached_type(value: Option<Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text),
        Value::Object(object) => object
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn normalize_epoch_seconds(value: i64) -> i64 {
    if value.abs() > 10_000_000_000 {
        value / 1000
    } else {
        value
    }
}

fn value_to_f64(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return number.is_finite().then_some(number);
    }
    let text = value.as_str()?.trim();
    text.parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite())
}

fn value_to_i64(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    if let Some(number) = value.as_f64() {
        return number.is_finite().then(|| number.round() as i64);
    }
    let text = value.as_str()?.trim();
    if let Ok(parsed) = text.parse::<i64>() {
        return Some(parsed);
    }
    text.parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite())
        .map(|parsed| parsed.round() as i64)
}

fn deserialize_number_or_string_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    value_to_f64(&value).ok_or_else(|| serde::de::Error::custom("用量百分比不是有效数字"))
}

fn deserialize_number_or_string_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    value_to_i64(&value).ok_or_else(|| serde::de::Error::custom("额度窗口秒数不是有效数字"))
}

fn deserialize_opt_i64_number_or_string<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value_to_i64(&value)
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("时间字段不是有效数字")),
    }
}

fn deserialize_opt_string_or_number<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(Value::Number(number)) => Ok(Some(number.to_string())),
        Some(_) => Err(serde::de::Error::custom("金额字段类型不支持")),
    }
}

#[cfg(test)]
mod tests {
    use super::map_usage_payload_at;
    use super::UsageApiResponse;
    use crate::models::UsageSnapshot;
    use serde_json::json;

    fn snapshot_from_payload(payload: serde_json::Value, now: i64) -> UsageSnapshot {
        let parsed: UsageApiResponse =
            serde_json::from_value(payload).expect("usage payload should deserialize");
        map_usage_payload_at(parsed, now)
    }

    #[test]
    fn usage_payload_keeps_primary_and_secondary_windows_with_metadata() {
        let now = 1_700_000_000;
        let snapshot = snapshot_from_payload(
            json!({
                "plan_type": "pro",
                "rate_limit": {
                    "allowed": true,
                    "limit_reached": false,
                    "primary_window": {
                        "used_percent": "42",
                        "limit_window_seconds": "18000",
                        "reset_at": 1_800_000_000
                    },
                    "secondary_window": {
                        "used_percent": 7.5,
                        "limit_window_seconds": 604_800,
                        "reset_at": "1800600000"
                    }
                },
                "credits": {
                    "has_credits": true,
                    "unlimited": false,
                    "balance": "9.99"
                },
                "rate_limit_reached_type": {
                    "type": "workspace_member_credits_depleted"
                },
                "rate_limit_reset_credits": { "available_count": "2" }
            }),
            now,
        );

        assert_eq!(snapshot.fetched_at, now);
        assert_eq!(snapshot.plan_type.as_deref(), Some("pro"));
        let five_hour = snapshot.five_hour.expect("5h window");
        assert_eq!(five_hour.window_seconds, 18_000);
        assert_eq!(five_hour.used_percent, 42.0);
        assert_eq!(five_hour.reset_at, Some(1_800_000_000));
        let one_week = snapshot.one_week.expect("weekly window");
        assert_eq!(one_week.window_seconds, 604_800);
        assert_eq!(one_week.used_percent, 7.5);
        assert_eq!(one_week.reset_at, Some(1_800_600_000));
        assert!(snapshot.windows.is_empty());
        assert_eq!(snapshot.allowed, Some(true));
        assert_eq!(snapshot.limit_reached, Some(false));
        assert_eq!(
            snapshot.rate_limit_reached_type.as_deref(),
            Some("workspace_member_credits_depleted")
        );
        let credits = snapshot.credits.expect("credits");
        assert!(credits.has_credits);
        assert!(!credits.unlimited);
        assert_eq!(credits.balance.as_deref(), Some("9.99"));
        let reset_credits = snapshot.reset_credits.expect("reset credits");
        assert_eq!(reset_credits.available_count, Some(2));
        assert!(reset_credits.credits.is_empty());
    }

    #[test]
    fn usage_payload_maps_five_hour_only_window() {
        let snapshot = snapshot_from_payload(
            json!({
                "plan_type": "plus",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 100,
                        "limit_window_seconds": 18_000,
                        "reset_at": 1_800_000_000
                    }
                }
            }),
            1_700_000_000,
        );

        assert!(snapshot.five_hour.is_some());
        assert!(snapshot.one_week.is_none());
        assert!(snapshot.windows.is_empty());
        assert_eq!(snapshot.allowed, None);
        assert_eq!(snapshot.limit_reached, None);
    }

    #[test]
    fn usage_payload_maps_30_day_window_to_windows_only() {
        let now = 1_700_000_000;
        let snapshot = snapshot_from_payload(
            json!({
                "plan_type": "free",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 12,
                        "limit_window_seconds": 2_592_000
                    }
                }
            }),
            now,
        );

        assert!(snapshot.five_hour.is_none(), "30 天不得当作 5h");
        assert!(snapshot.one_week.is_none(), "30 天不得当作周窗口");
        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].window_seconds, 2_592_000);
        assert_eq!(snapshot.windows[0].used_percent, 12.0);
        assert_eq!(
            snapshot.windows[0].reset_at,
            Some(now.saturating_add(2_592_000)),
            "缺省 reset_at 用 fetched_at + window 兜底"
        );
    }

    #[test]
    fn usage_payload_accepts_string_numbers_and_missing_reset_at() {
        let now = 1_700_000_000;
        let snapshot = snapshot_from_payload(
            json!({
                "rate_limit": {
                    "primary_window": {
                        "used_percent": "42.5",
                        "limit_window_seconds": "18000",
                        "reset_after_seconds": "600"
                    }
                }
            }),
            now,
        );

        let five_hour = snapshot.five_hour.expect("5h window");
        assert_eq!(five_hour.used_percent, 42.5);
        assert_eq!(five_hour.window_seconds, 18_000);
        assert_eq!(five_hour.reset_at, Some(now.saturating_add(600)));
    }

    #[test]
    fn usage_payload_accepts_numeric_credit_balance() {
        let snapshot = snapshot_from_payload(
            json!({
                "credits": {
                    "has_credits": true,
                    "unlimited": false,
                    "balance": 9.99
                }
            }),
            1_700_000_000,
        );

        let credits = snapshot.credits.expect("credits");
        assert_eq!(credits.balance.as_deref(), Some("9.99"));
    }

    #[test]
    fn usage_payload_tolerates_additional_rate_limits_without_using_them_as_main_quota() {
        let snapshot = snapshot_from_payload(
            json!({
                "plan_type": "business",
                "additional_rate_limits": [
                    {
                        "limit_name": "codex_other",
                        "metered_feature": "codex_other",
                        "normal_model_slug": "gpt-6-astra",
                        "rate_limit": {
                            "allowed": true,
                            "limit_reached": false,
                            "primary_window": {
                                "used_percent": 70,
                                "limit_window_seconds": 900,
                                "reset_at": 1_800_000_000
                            }
                        }
                    }
                ]
            }),
            1_700_000_000,
        );

        assert!(snapshot.five_hour.is_none());
        assert!(snapshot.one_week.is_none());
        assert!(snapshot.windows.is_empty());
    }

    #[test]
    fn usage_payload_keeps_single_week_window_without_fabricating_five_hour_usage() {
        let snapshot = snapshot_from_payload(
            json!({
                "plan_type": "plus",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 42.0,
                        "limit_window_seconds": 604_800,
                        "reset_at": 1_800_000_000
                    }
                }
            }),
            1_700_000_000,
        );

        assert!(snapshot.five_hour.is_none());
        let one_week = snapshot.one_week.expect("weekly window");
        assert_eq!(one_week.window_seconds, 604_800);
        assert_eq!(one_week.used_percent, 42.0);
    }

    #[test]
    fn usage_payload_accepts_plain_string_rate_limit_reached_type() {
        let snapshot = snapshot_from_payload(
            json!({ "plan_type": "pro", "rate_limit_reached_type": "rate_limit_reached" }),
            1_700_000_000,
        );

        assert_eq!(
            snapshot.rate_limit_reached_type.as_deref(),
            Some("rate_limit_reached")
        );
    }
}
