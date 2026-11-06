//! ChatGPT/Codex 桌面端的项目状态备份与跨账号同步。
//!
//! 桌面端把本地项目清单按账号快照保存（`electron-account-renderer-state-v1.inactive[hash].globals`），
//! 而“会话 → 项目归属”是全局的。切到没有项目快照的账号时，项目清单只剩自动创建的 `/`，
//! 会话会全部显示在“最近”里，看起来就是分组丢失；切回原账号又恢复。
//!
//! 本模块在切换账号（应用已退出）时做两件事：
//! 1. 备份 `~/.codex/.codex-global-state.json`（应用自身的 `.bak` 与主文件内容相同，没有历史）；
//! 2. 以当前账号的项目清单为来源，同步写入目标账号快照，让不同账号看到相同的本地项目分组。
//!    只替换项目相关字段，目标快照的其它状态（atoms、未知 globals 键）保持不变。
//!
//! 这里不修改会话归属、不写数据库、不伪造项目；任何异常都只记录日志并跳过，不阻断账号切换。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const GLOBAL_STATE_FILE_NAME: &str = ".codex-global-state.json";
const BACKUP_DIR_NAME: &str = "codex-desktop-state-backups";
const MAX_BACKUPS: usize = 10;

const RENDERER_STATE_KEY: &str = "electron-account-renderer-state-v1";
const LOCAL_PROJECTS_KEY: &str = "local-projects";
const PROJECT_ORDER_KEY: &str = "project-order";
const SELECTED_PROJECT_KEY: &str = "selected-project";
const PROJECT_MAPPING_KEY: &str = "app-server-project-id-by-legacy-project-id-by-host";

/// 一次切换前的项目状态准备结果。
#[derive(Debug)]
pub(crate) struct PreparedProjectState {
    pub(crate) backup_path: PathBuf,
    pub(crate) target_hash: Option<String>,
    pub(crate) seeded: bool,
    pub(crate) seeded_projects: usize,
}

/// 在切换账号前备份项目状态，并尽量把项目清单同步到目标账号快照。
///
/// 调用前提：ChatGPT 桌面端已经退出。返回 None 表示没有可备份的状态文件或读取/备份失败；
/// 此时调用方应继续切换（账号切换不能因为状态准备失败而中断）。
pub(crate) fn prepare_project_state(
    data_dir: &Path,
    target_auth_json: &Value,
) -> Option<PreparedProjectState> {
    #[cfg(target_os = "macos")]
    {
        prepare_project_state_impl(data_dir, target_auth_json)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (data_dir, target_auth_json);
        None
    }
}

#[cfg(any(target_os = "macos", test))]
fn prepare_project_state_impl(
    data_dir: &Path,
    target_auth_json: &Value,
) -> Option<PreparedProjectState> {
    let codex_home = dirs::home_dir()?.join(".codex");
    let state_path = codex_home.join(GLOBAL_STATE_FILE_NAME);
    let raw = match fs::read_to_string(&state_path) {
        Ok(raw) => raw,
        Err(error) => {
            log::debug!(
                "未找到 ChatGPT 全局状态文件，跳过项目状态准备 {}: {error}",
                state_path.display()
            );
            return None;
        }
    };
    let mut state: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "ChatGPT 全局状态文件无法解析，跳过项目状态准备 {}: {error}",
                state_path.display()
            );
            return None;
        }
    };

    // 先备份，备份失败就不做任何修改。
    let backup_path = backup_state_file(&state_path, data_dir)?;
    log_global_state_fingerprint(&backup_path);

    let target_hash = account_renderer_hash(target_auth_json);
    let mut seeded = false;
    let mut seeded_projects = 0usize;

    let current_hash = current_renderer_hash(&codex_home);
    if let Some(target_hash) = target_hash.as_deref() {
        let owner = renderer_owner(&state);
        match (owner.as_deref(), current_hash.as_deref()) {
            (Some(owner_hash), Some(current_hash)) if owner_hash != current_hash => {
                // 运行中看到的 owner 与当前 auth.json 对不上，说明应用或 schema 已变化，宁可不写。
                log::warn!(
                    "ChatGPT 账号快照哈希与当前登录态不一致，跳过项目清单同步（owner={owner_hash}, current={current_hash}）"
                );
            }
            (Some(owner_hash), _) if owner_hash == target_hash => {
                log::debug!("目标账号与当前账号相同，跳过项目清单同步");
            }
            _ => match seed_project_globals(&mut state, target_hash, current_hash.as_deref()) {
                Ok(Some(projects)) => {
                    if write_global_state_atomically(&state_path, &state) {
                        seeded = true;
                        seeded_projects = projects;
                    } else {
                        log::warn!("写入 ChatGPT 项目清单同步结果失败，已保留备份: {}", backup_path.display());
                    }
                }
                Ok(None) => {
                    log::warn!("ChatGPT 账号快照结构不符合预期，跳过项目清单同步");
                }
                Err(error) => {
                    log::warn!("同步 ChatGPT 项目清单失败: {error}");
                }
            },
        }
    }

    Some(PreparedProjectState {
        backup_path,
        target_hash,
        seeded,
        seeded_projects,
    })
}

