// Tiny test harness: one executable, cases registered by name.
#pragma once

#include <functional>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace netops::test {

using Case = std::function<void()>;

inline std::map<std::string, Case>& registry() {
    static std::map<std::string, Case> cases;
    return cases;
}

struct Registrar {
    Registrar(const std::string& name, Case body) { registry()[name] = std::move(body); }
};

class Failure : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Printable types get streamed; everything else prints as a placeholder so
// enums and other non-streamable values can still be compared.
template <typename T>
std::string describe(const T& value) {
    if constexpr (requires(std::ostringstream& os, const T& item) { os << item; }) {
        std::ostringstream out;
        out << value;
        return out.str();
    } else {
        return "<value>";
    }
}

template <typename A, typename B>
void expect_eq(const A& actual, const B& expected, const char* expression, int line) {
    if (!(actual == expected)) {
        std::ostringstream message;
        message << "line " << line << ": " << expression << "\n  actual:   " << describe(actual)
                << "\n  expected: " << describe(expected);
        throw Failure(message.str());
    }
}

inline void expect(bool condition, const char* expression, int line) {
    if (!condition) {
        std::ostringstream message;
        message << "line " << line << ": expected " << expression;
        throw Failure(message.str());
    }
}

int run(int argc, char** argv);

}  // namespace netops::test

#define NETOPS_TEST(name)                                                     \
    static void name();                                                       \
    static const ::netops::test::Registrar registrar_##name(#name, name);     \
    static void name()

#define EXPECT_EQ(actual, expected) \
    ::netops::test::expect_eq((actual), (expected), #actual " == " #expected, __LINE__)

#define EXPECT_TRUE(condition) ::netops::test::expect((condition), #condition, __LINE__)
#define EXPECT_FALSE(condition) ::netops::test::expect(!(condition), "!" #condition, __LINE__)

#define EXPECT_CONTAINS(haystack, needle)                                              \
    ::netops::test::expect(std::string(haystack).find(std::string(needle)) !=           \
                               std::string::npos,                                     \
                           #haystack " contains " #needle, __LINE__)

#define EXPECT_THROWS(expression)                                                    \
    do {                                                                              \
        bool threw = false;                                                           \
        try {                                                                         \
            (void)(expression);                                                       \
        } catch (const std::exception&) {                                             \
            threw = true;                                                             \
        }                                                                             \
        ::netops::test::expect(threw, #expression " throws", __LINE__);               \
    } while (false)
