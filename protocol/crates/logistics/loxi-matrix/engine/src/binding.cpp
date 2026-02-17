#include <valhalla/tyr/actor.h>
#include <valhalla/baldr/graphreader.h>
#include <valhalla/midgard/logging.h>
#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <iostream>
#include <memory>
#include <string>
#include <vector>
#include <emscripten/bind.h>

using namespace emscripten;

// Global actor and reader instances
// We keep them globally to ensure their lifetime matches the engine's.
valhalla::tyr::actor_t* actor = nullptr;
std::unique_ptr<valhalla::baldr::GraphReader> global_reader = nullptr;

// Forward declaration of the Rust LazyFS bridge (Raw C FFI)
extern "C" int rust_lazy_fs_read(const char* path, uint64_t offset, size_t length, uint8_t* out_ptr);

namespace {
    /**
     * Custom TileGetter that redirects all Valhalla file requests to our Rust-native LazyFS.
     */
    class RustTileGetter : public valhalla::baldr::tile_getter_t {
    public:
        GET_response_t get(const std::string& url, const uint64_t offset = 0, const uint64_t size = 0) override {
            printf("[C++] RustTileGetter::get(url='%s', off=%llu, size=%llu)\n", url.c_str(), offset, size);
            fflush(stdout);
            GET_response_t resp;
            uint64_t target_size = size;

            if (size == 0) {
                printf("[C++] RustTileGetter::get -> Size 0 Request. querying file size...\n");
                // Calling read with length 0 should return the total file size
                int file_size = rust_lazy_fs_read(url.c_str(), 0, 0, nullptr);
                if (file_size <= 0) {
                     printf("[C++] RustTileGetter::get -> Failed to get file size for %s\n", url.c_str());
                     resp.status_ = status_code_t::FAILURE;
                     resp.http_code_ = 404;
                     return resp;
                }
                printf("[C++] RustTileGetter::get -> Auto-detected size: %d bytes\n", file_size);
                target_size = static_cast<uint64_t>(file_size);
            }

            resp.bytes_.resize(target_size);
            int read_bytes = rust_lazy_fs_read(url.c_str(), offset, target_size, (uint8_t*)resp.bytes_.data());
            
            if (read_bytes >= 0) {
                if ((size_t)read_bytes < size) {
                    resp.bytes_.resize(read_bytes);
                }
                printf("[C++] RustTileGetter::get -> Read %d bytes (Success)\n", read_bytes);
                resp.status_ = status_code_t::SUCCESS;
                resp.http_code_ = 200;
            } else {
                printf("[C++] RustTileGetter::get -> Read Failed (404)\n");
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
    /**
     * Initialize Valhalla Engine using Triple-Bridge (Rust LazyFS)
     */
    EMSCRIPTEN_KEEPALIVE
    int init_valhalla(const char* config_path) {
        printf("[C++] init_valhalla start: %s\n", config_path);
        fflush(stdout);
        
        try {
            boost::property_tree::ptree pt;
            boost::property_tree::read_json(config_path, pt);

            // --- FORCE OVERRIDES (The Silver Bullet) ---
            // These ensure the engine always uses our virtual/intercepted paths.
            pt.put("mjolnir.tile_dir", "/valhalla_tiles");
            // pt.put("mjolnir.tile_extract", "/valhalla_tiles/tiles.tar");
            // pt.put("mjolnir.admin", "/valhalla_tiles/admin.sqlite");
            // pt.put("mjolnir.landmarks", "/valhalla_tiles/landmarks.sqlite");
            // FORCE tile_url to ensure GraphReader triggers CacheTileURL
            // Pattern needed to avoid "is_tar_url_" check which tries to download index.bin
            pt.put("mjolnir.tile_url", "http://lazyfs/{tilePath}");
            pt.put("mjolnir.data_processing.scan_tar", "false");
            pt.put("mjolnir.data_processing.use_admin_db", "false");

            // Clean previous state
            if (actor) { delete actor; actor = nullptr; }
            global_reader.reset();

            // Verify config
            std::string tile_dir = pt.get<std::string>("mjolnir.tile_dir", "NOT_SET");
            printf("[C++] Configured mjolnir.tile_dir: '%s'\n", tile_dir.c_str());

            printf("[C++] Initializing GraphReader with Custom RustTileGetter...\n");
            auto getter = std::make_unique<RustTileGetter>();
            // FIXED: GraphReader expects the 'mjolnir' config block, not the root!
            auto mjolnir_pt = pt.get_child("mjolnir");
            global_reader = std::make_unique<valhalla::baldr::GraphReader>(mjolnir_pt, std::move(getter));

            printf("[C++] Constructing Valhalla Actor with Persistent GraphReader...\n");
            actor = new valhalla::tyr::actor_t(pt, *global_reader);
            
            printf("[C++] Valhalla Engine Initialized successfully (Triple-Bridge Flow).\n");
            fflush(stdout);
            return 0;
        } catch (const std::exception& e) {
            printf("[C++] init_valhalla failed: %s\n", e.what());
            fflush(stdout);
            return 1;
        }
    }

    static int last_matrix_len = 0;
    static int last_route_len = 0;

    EMSCRIPTEN_KEEPALIVE
    int get_last_matrix_len() { return last_matrix_len; }

    EMSCRIPTEN_KEEPALIVE
    int get_last_route_len() { return last_route_len; }

    /**
     * Calculate matrix
     */
    EMSCRIPTEN_KEEPALIVE
    const char* valhalla_matrix(const char* request_json) {
        static std::string last_result;
        try {
            if (!actor) {
                 last_matrix_len = 0;
                 return "{\"error\":\"Valhalla not initialized\"}";
            }

            last_result = actor->matrix(request_json);
            last_matrix_len = (int)last_result.length();
            return last_result.c_str();
        } catch (const std::exception& e) {
            last_result = "{\"error\":\"Valhalla Engine Error [";
            last_result += e.what();
            last_result += "]\"}";
            last_matrix_len = (int)last_result.length();
            return last_result.c_str();
        }
    }

    /**
     * Calculate route
     */
    EMSCRIPTEN_KEEPALIVE
    const char* valhalla_route(const char* request_json) {
        static std::string last_result;
        try {
            if (!actor) {
                last_route_len = 0;
                return "{\"error\":\"Valhalla not initialized\"}";
            }
            last_result = actor->route(request_json);
            last_route_len = (int)last_result.length();
            return last_result.c_str();
        } catch (const std::exception& e) {
            last_result = "{\"error\":\"Valhalla Route Error [";
            last_result += e.what();
            last_result += "]\"}";
            last_route_len = (int)last_result.length();
            return last_result.c_str();
        }
    }
}
