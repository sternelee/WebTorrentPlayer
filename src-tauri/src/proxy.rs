//! System proxy detection for BT and HTTP engines.
//!
//! Detection priority:
//! 1. `ALL_PROXY` / `SOCKS5_PROXY` / `SOCKS_PROXY` environment variables
//! 2. macOS system SOCKS proxy via `scutil --proxy` (desktop only)
//!
//! **reqwest** (HTTP downloader + CORS proxy) already reads `HTTP_PROXY`,
//! `HTTPS_PROXY`, and `ALL_PROXY` (with the `socks` feature) from the
//! environment automatically, and also reads macOS CFNetwork / Windows WinHTTP
//! system proxy settings.  No extra configuration is needed for reqwest.
//!
//! **librqbit** only understands SOCKS5 for its BT peer connections
//! (`SessionOptions::socks_proxy_url`).  Call [`detect_socks5_url`] and assign
//! the result to that field when building the session.

/// Detect a SOCKS5 proxy URL for `SessionOptions::socks_proxy_url`.
///
/// Returns `None` when no system proxy is found so librqbit connects directly.
pub fn detect_socks5_url() -> Option<String> {
    // ── Environment variables ────────────────────────────────────────────────
    // Priority follows curl convention: ALL_PROXY > SOCKS5_PROXY > SOCKS_PROXY.
    for key in [
        "ALL_PROXY",
        "all_proxy",
        "SOCKS5_PROXY",
        "socks5_proxy",
        "SOCKS_PROXY",
        "socks_proxy",
    ] {
        if let Ok(val) = std::env::var(key) {
            let trimmed = val.trim();
            if trimmed.starts_with("socks5://") || trimmed.starts_with("socks5h://") {
                return Some(trimmed.to_string());
            }
        }
    }

    // ── macOS system proxy (desktop only) ────────────────────────────────────
    #[cfg(target_os = "macos")]
    if let Some(url) = macos_socks5() {
        return Some(url);
    }

    None
}

// ── macOS scutil helper ───────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_socks5() -> Option<String> {
    let out = std::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    parse_scutil_socks(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "macos")]
fn parse_scutil_socks(output: &str) -> Option<String> {
    fn get_val<'a>(text: &'a str, key: &str) -> Option<&'a str> {
        text.lines()
            .find(|l| l.trim_start().starts_with(key))?
            .split_once(':')
            .map(|(_, v)| v.trim())
    }

    let enabled = get_val(output, "SOCKSEnable")?;
    if enabled != "1" {
        return None;
    }

    let host = get_val(output, "SOCKSProxy")?;
    let port = get_val(output, "SOCKSPort")?;

    Some(format!("socks5://{host}:{port}"))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn test_parse_scutil_socks_enabled() {
        let output = r#"<dictionary> {
  HTTPEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}"#;
        assert_eq!(
            parse_scutil_socks(output),
            Some("socks5://127.0.0.1:7890".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_parse_scutil_socks_disabled() {
        let output = r#"<dictionary> {
  SOCKSEnable : 0
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}"#;
        assert_eq!(parse_scutil_socks(output), None);
    }
}
