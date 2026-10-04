#include "test_harness.hpp"

#include <iostream>

int main(int argc, char** argv) {
    auto& cases = netops::test::registry();

    if (argc > 1) {
        const std::string name = argv[1];
        const auto it = cases.find(name);
        if (it == cases.end()) {
            std::cerr << "unknown test case: " << name << "\n";
            return 2;
        }
        try {
            it->second();
            std::cout << "ok " << name << "\n";
            return 0;
        } catch (const std::exception& error) {
            std::cerr << "FAILED " << name << ": " << error.what() << "\n";
            return 1;
        }
    }

    int failed = 0;
    for (const auto& [name, body] : cases) {
        try {
            body();
            std::cout << "ok   " << name << "\n";
        } catch (const std::exception& error) {
            ++failed;
            std::cout << "FAIL " << name << "\n     " << error.what() << "\n";
        }
    }
    std::cout << "\n" << (cases.size() - static_cast<std::size_t>(failed)) << "/" << cases.size()
              << " passed\n";
    return failed == 0 ? 0 : 1;
}
