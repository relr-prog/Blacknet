// Theme compiler: turns a theme description into the CSS injected into pages.
//
// Themes restyle the page itself, which is why the browser chrome can look
// completely different from the engine underneath it.
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace netops::browser {

struct ThemePalette {
    std::string bg;
    std::string fg;
    std::string accent;
    std::string muted;
    std::string link;
};

enum class ThemeMode { Dark, Light, Auto };

struct Theme {
    std::string name = "midnight";
    ThemeMode mode = ThemeMode::Dark;
    std::map<std::string, std::string> colors;
    std::string font_family;
    std::optional<std::int64_t> font_size;
    std::optional<double> line_height;
    std::optional<std::int64_t> max_width;
    bool hide_images = false;
    bool hide_ads = false;
    bool dim_videos = false;
    bool reader_mode = false;
    bool force_dark = true;

    std::string to_css() const;
    std::string to_json() const;
    std::optional<Theme> merge(const Theme& patch) const;

    std::optional<std::string> validate() const;  // error message, or nullopt when valid
};

const std::map<std::string, ThemePalette>& theme_presets();
std::optional<ThemeMode> parse_mode(std::string_view text);
const char* mode_name(ThemeMode mode);

}  // namespace netops::browser
