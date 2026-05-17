mod codex_bridge;
mod error;
mod exec;
mod prompt;
#[cfg(test)]
mod test_support;
mod threshold;

use crate::codex_bridge::summarize_output;
use crate::error::SparkshellError;
use crate::exec::{execute_command, CommandOutput};
use crate::threshold::{combined_visible_lines, read_line_threshold};
use omx_mux::build_capture_pane_args;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process;

const DEFAULT_TMUX_TAIL_LINES: usize = 200;
const MIN_TMUX_TAIL_LINES: usize = 100;
const MAX_TMUX_TAIL_LINES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum SparkShellTarget {
    Command(Vec<String>),
    TmuxPane { pane_id: String, tail_lines: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SparkShellOptions {
    target: SparkShellTarget,
    json: bool,
    budget: usize,
    team: Option<String>,
    worker: Option<String>,
}

#[derive(Debug, Clone)]
struct Evidence {
    stdout_lines: usize,
    stderr_lines: usize,
    raw_hash: String,
    pane_id: Option<String>,
    tail_lines: Option<usize>,
    line_range: Option<String>,
}

const DEFAULT_BUDGET: usize = 1000;
const STALE_HEARTBEAT_MS: u64 = 120_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "--help" || arg == "-h")
    {
        println!("{}", usage_text());
        return;
    }
    if let Err(error) = run(args) {
        eprintln!("omx sparkshell: {error}");
        process::exit(error.raw_exit_code());
    }
}

fn run(args: Vec<String>) -> Result<(), SparkshellError> {
    let options = parse_input(&args)?;
    let execution_argv = match &options.target {
        SparkShellTarget::Command(command) => command.clone(),
        SparkShellTarget::TmuxPane {
            pane_id,
            tail_lines,
        } => {
            let mut argv = vec!["tmux".to_string()];
            argv.extend(build_capture_pane_args(pane_id, *tail_lines));
            argv
        }
    };

    let output = execute_command(&execution_argv)?;
    let threshold = read_line_threshold();
    let line_count = combined_visible_lines(&output.stdout, &output.stderr);

    if options.json {
        let summary = if line_count <= threshold {
            compact_text(&combined_text(&output), options.budget)
        } else {
            summarize_output(&execution_argv, &output)
                .unwrap_or_else(|error| format!("summary unavailable: {error}"))
        };
        let evidence = build_evidence(&options, &output);
        write_json_report(&options, &output, &summary, &evidence)?;
        process::exit(output.exit_code());
    }

    if line_count <= threshold {
        write_raw_output(&output.stdout, &output.stderr)?;
        process::exit(output.exit_code());
    }

    match summarize_output(&execution_argv, &output) {
        Ok(summary) => {
            let mut stdout = io::stdout().lock();
            stdout.write_all(compact_text(&summary, options.budget).as_bytes())?;
            if !summary.ends_with('\n') {
                stdout.write_all(b"\n")?;
            }
            stdout.flush()?;
        }
        Err(error) => {
            write_raw_output(&output.stdout, &output.stderr)?;
            eprintln!("omx sparkshell: summary unavailable ({error})");
        }
    }

    process::exit(output.exit_code());
}

fn write_raw_output(stdout_bytes: &[u8], stderr_bytes: &[u8]) -> Result<(), SparkshellError> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(stdout_bytes)?;
    stdout.flush()?;

    let mut stderr = io::stderr().lock();
    stderr.write_all(stderr_bytes)?;
    stderr.flush()?;
    Ok(())
}

fn usage_text() -> String {
    format!(
        concat!(
            "usage: omx-sparkshell <command> [args...]\n",
            "   or: omx-sparkshell --tmux-pane <pane-id> [--tail-lines <{min}-{max}>]\n",
            "\n",
            "Direct command mode executes argv without shell metacharacter parsing.\n",
            "Tmux pane mode captures a larger pane tail and applies the same raw-vs-summary behavior.\n"
        ),
        min = MIN_TMUX_TAIL_LINES,
        max = MAX_TMUX_TAIL_LINES,
    )
}

