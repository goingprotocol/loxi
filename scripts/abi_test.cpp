#include <emscripten.h>

extern "C" {
    EMSCRIPTEN_KEEPALIVE
    void test_ptr(int* p) {
        *p = 123;
    }
}
