/// Lightweight i18n for nano-zyrkel messages.
/// nano-zyrkels run on GitHub Actions — no access to Zyrkel's full i18n system.
/// This is a standalone, minimal translation layer.

use std::collections::HashMap;
use std::sync::LazyLock;

type Messages = HashMap<&'static str, &'static str>;

static DE: LazyLock<Messages> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("hat_starting", "nano-zyrkel '{}' wird gestartet");
    m.insert("fetch_failed", "Abruf fehlgeschlagen: {}");
    m.insert("match_found", "nano-zyrkel '{}' — Treffer! {}");
    m.insert("no_match", "nano-zyrkel '{}' — kein Treffer");
    m.insert("notify_telegram", "Telegram-Benachrichtigung gesendet");
    m.insert("notify_email", "Email-Benachrichtigung gesendet");
    m.insert("notify_failed", "Benachrichtigung fehlgeschlagen: {}");
    m.insert("ttl_expired", "nano-zyrkel '{}' — Laufzeit abgelaufen (TTL)");
    m.insert("error_retry", "Fehler bei Versuch {}/{}: {}");
    m.insert("error_giving_up", "Alle {} Versuche fehlgeschlagen");
    m.insert("condition_contains", "Textsuche: '{}'");
    m.insert("condition_regex", "Regex: '{}'");
    m.insert("condition_css", "CSS-Selector: '{}'");
    m.insert("condition_json", "JSON-Path: '{}'");
    m.insert("condition_llm", "LLM-Frage: '{}'");
    m.insert("condition_rss", "Neuer RSS-Eintrag");
    m.insert("condition_changed", "Inhalt hat sich geaendert");
    m.insert("condition_value", "Wert extrahiert: {}");
    m.insert("condition_deadline", "Noch {} Tage bis {}");
    m.insert("state_saved", "Zustand gespeichert");
    m.insert("output_written", "Ergebnis geschrieben nach {}");
    m.insert("action_executed", "Aktion ausgefuehrt: {}");
    m.insert("action_denied", "Aktion fuer nano-zyrkel '{}' abgelehnt");
    m.insert("action_approval", "Genehmigung angefragt fuer nano-zyrkel '{}'");
    m
});

static EN: LazyLock<Messages> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("hat_starting", "nano-zyrkel '{}' starting");
    m.insert("fetch_failed", "Fetch failed: {}");
    m.insert("match_found", "nano-zyrkel '{}' — match found! {}");
    m.insert("no_match", "nano-zyrkel '{}' — no match");
    m.insert("notify_telegram", "Telegram notification sent");
    m.insert("notify_email", "Email notification sent");
    m.insert("notify_failed", "Notification failed: {}");
    m.insert("ttl_expired", "nano-zyrkel '{}' — TTL expired");
    m.insert("error_retry", "Error on attempt {}/{}: {}");
    m.insert("error_giving_up", "All {} attempts failed");
    m.insert("condition_contains", "Text search: '{}'");
    m.insert("condition_regex", "Regex: '{}'");
    m.insert("condition_css", "CSS selector: '{}'");
    m.insert("condition_json", "JSON path: '{}'");
    m.insert("condition_llm", "LLM question: '{}'");
    m.insert("condition_rss", "New RSS entry");
    m.insert("condition_changed", "Content changed");
    m.insert("condition_value", "Value extracted: {}");
    m.insert("condition_deadline", "{} days until {}");
    m.insert("state_saved", "State saved");
    m.insert("output_written", "Result written to {}");
    m.insert("action_executed", "Action executed: {}");
    m.insert("action_denied", "Action denied for nano-zyrkel '{}'");
    m.insert("action_approval", "Approval requested for nano-zyrkel '{}'");
    m
});

/// Get a translated message with placeholder substitution.
/// Placeholders are replaced positionally: first `{}` gets `args[0]`, etc.
pub fn msg(lang: &str, key: &str, args: &[&str]) -> String {
    let messages = match lang {
        "en" => &*EN,
        _ => &*DE,
    };

    let template = messages.get(key).unwrap_or(&key);
    let mut result = template.to_string();
    for arg in args {
        if let Some(pos) = result.find("{}") {
            result.replace_range(pos..pos + 2, arg);
        }
    }
    result
}
