#include "netops/browser/cache_index.hpp"

#include <algorithm>

#include "netops/util.hpp"

namespace netops::browser {
namespace fs = std::filesystem;

const std::vector<std::string>& CacheIndex::cache_directories() {
    static const std::vector<std::string> dirs = {
        "Cache",
        "Code Cache",
        "GPUCache",
        "DawnCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "GrShaderCache",
        "ShaderCache",
        "GraphiteDawnCache",
        "Default/Cache",
        "Default/Code Cache",
        "Default/GPUCache",
        "Default/DawnCache",
        "Default/Service Worker/CacheStorage",
        "Default/Service Worker/ScriptCache",
        "Default/DawnGraphiteCache",
        "Default/DawnWebGPUCache",
    };
    return dirs;
}

std::uint64_t directory_size(const fs::path& path, std::size_t* files) {
    std::uint64_t total = 0;
    std::error_code ec;
    if (!fs::exists(path, ec)) return 0;
    for (fs::recursive_directory_iterator it(path, fs::directory_options::skip_permission_denied, ec),
         end;
         it != end; it.increment(ec)) {
        if (ec) {
            ec.clear();
            continue;
        }
        std::error_code size_ec;
        if (!it->is_regular_file(size_ec)) continue;
        const auto size = it->file_size(size_ec);
        if (size_ec) continue;
        total += size;
        if (files) ++*files;
    }
    return total;
}

CacheIndex::CacheIndex(fs::path profile_dir) : root_(std::move(profile_dir)) {}

CacheReport CacheIndex::scan() const {
    CacheReport report;
    report.profile = root_.string();
    report.total_bytes = directory_size(root_, &report.files);

    std::vector<CacheFile> cache_files;
    for (const std::string& dir : cache_directories()) {
        const fs::path target = root_ / dir;
        std::error_code ec;
        if (!fs::exists(target, ec)) continue;
        for (fs::recursive_directory_iterator it(target, fs::directory_options::skip_permission_denied, ec),
             end;
             it != end; it.increment(ec)) {
            if (ec) {
                ec.clear();
                continue;
            }
            std::error_code size_ec;
            if (!it->is_regular_file(size_ec)) continue;
            const auto size = it->file_size(size_ec);
            if (size_ec) continue;
            report.cache_bytes += size;
            cache_files.push_back({fs::relative(it->path(), root_).string(), size});
        }
    }

    std::sort(cache_files.begin(), cache_files.end(),
              [](const CacheFile& a, const CacheFile& b) { return a.bytes > b.bytes; });
    if (cache_files.size() > 10) cache_files.resize(10);
    report.largest_cache_files = std::move(cache_files);
    return report;
}

ClearResult CacheIndex::clear() const {
    ClearResult result;
    result.total_before = scan().total_bytes;

    for (const std::string& dir : cache_directories()) {
        const fs::path target = root_ / dir;
        std::error_code ec;
        if (!fs::exists(target, ec)) continue;
        for (fs::recursive_directory_iterator it(target, fs::directory_options::skip_permission_denied, ec),
             end;
             it != end; it.increment(ec)) {
            if (ec) {
                ec.clear();
                continue;
            }
            std::error_code size_ec;
            if (!it->is_regular_file(size_ec)) continue;
            const auto size = it->file_size(size_ec);
            std::error_code remove_ec;
            if (fs::remove(it->path(), remove_ec)) {
                ++result.files_removed;
                result.bytes_freed += size;
            } else if (remove_ec) {
                result.errors.push_back(it->path().string() + ": " + remove_ec.message());
            }
        }
    }
    return result;
}

std::string CacheReport::to_json() const {
    JsonWriter json;
    json.begin_object();
    json.field("profile", profile);
    json.field("total_bytes", static_cast<std::int64_t>(total_bytes));
    json.field("files", static_cast<std::int64_t>(files));
    json.field("cache_bytes", static_cast<std::int64_t>(cache_bytes));
    json.field("cache_enabled", cache_enabled);
    json.key("largest_cache_files").begin_array();
    for (const CacheFile& file : largest_cache_files) {
        json.begin_object();
        json.field("path", file.path);
        json.field("bytes", static_cast<std::int64_t>(file.bytes));
        json.end_object();
    }
    json.end_array();
    json.end_object();
    return json.str();
}

std::string ClearResult::to_json() const {
    JsonWriter json;
    json.begin_object();
    json.field("ok", errors.empty());
    json.field("files_removed", static_cast<std::int64_t>(files_removed));
    json.field("bytes_freed", static_cast<std::int64_t>(bytes_freed));
    json.field("total_before", static_cast<std::int64_t>(total_before));
    json.key("errors").begin_array();
    for (const std::string& error : errors) json.value(error);
    json.end_array();
    json.end_object();
    return json.str();
}

}  // namespace netops::browser