fn parse_input(args: &[String]) -> Result<SparkShellOptions, SparkshellError> {
    if args.is_empty() {
        return Err(SparkshellError::InvalidArgs(usage_text()));
    }

    let mut pane_id: Option<String> = None;
    let mut tail_lines = DEFAULT_TMUX_TAIL_LINES;
    let mut explicit_tail_lines = false;
    let mut positional = Vec::new();
    let mut json = false;
    let mut budget = DEFAULT_BUDGET;
    let mut team = None;
    let mut worker = None;

    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        if token == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if token == "--budget" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--budget requires a numeric value".to_string(),
                ));
            };
            budget = parse_positive_usize(next, "--budget")?;
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--budget=") {
            budget = parse_positive_usize(value, "--budget")?;
            index += 1;
            continue;
        }
        if token == "--team" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--team requires a value".to_string(),
                ));
            };
            team = Some(next.clone());
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--team=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--team requires a value".to_string(),
                ));
            }
            team = Some(value.to_string());
            index += 1;
            continue;
        }
        if token == "--worker" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--worker requires a value".to_string(),
                ));
            };
            worker = Some(next.clone());
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--worker=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--worker requires a value".to_string(),
                ));
            }
            worker = Some(value.to_string());
            index += 1;
            continue;
        }
        if token == "--tmux-pane" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            };
            if next.starts_with('-') {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            }
            pane_id = Some(next.clone());
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--tmux-pane=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            }
            pane_id = Some(value.to_string());
            index += 1;
            continue;
        }
        if token == "--tail-lines" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--tail-lines requires a numeric value".to_string(),
                ));
            };
            tail_lines = parse_tail_lines(next)?;
            explicit_tail_lines = true;
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--tail-lines=") {
            tail_lines = parse_tail_lines(value)?;
            explicit_tail_lines = true;
            index += 1;
            continue;
        }

        positional.push(token.clone());
        index += 1;
    }

    let target = if let Some(pane_id) = pane_id {
        if !positional.is_empty() {
            return Err(SparkshellError::InvalidArgs(
                "tmux pane mode does not accept an additional command".to_string(),
            ));
        }
        SparkShellTarget::TmuxPane {
            pane_id,
            tail_lines,
        }
    } else {
        if explicit_tail_lines {
            return Err(SparkshellError::InvalidArgs(
                "--tail-lines requires --tmux-pane".to_string(),
            ));
        }
        SparkShellTarget::Command(positional)
    };

    Ok(SparkShellOptions {
        target,
        json,
        budget,
        team,
        worker,
    })
}

fn parse_positive_usize(raw: &str, flag: &str) -> Result<usize, SparkshellError> {
    raw.trim()
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| SparkshellError::InvalidArgs(format!("{flag} requires a positive integer")))
}

fn build_evidence(options: &SparkShellOptions, output: &CommandOutput) -> Evidence {
    let text = combined_text(output);
    let lines = text.lines().count();
    let (pane_id, tail_lines) = match &options.target {
        SparkShellTarget::TmuxPane {
            pane_id,
            tail_lines,
        } => (Some(pane_id.clone()), Some(*tail_lines)),
        SparkShellTarget::Command(_) => (None, None),
    };
    Evidence {
        stdout_lines: String::from_utf8_lossy(&output.stdout).lines().count(),
        stderr_lines: String::from_utf8_lossy(&output.stderr).lines().count(),
        raw_hash: hash_text(&text),
        pane_id,
        tail_lines,
        line_range: (lines > 0).then(|| format!("1-{lines}")),
    }
}

fn combined_text(output: &CommandOutput) -> String {
    format!("{}{}", output.stdout_text(), output.stderr_text())
}

fn hash_text(text: &str) -> String {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn compact_text(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.to_string();
    }
    let end = safe_boundary(text, budget);
    format!(
        "{}\n[truncated: {} chars omitted]",
        &text[..end],
        text.len().saturating_sub(end)
    )
}

fn safe_boundary(text: &str, max: usize) -> usize {
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let next = index + ch.len_utf8();
        if next > max {
            break;
        }
        end = next;
    }
    end
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            ch if ch <= '\u{1f}' => escaped.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => escaped.push(ch),
        }
    }
    escaped
}

fn json_str(value: &str) -> String {
    format!("\"{}\"", json_escape(value))
}

fn json_string_array(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| json_str(value))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn optional_json_string(value: &Option<String>) -> String {
    value
        .as_ref()
        .map(|value| json_str(value))
        .unwrap_or_else(|| "null".to_string())
}

#[derive(Debug, Clone)]
struct Diagnostics {
    classification: String,
    next_action: String,
    confidence: f32,
    errors: Vec<String>,
    warnings: Vec<String>,
}