fn renderer_owner(state: &Value) -> Option<String> {
    state
        .get(RENDERER_STATE_KEY)?
        .get("owner")?
        .as_str()
        .map(str::to_string)
}

/// 计算账号在 `electron-account-renderer-state-v1` 里的哈希：
/// `sha256(JSON.stringify([chatgpt_user_id, chatgpt_account_id]))`。
fn account_renderer_hash(auth_json: &Value) -> Option<String> {
    let id_token = auth_json
        .get("tokens")?
        .get("id_token")?
        .as_str()?
        .trim();
    let payload = id_token.split('.').nth(1)?;
    let decoded = decode_base64url(payload)?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    let auth = claims.get("https://api.openai.com/auth")?;
    let user_id = auth
        .get("chatgpt_user_id")
        .or_else(|| auth.get("user_id"))?
        .as_str()?;
    let account_id = auth.get("chatgpt_account_id")?.as_str()?;
    let serialized = serde_json::to_string(&(user_id, account_id)).ok()?;
    Some(sha256_hex(serialized.as_bytes()))
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    const URL_SAFE_NO_PAD: base64::engine::general_purpose::GeneralPurpose =
        base64::engine::general_purpose::URL_SAFE_NO_PAD;
    if let Ok(bytes) = URL_SAFE_NO_PAD.decode(value) {
        return Some(bytes);
    }
    base64::engine::general_purpose::URL_SAFE.decode(value).ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn current_renderer_hash(codex_home: &Path) -> Option<String> {
    let raw = fs::read_to_string(codex_home.join("auth.json")).ok()?;
    let auth_json: Value = serde_json::from_str(&raw).ok()?;
    account_renderer_hash(&auth_json)
}

/// 把当前账号的项目清单写入目标账号快照；返回写入的项目数量。
///
/// 关键设计：以“当前正在使用的账号”的项目清单为唯一事实源，整体覆盖目标账号快照里的
/// 项目相关字段（项目/排序/选中项/映射），而不是做并集。这样：
/// - 切到目标账号时能看到和当前账号一样的项目分组；
/// - 在当前账号里新增/删除项目，会随下一次切换同步到其他账号；
/// - 不会把其他账号快照里的旧项目“复活”。
///
/// 目标快照的其它字段（atoms、未知 globals 键）保持不动。
#[cfg(any(target_os = "macos", test))]
fn seed_project_globals(
    state: &mut Value,
    target_hash: &str,
    current_hash: Option<&str>,
) -> Result<Option<usize>, String> {
    let renderer = state
        .get_mut(RENDERER_STATE_KEY)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "缺少 electron-account-renderer-state-v1".to_string())?;
    if !renderer.get("inactive").map(Value::is_object).unwrap_or(false) {
        renderer.insert("inactive".to_string(), json!({}));
    }

    let source = select_source_globals(state, current_hash)?;
    let Some(source) = source else {
        return Ok(None);
    };
    if source.local_projects.is_empty() {
        return Ok(None);
    }

    let inactive = state
        .get_mut(RENDERER_STATE_KEY)
        .and_then(Value::as_object_mut)
        .and_then(|renderer| renderer.get_mut("inactive"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "无法访问 inactive 快照".to_string())?;
    let target_snapshot = inactive
        .entry(target_hash.to_string())
        .or_insert_with(|| json!({ "atoms": {}, "globals": {} }));
    if !target_snapshot.is_object() {
        return Err("目标账号快照不是对象".to_string());
    }
    if !target_snapshot
        .get("globals")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        target_snapshot["globals"] = json!({});
    }
    let globals = target_snapshot
        .get_mut("globals")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "目标账号快照缺少 globals".to_string())?;

    apply_managed_globals(globals, &source);
    Ok(Some(source.local_projects.len()))
}

