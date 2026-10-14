//! The language the native side speaks: the tray menu and the window menu.
//!
//! The window owns the choice. It reads the saved choice or the system's languages, shows its own
//! switch, and tells this side on start and on every change (`set_ui_locale`), so the menus speak
//! the language the window does. The choice is remembered beside the app's other settings, so the
//! menus are in it from the next start, before the window has said anything.
//!
//! English is the default and the fallback: a file that cannot be read, or a tag this build does
//! not know, leaves the menus exactly as they always were.

use std::path::Path;

const FILE: &str = "ui-locale";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiLocale {
    En,
    El,
}

impl UiLocale {
    pub fn tag(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::El => "el",
        }
    }
}

/// The language a tag names: "el", "el-GR" and "EL_cy" are all Greek.
pub fn parse(tag: &str) -> Option<UiLocale> {
    let primary = tag
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match primary.as_str() {
        "en" => Some(UiLocale::En),
        "el" => Some(UiLocale::El),
        _ => None,
    }
}

/// A menu item's words, by its id. The ids are the ones `chose` routes on.
pub fn menu_text(locale: UiLocale, id: &str) -> &'static str {
    match (locale, id) {
        (UiLocale::El, "open") => "Άνοιγμα του OpenBot",
        (UiLocale::El, "stop") => "Διακοπή του OpenBot",
        (UiLocale::El, "quit") => "Έξοδος",
        (UiLocale::El, "edit") => "Επεξεργασία",
        (_, "open") => "Open OpenBot",
        (_, "stop") => "Stop OpenBot",
        (_, "quit") => "Quit",
        (_, "edit") => "Edit",
        _ => "",
    }
}

/// The language chosen last time, or English.
pub fn saved(config_dir: &Path) -> UiLocale {
    std::fs::read_to_string(config_dir.join(FILE))
        .ok()
        .and_then(|text| parse(&text))
        .unwrap_or(UiLocale::En)
}

pub fn save(config_dir: &Path, locale: UiLocale) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    std::fs::write(config_dir.join(FILE), locale.tag())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_tags_a_window_or_a_system_may_name() {
        assert_eq!(parse("el"), Some(UiLocale::El));
        assert_eq!(parse("el-GR"), Some(UiLocale::El));
        assert_eq!(parse(" EL_cy "), Some(UiLocale::El));
        assert_eq!(parse("en-US"), Some(UiLocale::En));
        assert_eq!(parse("fr"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn english_menus_are_exactly_what_they_were() {
        assert_eq!(menu_text(UiLocale::En, "open"), "Open OpenBot");
        assert_eq!(menu_text(UiLocale::En, "stop"), "Stop OpenBot");
        assert_eq!(menu_text(UiLocale::En, "quit"), "Quit");
        assert_eq!(menu_text(UiLocale::En, "edit"), "Edit");
    }

    #[test]
    fn greek_menus_keep_the_product_name() {
        assert_eq!(menu_text(UiLocale::El, "open"), "Άνοιγμα του OpenBot");
        assert_eq!(menu_text(UiLocale::El, "quit"), "Έξοδος");
    }

    #[test]
    fn the_choice_is_remembered_and_a_missing_file_is_english() {
        let dir = std::env::temp_dir().join(format!(
            "openbot-ui-locale-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        assert_eq!(saved(&dir), UiLocale::En);
        save(&dir, UiLocale::El).unwrap();
        assert_eq!(saved(&dir), UiLocale::El);
        std::fs::write(dir.join(FILE), "klingon").unwrap();
        assert_eq!(saved(&dir), UiLocale::En);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