fn classify(options: &SparkShellOptions, output: &CommandOutput) -> Diagnostics {
    let text = combined_text(output).to_ascii_lowercase();
    let mut diagnostics = Diagnostics {
        classification: "unknown".to_string(),
        next_action: "inspect raw output".to_string(),
        confidence: 0.45,
        errors: Vec::new(),
        warnings: Vec::new(),
    };

    if text.contains("authorization") || text.contains("authentication") || text.contains("401") {
        diagnostics.classification = "auth_error".to_string();
        diagnostics.confidence = 0.8;
        diagnostics
            .errors
            .push("authentication-like error in output".to_string());
    } else if text.contains("typeerror") || text.contains("type error") {
        diagnostics.classification = "type_error".to_string();
        diagnostics.confidence = 0.75;
        diagnostics
            .errors
            .push("type error pattern in output".to_string());
    } else if text.contains("test failed") || text.contains("failures:") || text.contains("failed")
    {
        diagnostics.classification = "test_failure".to_string();
        diagnostics.confidence = 0.65;
        diagnostics
            .errors
            .push("failure pattern in output".to_string());
    } else if text.contains("press enter")
        || text.contains("waiting for input")
        || text.contains("continue?")
    {
        diagnostics.classification = "waiting_for_input".to_string();
        diagnostics.confidence = 0.75;
    } else if text.contains("thinking") || text.contains("running") || text.contains("building") {
        diagnostics.classification = "busy_processing".to_string();
        diagnostics.next_action = "wait".to_string();
        diagnostics.confidence = 0.65;
        diagnostics.warnings.push("do not shutdown yet".to_string());
    }

    if let (Some(team), Some(worker)) = (&options.team, &options.worker) {
        if let Some(team_diagnostics) = classify_team(team, worker) {
            diagnostics = team_diagnostics;
        }
    }

    diagnostics
}