/// 取“当前账号”的项目清单：优先顶层（应用未 park 时），
/// 其次当前账号快照（应用退出时已 park），最后才退回所有快照的并集（兜底）。
#[cfg(any(target_os = "macos", test))]
fn select_source_globals(
    state: &Value,
    current_hash: Option<&str>,
) -> Result<Option<ManagedGlobals>, String> {
    let mut top = ManagedGlobals::default();
    merge_managed_snapshot(&mut top, Some(state));
    if !top.local_projects.is_empty() {
        return Ok(Some(top));
    }

    if let Some(current_hash) = current_hash {
        if let Some(globals) = state
            .get(RENDERER_STATE_KEY)
            .and_then(|value| value.get("inactive"))
            .and_then(|value| value.get(current_hash))
            .and_then(|snapshot| snapshot.get("globals"))
        {
            let mut parked = ManagedGlobals::default();
            merge_managed_snapshot(&mut parked, Some(globals));
            if !parked.local_projects.is_empty() {
                return Ok(Some(parked));
            }
        }
    }

    // 兜底：当前 hash 不可得时，用所有快照的并集，至少别让目标账号完全空白。
    let mut union = ManagedGlobals::default();
    if let Some(inactive) = state
        .get(RENDERER_STATE_KEY)
        .and_then(|value| value.get("inactive"))
        .and_then(Value::as_object)
    {
        for snapshot in inactive.values() {
            if let Some(globals) = snapshot.get("globals") {
                merge_managed_snapshot(&mut union, Some(globals));
            }
        }
    }
    Ok((!union.local_projects.is_empty()).then_some(union))
}

#[derive(Debug, Default)]
struct ManagedGlobals {
    local_projects: Map<String, Value>,
    project_order: Vec<String>,
    selected_project: Option<Value>,
    mapping: Map<String, Value>,
}

