//! smartctl's answer, read as JSON rather than matched as text.
//!
//! WHAT WAS WRONG. The dispatcher ran `smartctl -H -A --json=c` and then asked
//! `out.contains("\"passed\": true") || out.contains("PASSED")`. Both halves are dead:
//!
//!   * `--json=c` is the COMPACT writer. It emits `"passed":true` — no space after the colon — so
//!     the first substring never appears in the output the code itself asked for.
//!   * `--json` replaces the plain-text report entirely, so `PASSED`, which is a word from that
//!     report, is never printed either.
//!
//! Every healthy disk therefore came back `healthy: false`. The only test fed the literal string
//! `PASSED`, which smartctl cannot produce under those flags — the test agreed with the code and
//! neither agreed with the program.
//!
//! It mattered little while `DEPSIS_SMART_DISKS` had to be typed into `api.env` by hand and was
//! usually empty. It matters now, because telemetry discovers the disks itself: without this fix
//! every appliance shows every disk red, which is the fastest way to teach an operator that the
//! health column means nothing.

use serde::Deserialize;

/// What DEPSIS takes from a SMART report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    /// `smart_status.passed`.
    ///
    /// ABSENT READS AS UNHEALTHY, and that is a deliberate direction rather than an oversight: a
    /// disk whose health cannot be read is not a disk anybody should be told is fine. The API layer
    /// already carries a note about the cost — the contract has no third state, so "smartctl was
    /// refused" and "this drive is failing" arrive as one value — and this is the safe half of that
    /// collapse.
    pub healthy: bool,
    /// `temperature.current`, when the drive reports one.
    ///
    /// Previously hard-coded `None` while the contract carried the field, so the number existed in
    /// the response shape and never in a response. SATA and NVMe report it in the same place in
    /// smartctl's JSON, which is the reason to read the JSON rather than the attribute table: the
    /// attribute ids differ per transport and per vendor.
    pub temperature_celsius: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct Report {
    #[serde(default)]
    smart_status: Option<Status>,
    #[serde(default)]
    temperature: Option<Temperature>,
}

#[derive(Debug, Deserialize)]
struct Status {
    #[serde(default)]
    passed: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct Temperature {
    #[serde(default)]
    current: Option<i32>,
}

/// Read one `smartctl --json` report.
///
/// Unparseable output is `healthy: false` with no temperature — see [`Summary::healthy`] for why
/// that direction. It is not an error: a disk that cannot be read must not take the pool status
/// down with it, and `SystemService.disks` depends on that.
pub fn parse(out: &str) -> Summary {
    let Ok(report) = serde_json::from_str::<Report>(out) else {
        return Summary {
            healthy: false,
            temperature_celsius: None,
        };
    };
    Summary {
        healthy: report
            .smart_status
            .and_then(|status| status.passed)
            .unwrap_or(false),
        temperature_celsius: report.temperature.and_then(|t| t.current),
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of \
              service. In tests the opposite holds: a failed assertion SHOULD panic, and \
              indexing a fixture reads better than unwrapping an Option."
)]
mod tests {
    use super::*;

    /// The shape `smartctl -H -A --json=c` actually writes: compact, no space after the colon.
    ///
    /// This is the fixture the old test should have had. With a space after `"passed":` it passes
    /// against the old substring check and against this parser, and proves nothing about either.
    const COMPACT_HEALTHY: &str = r#"{"json_format_version":[1,0],"smartctl":{"exit_status":0},"device":{"name":"/dev/sda"},"smart_status":{"passed":true},"temperature":{"current":34}}"#;

    const COMPACT_FAILING: &str =
        r#"{"smart_status":{"passed":false},"temperature":{"current":52}}"#;

    #[test]
    fn a_healthy_disk_reads_as_healthy() {
        // The whole bug: the previous check looked for `"passed": true` WITH a space, which the
        // compact writer never emits, so this exact string reported the disk as failing.
        assert_eq!(
            parse(COMPACT_HEALTHY),
            Summary {
                healthy: true,
                temperature_celsius: Some(34),
            }
        );
    }

    #[test]
    fn a_failing_disk_reads_as_failing() {
        let summary = parse(COMPACT_FAILING);
        assert!(!summary.healthy);
        assert_eq!(summary.temperature_celsius, Some(52));
    }

    #[test]
    fn the_pretty_writer_is_read_the_same_way() {
        // `--json` without `=c` pretty-prints. The dispatcher asks for compact, but a parser that
        // only worked for one of the two would be the same class of mistake as the one it replaces.
        let pretty = "{\n  \"smart_status\": {\n    \"passed\": true\n  }\n}";
        assert!(parse(pretty).healthy);
    }

    #[test]
    fn a_report_with_no_health_section_is_not_healthy() {
        // Some USB bridges answer without a SMART status at all. "We could not read it" must not
        // render as a green tick.
        assert!(!parse(r#"{"device":{"name":"/dev/sdb"}}"#).healthy);
        assert!(!parse(r#"{"smart_status":{}}"#).healthy);
    }

    #[test]
    fn unreadable_output_is_not_healthy_and_does_not_panic() {
        for junk in ["", "not json", "<html>", "null", "[]"] {
            let summary = parse(junk);
            assert!(!summary.healthy, "{junk}");
            assert_eq!(summary.temperature_celsius, None, "{junk}");
        }
    }

    #[test]
    fn the_plain_text_word_is_not_a_health_signal() {
        // The other dead half of the old check. `--json` suppresses the plain-text report, so a
        // parser that still honoured the word would be honouring output the flags forbid — and
        // would say "healthy" about any report that happened to contain it in a device model.
        assert!(!parse("SMART overall-health self-assessment test result: PASSED").healthy);
    }

    #[test]
    fn a_missing_temperature_is_absent_rather_than_zero() {
        // 0 °C is a plausible reading. Reporting an unknown temperature as one would put a
        // believable wrong number on a dashboard.
        assert_eq!(
            parse(r#"{"smart_status":{"passed":true}}"#).temperature_celsius,
            None
        );
    }
}
