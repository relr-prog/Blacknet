#include "netops/util.hpp"

#include <cmath>
#include <cstdio>
#include <sstream>

namespace netops {

std::string trim(std::string_view input) {
    const auto is_space = [](char c) {
        return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v';
    };
    std::size_t start = 0;
    std::size_t end = input.size();
    while (start < end && is_space(input[start])) ++start;
    while (end > start && is_space(input[end - 1])) --end;
    return std::string(input.substr(start, end - start));
}

std::string lower(std::string_view input) {
    std::string out(input);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

bool starts_with(std::string_view text, std::string_view prefix) {
    return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

bool ends_with(std::string_view text, std::string_view suffix) {
    return text.size() >= suffix.size() &&
           text.compare(text.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool contains(std::string_view text, std::string_view needle) {
    return text.find(needle) != std::string_view::npos;
}

std::vector<std::string> split(std::string_view text, char delimiter) {
    std::vector<std::string> parts;
    std::size_t start = 0;
    while (true) {
        const std::size_t pos = text.find(delimiter, start);
        if (pos == std::string_view::npos) {
            parts.emplace_back(text.substr(start));
            break;
        }
        parts.emplace_back(text.substr(start, pos - start));
        start = pos + 1;
    }
    return parts;
}

std::uint64_t fnv1a(std::string_view text) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (const unsigned char c : text) {
        hash ^= c;
        hash *= 1099511628211ULL;
    }
    return hash;
}

std::string to_hex(std::uint64_t value) {
    static const char* digits = "0123456789abcdef";
    if (value == 0) return "0";
    std::string out;
    while (value) {
        out.insert(out.begin(), digits[value & 0xF]);
        value >>= 4;
    }
    return out;
}

std::string escape_json(std::string_view text) {
    std::string out;
    out.reserve(text.size() + 8);
    for (const char c : text) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buffer[7];
                    std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
                    out += buffer;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

void JsonWriter::separator() {
    if (expect_value_) {
        expect_value_ = false;
        return;
    }
    if (first_.empty()) return;
    if (first_.back()) {
        first_.back() = false;
    } else {
        out_ += ",";
    }
    newline_indent();
}

void JsonWriter::newline_indent() {
    if (indent_ <= 0) return;
    out_ += "\n";
    out_.append(static_cast<std::size_t>(indent_ * first_.size()), ' ');
}

JsonWriter& JsonWriter::begin_object() {
    separator();
    out_ += "{";
    first_.push_back(true);
    return *this;
}

JsonWriter& JsonWriter::end_object() {
    const bool empty = first_.empty() || first_.back();
    if (!first_.empty()) first_.pop_back();
    if (!empty) newline_indent();
    out_ += "}";
    return *this;
}

JsonWriter& JsonWriter::begin_array() {
    separator();
    out_ += "[";
    first_.push_back(true);
    return *this;
}

JsonWriter& JsonWriter::end_array() {
    const bool empty = first_.empty() || first_.back();
    if (!first_.empty()) first_.pop_back();
    if (!empty) newline_indent();
    out_ += "]";
    return *this;
}

JsonWriter& JsonWriter::key(std::string_view name) {
    separator();
    out_ += "\"";
    out_ += escape_json(name);
    out_ += "\": ";
    expect_value_ = true;
    return *this;
}

JsonWriter& JsonWriter::value(std::string_view text) {
    separator();
    out_ += "\"";
    out_ += escape_json(text);
    out_ += "\"";
    return *this;
}

JsonWriter& JsonWriter::value(std::int64_t number) {
    separator();
    out_ += std::to_string(number);
    return *this;
}

JsonWriter& JsonWriter::value(double number) {
    separator();
    if (std::isfinite(number)) {
        char buffer[40];
        std::snprintf(buffer, sizeof(buffer), "%.6g", number);
        out_ += buffer;
    } else {
        out_ += "null";
    }
    return *this;
}

JsonWriter& JsonWriter::value(bool flag) {
    separator();
    out_ += flag ? "true" : "false";
    return *this;
}

JsonWriter& JsonWriter::null_value() {
    separator();
    out_ += "null";
    return *this;
}

JsonWriter& JsonWriter::raw(std::string_view json) {
    separator();
    out_ += json;
    return *this;
}

JsonWriter& JsonWriter::field(std::string_view name, std::string_view text) {
    return key(name).value(text);
}

JsonWriter& JsonWriter::field(std::string_view name, std::int64_t number) {
    return key(name).value(number);
}

JsonWriter& JsonWriter::field(std::string_view name, double number) {
    return key(name).value(number);
}

JsonWriter& JsonWriter::field(std::string_view name, bool flag) {
    return key(name).value(flag);
}

}  // namespace netops