fn classify_team(team: &str, worker: &str) -> Option<Diagnostics> {
    let state_root = std::env::var("OMX_TEAM_STATE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".omx/state"));
    let base = state_root
        .join("team")
        .join(team)
        .join("workers")
        .join(worker);
    if !base.exists() {
        return None;
    }

    if let Ok(heartbeat) = fs::read_to_string(base.join("heartbeat.json")) {
        if let Some(timestamp) = extract_number_after(&heartbeat, "timestamp")
            .or_else(|| extract_number_after(&heartbeat, "updated_at_ms"))
        {
            if now_ms().saturating_sub(timestamp) > STALE_HEARTBEAT_MS {
                return Some(Diagnostics {
                    classification: "stale_heartbeat".to_string(),
                    next_action: "run omx team status".to_string(),
                    confidence: 0.78,
                    errors: Vec::new(),
                    warnings: vec!["heartbeat is stale".to_string()],
                });
            }
        }
    }

    if let Ok(status) = fs::read_to_string(base.join("status.json")) {
        let normalized = status.to_ascii_lowercase();
        if normalized.contains("blocked") || normalized.contains("needs_input") {
            return Some(Diagnostics {
                classification: "waiting_for_input".to_string(),
                next_action: "inspect raw pane".to_string(),
                confidence: 0.7,
                errors: Vec::new(),
                warnings: Vec::new(),
            });
        }
        if normalized.contains("busy") || normalized.contains("in_progress") {
            return Some(Diagnostics {
                classification: "busy_processing".to_string(),
                next_action: "wait".to_string(),
                confidence: 0.72,
                errors: Vec::new(),
                warnings: vec!["do not shutdown yet".to_string()],
            });
        }
    }

    None
}

fn extract_number_after(text: &str, key: &str) -> Option<u64> {
    let start = text.find(key)?;
    let digits: String = text[start + key.len()..]
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn write_json_report(
    options: &SparkShellOptions,
    output: &CommandOutput,
    summary: &str,
    evidence: &Evidence,
) -> Result<(), SparkshellError> {
    let mode = match options.target {
        SparkShellTarget::Command(_) => "command",
        SparkShellTarget::TmuxPane { .. } => "tmux-pane",
    };
    let status = if output.status.success() {
        "ok"
    } else {
        "failed"
    };
    let mut diagnostics = classify(options, output);
    if !output.status.success() && diagnostics.errors.is_empty() {
        diagnostics
            .errors
            .push(compact_text(&output.stderr_text(), options.budget));
    }
    let tail_lines = evidence
        .tail_lines
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_string());
    let json = format!(
        concat!(
            "{{\n",
            "  \"ok\": {},\n",
            "  \"mode\": {},\n",
            "  \"status\": {},\n",
            "  \"exit_code\": {},\n",
            "  \"summary\": {},\n",
            "  \"errors\": {},\n",
            "  \"warnings\": {},\n",
            "  \"evidence\": {{\"stdout_lines\":{},\"stderr_lines\":{},\"raw_hash\":{},\"pane_id\":{},\"tail_lines\":{},\"line_range\":{}}},\n",
            "  \"next_action\": {},\n",
            "  \"confidence\": {:.2},\n",
            "  \"classification\": {}\n",
            "}}\n"
        ),
        output.status.success(),
        json_str(mode),
        json_str(status),
        output.exit_code(),
        json_str(&compact_text(summary, options.budget)),
        json_string_array(&diagnostics.errors),
        json_string_array(&diagnostics.warnings),
        evidence.stdout_lines,
        evidence.stderr_lines,
        json_str(&evidence.raw_hash),
        optional_json_string(&evidence.pane_id),
        tail_lines,
        optional_json_string(&evidence.line_range),
        json_str(&diagnostics.next_action),
        diagnostics.confidence,
        json_str(&diagnostics.classification),
    );
    io::stdout().write_all(json.as_bytes())?;
    Ok(())
}

fn parse_tail_lines(raw: &str) -> Result<usize, SparkshellError> {
    let parsed = raw
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|value| (*value >= MIN_TMUX_TAIL_LINES) && (*value <= MAX_TMUX_TAIL_LINES))
        .ok_or_else(|| {
            SparkshellError::InvalidArgs(format!(
                "--tail-lines must be an integer between {MIN_TMUX_TAIL_LINES} and {MAX_TMUX_TAIL_LINES}"
            ))
        })?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{parse_input, SparkShellTarget};

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_direct_command_mode() {
        let parsed = parse_input(&strings(&["git", "status"])).expect("parsed");
        assert_eq!(
            parsed.target,
            SparkShellTarget::Command(strings(&["git", "status"]))
        );
    }

    #[test]
    fn parses_tmux_pane_mode_with_default_tail_lines() {
        let parsed = parse_input(&strings(&["--tmux-pane", "%11"])).expect("parsed");
        assert_eq!(
            parsed.target,
            SparkShellTarget::TmuxPane {
                pane_id: "%11".to_string(),
                tail_lines: 200,
            }
        );
    }

    #[test]
    fn parses_tmux_pane_mode_with_explicit_tail_lines() {
        let parsed =
            parse_input(&strings(&["--tmux-pane=%22", "--tail-lines=400"])).expect("parsed");
        assert_eq!(
            parsed.target,
            SparkShellTarget::TmuxPane {
                pane_id: "%22".to_string(),
                tail_lines: 400,
            }
        );
    }

    #[test]
    fn rejects_tail_lines_without_tmux_pane() {
        let error = parse_input(&strings(&["--tail-lines", "300"])).unwrap_err();
        assert_eq!(error.to_string(), "--tail-lines requires --tmux-pane");
    }

    #[test]
    fn rejects_default_tail_lines_without_tmux_pane_when_explicit() {
        let error = parse_input(&strings(&["--tail-lines", "200"])).unwrap_err();
        assert_eq!(error.to_string(), "--tail-lines requires --tmux-pane");
    }

    #[test]
    fn rejects_tmux_pane_mode_with_positional_command() {
        let error = parse_input(&strings(&["--tmux-pane", "%11", "git", "status"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "tmux pane mode does not accept an additional command"
        );
    }

    #[test]
    fn rejects_out_of_range_tail_lines() {
        let error =
            parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "80"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn rejects_tail_lines_above_maximum() {
        let error =
            parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "1001"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn tmux_pane_flag_rejects_missing_equals_value() {
        let error = parse_input(&strings(&["--tmux-pane="])).unwrap_err();
        assert_eq!(error.to_string(), "--tmux-pane requires a pane id");
    }

    #[test]
    fn tmux_pane_flag_rejects_dash_prefixed_value() {
        let error = parse_input(&strings(&["--tmux-pane", "--tail-lines"])).unwrap_err();
        assert_eq!(error.to_string(), "--tmux-pane requires a pane id");
    }

    #[test]
    fn tail_lines_accepts_boundary_values() {
        let min = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "100"]))
            .expect("min parsed");
        let max = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "1000"]))
            .expect("max parsed");
        assert_eq!(
            min.target,
            SparkShellTarget::TmuxPane {
                pane_id: "%11".to_string(),
                tail_lines: 100
            }
        );
        assert_eq!(
            max.target,
            SparkShellTarget::TmuxPane {
                pane_id: "%11".to_string(),
                tail_lines: 1000
            }
        );
    }

    #[test]
    fn rejects_non_numeric_tail_lines() {
        let error =
            parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "bogus"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn rejects_missing_tail_lines_value() {
        let error = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines"])).unwrap_err();
        assert_eq!(error.to_string(), "--tail-lines requires a numeric value");
    }
}