fn merge_managed_snapshot(merged: &mut ManagedGlobals, globals: Option<&Value>) {
    let Some(globals) = globals else {
        return;
    };
    if let Some(projects) = globals.get(LOCAL_PROJECTS_KEY).and_then(Value::as_object) {
        for (key, value) in projects {
            merged
                .local_projects
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
    if let Some(order) = globals.get(PROJECT_ORDER_KEY).and_then(Value::as_array) {
        for item in order.iter().filter_map(Value::as_str) {
            if !merged.project_order.iter().any(|existing| existing == item) {
                merged.project_order.push(item.to_string());
            }
        }
    }
    if merged.selected_project.is_none() {
        if let Some(selected) = globals.get(SELECTED_PROJECT_KEY) {
            if selected.is_object() {
                merged.selected_project = Some(selected.clone());
            }
        }
    }
    if let Some(mapping) = globals.get(PROJECT_MAPPING_KEY).and_then(Value::as_object) {
        for (host, hosts) in mapping {
            let Some(source) = hosts.as_object() else {
                continue;
            };
            let entry = merged.mapping.entry(host.clone()).or_insert_with(|| json!({}));
            if !entry.is_object() {
                *entry = json!({});
            }
            if let Some(target) = entry.as_object_mut() {
                for (legacy, server) in source {
                    target
                        .entry(legacy.clone())
                        .or_insert_with(|| server.clone());
                }
            }
        }
    }
}

fn apply_managed_globals(globals: &mut Map<String, Value>, managed: &ManagedGlobals) {
    globals.insert(
        LOCAL_PROJECTS_KEY.to_string(),
        Value::Object(managed.local_projects.clone()),
    );
    if managed.project_order.is_empty() {
        globals.remove(PROJECT_ORDER_KEY);
    } else {
        globals.insert(
            PROJECT_ORDER_KEY.to_string(),
            Value::Array(
                managed
                    .project_order
                    .iter()
                    .map(|id| Value::String(id.clone()))
                    .collect(),
            ),
        );
    }
    match &managed.selected_project {
        Some(selected) => {
            globals.insert(SELECTED_PROJECT_KEY.to_string(), selected.clone());
        }
        None => {
            globals.remove(SELECTED_PROJECT_KEY);
        }
    }
    if managed.mapping.is_empty() {
        globals.remove(PROJECT_MAPPING_KEY);
    } else {
        globals.insert(
            PROJECT_MAPPING_KEY.to_string(),
            Value::Object(managed.mapping.clone()),
        );
    }
}

fn backup_state_file(state_path: &Path, data_dir: &Path) -> Option<PathBuf> {
    if !state_path.is_file() {
        return None;
    }
    let backup_dir = data_dir.join(BACKUP_DIR_NAME);
    if let Err(error) = fs::create_dir_all(&backup_dir) {
        log::warn!(
            "创建 ChatGPT 项目状态备份目录失败 {}: {error}",
            backup_dir.display()
        );
        return None;
    }
    let timestamp_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let destination = backup_dir.join(format!("{timestamp_nanos}-{}.json", uuid::Uuid::new_v4()));
    if let Err(error) = fs::copy(state_path, &destination) {
        log::warn!(
            "备份 ChatGPT 项目状态失败 {}: {error}",
            destination.display()
        );
        return None;
    }
    prune_backups(&backup_dir, &destination);
    Some(destination)
}

#[cfg(any(target_os = "macos", test))]
fn write_global_state_atomically(path: &Path, value: &Value) -> bool {
    let text = match serde_json::to_vec(value) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("序列化 ChatGPT 全局状态失败: {error}");
            return false;
        }
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let timestamp_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp_path = parent.join(format!(".{file_name}.tmp-{timestamp_nanos}-{}", uuid::Uuid::new_v4()));
    if let Err(error) = fs::write(&temp_path, &text) {
        log::warn!("写入临时 ChatGPT 状态文件失败 {}: {error}", temp_path.display());
        return false;
    }
    if let Ok(metadata) = fs::metadata(path) {
        let _ = fs::set_permissions(&temp_path, metadata.permissions());
    }
    if let Err(error) = fs::rename(&temp_path, path) {
        log::warn!("替换 ChatGPT 状态文件失败 {}: {error}", path.display());
        let _ = fs::remove_file(&temp_path);
        return false;
    }
    true
}

fn prune_backups(backup_dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(backup_dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            (modified, entry.path())
        })
        .filter(|(_, path)| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect();
    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    while files.len() > MAX_BACKUPS {
        let Some(index) = files.iter().position(|(_, path)| path != keep) else {
            return;
        };
        let (_, oldest) = files.remove(index);
        if let Err(error) = fs::remove_file(&oldest) {
            log::warn!(
                "清理旧的 ChatGPT 项目状态备份失败 {}: {error}",
                oldest.display()
            );
        }
    }
}

fn log_global_state_fingerprint(path: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        log::warn!("ChatGPT 项目状态备份无法解析为 JSON: {}", path.display());
        return;
    };
    let local_projects = value
        .get(LOCAL_PROJECTS_KEY)
        .and_then(Value::as_object)
        .map(|projects| projects.len())
        .unwrap_or(0);
    let assignments = value
        .get("thread-project-assignments")
        .and_then(Value::as_object)
        .map(|assignments| assignments.len())
        .unwrap_or(0);
    let owner = value
        .get(RENDERER_STATE_KEY)
        .and_then(|value| value.get("owner"))
        .and_then(Value::as_str)
        .unwrap_or("");
    log::info!(
        "ChatGPT 项目状态快照: local-projects={local_projects}, assignments={assignments}, owner={owner}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "codex-tools-desktop-state-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn fake_id_token(user_id: &str, account_id: &str) -> String {
        let payload = json!({
            "https://api.openai.com/auth": {
                "chatgpt_user_id": user_id,
                "chatgpt_account_id": account_id
            }
        });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).expect("payload"));
        format!("header.{encoded}.signature")
    }

    fn auth_with(user_id: &str, account_id: &str) -> Value {
        json!({ "tokens": { "id_token": fake_id_token(user_id, account_id) } })
    }

    #[test]
    fn account_hash_matches_desktop_hash_formula() {
        let auth = auth_with("user-test", "account-test");
        let expected = sha256_hex(b"[\"user-test\",\"account-test\"]");
        assert_eq!(account_renderer_hash(&auth).as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn seed_replaces_target_projects_with_current_account_list() {
        let mut state = json!({
            "local-projects": {
                "project-a": { "name": "A", "rootPaths": ["/a"] },
                "project-b": { "name": "B", "rootPaths": ["/b"] }
            },
            "project-order": ["project-a", "project-b"],
            "selected-project": { "type": "local", "projectId": "project-b" },
            "app-server-project-id-by-legacy-project-id-by-host": {
                "local:/Users/test/.codex": { "project-a": "server-a", "project-b": "server-b" }
            },
            "electron-account-renderer-state-v1": {
                "owner": "owner-hash",
                "inactive": {
                    "target-hash": {
                        "atoms": { "keep-atom": true },
                        "globals": {
                            "local-projects": { "project-stale": { "name": "旧项目" } },
                            "project-order": ["project-stale"],
                            "selected-project": { "type": "local", "projectId": "project-stale" },
                            "app-server-project-id-by-legacy-project-id-by-host": {
                                "local:/Users/test/.codex": { "project-stale": "server-stale" }
                            }
                        }
                    }
                }
            }
        });

        let projects = seed_project_globals(&mut state, "target-hash", None)
            .expect("seed should succeed")
            .expect("projects should be present");
        assert_eq!(projects, 2);

        let snapshot = &state[RENDERER_STATE_KEY]["inactive"]["target-hash"];
        assert_eq!(snapshot["atoms"]["keep-atom"], json!(true));
        let globals = &snapshot["globals"];
        assert_eq!(
            globals["local-projects"].as_object().expect("projects").len(),
            2
        );
        assert!(globals["local-projects"].get("project-a").is_some());
        assert!(
            globals["local-projects"].get("project-stale").is_none(),
            "其他账号快照里的旧项目不应复活"
        );
        assert_eq!(globals["project-order"], json!(["project-a", "project-b"]));
        assert_eq!(
            globals["selected-project"]["projectId"],
            json!("project-b")
        );
        assert!(
            globals["app-server-project-id-by-legacy-project-id-by-host"]
                ["local:/Users/test/.codex"]
                .get("project-stale")
                .is_none()
        );
        // 顶层数据不得被改动。
        assert_eq!(
            state["local-projects"].as_object().expect("top projects").len(),
            2
        );
    }

    #[test]
    fn seed_uses_parked_current_snapshot_when_top_level_is_empty() {
        let mut state = json!({
            "electron-account-renderer-state-v1": {
                "owner": Value::Null,
                "inactive": {
                    "current-hash": {
                        "atoms": {},
                        "globals": {
                            "local-projects": { "project-parked": { "name": "Parked" } },
                            "project-order": ["project-parked"]
                        }
                    },
                    "target-hash": {
                        "atoms": {},
                        "globals": {
                            "local-projects": { "project-old": { "name": "Old" } }
                        }
                    }
                }
            }
        });

        let projects = seed_project_globals(&mut state, "target-hash", Some("current-hash"))
            .expect("seed should succeed")
            .expect("projects should be present");
        assert_eq!(projects, 1);
        let globals = &state[RENDERER_STATE_KEY]["inactive"]["target-hash"]["globals"];
        assert!(globals["local-projects"].get("project-parked").is_some());
        assert!(globals["local-projects"].get("project-old").is_none());
    }

    #[test]
    fn seed_falls_back_to_union_when_current_hash_unknown() {
        let mut state = json!({
            "electron-account-renderer-state-v1": {
                "owner": Value::Null,
                "inactive": {
                    "hash-a": {
                        "atoms": {},
                        "globals": { "local-projects": { "project-a": { "name": "A" } } }
                    },
                    "hash-b": {
                        "atoms": {},
                        "globals": { "local-projects": { "project-b": { "name": "B" } } }
                    }
                }
            }
        });

        let projects = seed_project_globals(&mut state, "target-hash", None)
            .expect("seed should succeed")
            .expect("projects should be present");
        assert_eq!(projects, 2);
        let globals = &state[RENDERER_STATE_KEY]["inactive"]["target-hash"]["globals"];
        assert!(globals["local-projects"].get("project-a").is_some());
        assert!(globals["local-projects"].get("project-b").is_some());
    }

    #[test]
    fn seed_returns_none_when_no_source_projects() {
        let mut state = json!({
            "electron-account-renderer-state-v1": { "owner": Value::Null, "inactive": {} }
        });
        assert!(
            seed_project_globals(&mut state, "target-hash", None)
                .expect("seed should succeed")
                .is_none()
        );
    }

    #[test]
    fn seed_returns_error_without_renderer_state() {
        let mut state = json!({ "local-projects": { "project-a": { "name": "A" } } });
        assert!(seed_project_globals(&mut state, "target-hash", None).is_err());
    }

    #[test]
    fn prepare_backs_up_state_before_seeding() {
        let codex_home = temp_dir("prepare-home");
        let data_dir = temp_dir("prepare-data");
        let state_path = codex_home.join(GLOBAL_STATE_FILE_NAME);
        fs::create_dir_all(&codex_home).expect("create codex home");
        fs::write(
            &state_path,
            serde_json::to_vec(&json!({
                "local-projects": { "project-a": { "name": "A" } },
                "electron-account-renderer-state-v1": {
                    "owner": "owner-hash",
                    "inactive": {}
                }
            }))
            .expect("state json"),
        )
        .expect("write state");

        let auth = auth_with("user-target", "account-target");
        let target_hash = account_renderer_hash(&auth).expect("target hash");
        let (backup_path, projects) = {
            let raw = fs::read_to_string(&state_path).expect("read state");
            let mut state: Value = serde_json::from_str(&raw).expect("parse state");
            let backup_path = backup_state_file(&state_path, &data_dir).expect("backup path");
            let projects = seed_project_globals(&mut state, &target_hash, None)
                .expect("seed should succeed")
                .expect("projects");
            assert!(write_global_state_atomically(&state_path, &state));
            (backup_path, projects)
        };

        assert!(backup_path.is_file());
        assert_eq!(projects, 1);
        let written: Value = serde_json::from_str(
            &fs::read_to_string(&state_path).expect("read written state"),
        )
        .expect("parse written state");
        assert!(
            written[RENDERER_STATE_KEY]["inactive"][&target_hash]["globals"]
                ["local-projects"]
                .get("project-a")
                .is_some()
        );

        let _ = fs::remove_dir_all(&codex_home);
        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn prepare_returns_none_for_missing_state_file() {
        let codex_home = temp_dir("missing-home");
        let data_dir = temp_dir("missing-data");
        fs::create_dir_all(&codex_home).expect("create empty home");
        assert!(backup_state_file(&codex_home.join(GLOBAL_STATE_FILE_NAME), &data_dir).is_none());
        assert!(!data_dir.exists());
    }
}
