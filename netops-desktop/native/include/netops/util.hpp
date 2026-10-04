// Small dependency-free helpers shared by the native modules.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace netops {

std::string trim(std::string_view input);
std::string lower(std::string_view input);
bool starts_with(std::string_view text, std::string_view prefix);
bool ends_with(std::string_view text, std::string_view suffix);
bool contains(std::string_view text, std::string_view needle);
std::vector<std::string> split(std::string_view text, char delimiter);

// FNV-1a: stable across processes, which is what sticky routing needs.
std::uint64_t fnv1a(std::string_view text);

std::string to_hex(std::uint64_t value);

// JSON writing. Values are pre-escaped by the callers; this keeps the native
// side dependency-free while still producing valid output.
class JsonWriter {
public:
    explicit JsonWriter(int indent = 2) : indent_(indent) {}

    JsonWriter& begin_object();
    JsonWriter& end_object();
    JsonWriter& begin_array();
    JsonWriter& end_array();
    JsonWriter& key(std::string_view name);
    JsonWriter& value(std::string_view text);
    JsonWriter& value(const char* text) { return value(std::string_view(text)); }
    JsonWriter& value(std::int64_t number);
    JsonWriter& value(int number) { return value(static_cast<std::int64_t>(number)); }
    JsonWriter& value(double number);
    JsonWriter& value(bool flag);
    JsonWriter& null_value();
    // splice already-rendered JSON (used to nest objects built elsewhere)
    JsonWriter& raw(std::string_view json);

    JsonWriter& field(std::string_view name, std::string_view text);
    JsonWriter& field(std::string_view name, const char* text) {
        return field(name, std::string_view(text));
    }
    JsonWriter& field(std::string_view name, std::int64_t number);
    JsonWriter& field(std::string_view name, int number) {
        return field(name, static_cast<std::int64_t>(number));
    }
    JsonWriter& field(std::string_view name, double number);
    JsonWriter& field(std::string_view name, bool flag);

    std::string str() const { return out_ + "\n"; }

private:
    void separator();
    void newline_indent();

    std::string out_;
    std::vector<bool> first_;
    bool expect_value_ = false;
    int indent_ = 2;
};

std::string escape_json(std::string_view text);

}  // namespace netops
