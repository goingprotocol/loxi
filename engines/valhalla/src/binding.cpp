#ifdef EMSCRIPTEN
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif
#include <string>
#include <cstdio>
#include <exception>
#include <sstream>
#include <iostream>

// Valhalla includes
#include <boost/property_tree/ptree.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <valhalla/tyr/actor.h>
#include <valhalla/baldr/graphreader.h>

// Global actor instance
valhalla::tyr::actor_t* actor = nullptr;
std::unique_ptr<valhalla::baldr::GraphReader> global_reader = nullptr;

// Forward declaration of the Rust LazyFS bridge
extern "C" int rust_lazy_fs_read(const char* path, uint64_t offset, size_t length, uint8_t* out_ptr);

namespace {
    /**
     * Custom TileGetter that redirects all Valhalla file requests to our Rust-native LazyFS.
     */
    class RustTileGetter : public valhalla::baldr::tile_getter_t {
    public:
        GET_response_t get(const std::string& url, const uint64_t offset = 0, const uint64_t size = 0) override {
            GET_response_t resp;
            if (size == 0) {
                resp.status_ = status_code_t::SUCCESS;
                resp.http_code_ = 200;
                return resp;
            }

            resp.bytes_.resize(size);
            int read = rust_lazy_fs_read(url.c_str(), offset, size, (uint8_t*)resp.bytes_.data());
            
            if (read >= 0) {
                // Resize to actual bytes read if needed
                if ((size_t)read < size) {
                    resp.bytes_.resize(read);
                }
                resp.status_ = status_code_t::SUCCESS;
                resp.http_code_ = 200;
            } else {
                resp.status_ = status_code_t::FAILURE;
                resp.http_code_ = 404;
            }
            return resp;
        }

        HEAD_response_t head(const std::string& url, header_mask_t header_mask) override {
            HEAD_response_t resp;
            resp.status_ = status_code_t::SUCCESS;
            resp.http_code_ = 200;
            return resp;
        }
    };
}

extern "C" {

    // Initialize the engine with the config file path (e.g. "/valhalla.json")
    EMSCRIPTEN_KEEPALIVE
    int init_valhalla(const char* config_path) {
        printf("[C++] init_valhalla start\n");
        if (!config_path) return -1;
        printf("[C++] config_path: %s\n", config_path);
        return 0;
    }

    // Main entry point: Process a matrix request
    EMSCRIPTEN_KEEPALIVE
    const char* valhalla_matrix(const char* request_json) {
        printf("[C++] valhalla_matrix received: %s\n", request_json);
        fflush(stdout);

        if (!actor) {
            return "{\"error\": \"Valhalla not initialized\"}";
        }

        try {
            std::string req_str(request_json);
            std::string resp = actor->matrix(req_str);
            
            char* result = (char*)malloc(resp.length() + 1);
            strcpy(result, resp.c_str());
            return result;

        } catch (const std::exception& e) {
            std::string err = "{\"error\": \"" + std::string(e.what()) + "\"}";
            char* result = (char*)malloc(err.length() + 1);
            strcpy(result, err.c_str());
            return result;
        }
    }
}
