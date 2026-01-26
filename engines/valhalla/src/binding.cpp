#include <emscripten/emscripten.h>
#include <string>
#include <cstdio>
#include <exception>

// Valhalla includes
#include <boost/property_tree/ptree.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <valhalla/tyr/actor.h>
#include <valhalla/baldr/graphreader.h>

// Global actor instance
valhalla::tyr::actor_t* actor = nullptr;

extern "C" {

    // Initialize the engine with the config file path (e.g. "/valhalla.json")
    EMSCRIPTEN_KEEPALIVE
    int init_valhalla(const char* config_path) {
        printf("[C++] init_valhalla called with path: %s\n", config_path);
        
        try {
            boost::property_tree::ptree conf;
            
            // 1. Cargar lo que viene de JS
            boost::property_tree::read_json(config_path, conf);
            
            // 2. FORZAR inyección de dependencias (Skadi/Trace/Elevation)
            // Usamos 'put' que sobreescribe o crea si no existe.
            
            // Elevation path (Crítico si usas use_hills)
            conf.put("additional_data.elevation", "/valhalla_tiles/elevation/");

            // Skadi limits (Crítico para que el Actor arranque)
            conf.put("service_limits.skadi.max_shape", "1000000");
            conf.put("service_limits.skadi.min_resample", "10.0");
            conf.put("service_limits.skadi.use_grade", "true");

            // Trace limits (Crítico también)
            conf.put("service_limits.trace.max_shape", "1000000");
            conf.put("service_limits.trace.max_gps_accuracy", "100.0");
            conf.put("service_limits.trace.max_search_radius", "100.0");
            conf.put("service_limits.trace.max_heading_distance", "60.0");

            // Isochrone limits (Fix for 'No such node' error)
            // Valhalla requires max_time_contour if actions include isochrone
            conf.put("service_limits.isochrone.max_contours", "4");
            conf.put("service_limits.isochrone.max_time", "120");
            conf.put("service_limits.isochrone.max_time_contour", "120"); // Critical missing key
            conf.put("service_limits.isochrone.max_distance", "25000");
            conf.put("service_limits.isochrone.max_locations", "1");
            conf.put("service_limits.isochrone.max_distance_contour", "25000"); // Safety add

            // Costing override
            conf.put("costing_options.auto.use_hills", "0.5");
            conf.put("costing_options.truck.use_hills", "0.1");

            // 3. Inicializar Actor
            printf("[C++] Constructing Valhalla Actor...\n");
            actor = new valhalla::tyr::actor_t(conf);
            
            printf("[C++] Actor constructed successfully. Engine is Ready.\n");
            return 0; // Éxito
        } catch (const std::exception& e) {
            printf("[C++] Valhalla Init Error (std::exception): %s\n", e.what());
            return 1; 
        } catch (...) {
            printf("[C++] Valhalla Init Error: Unknown exception caught!\n");
            return 2; 
        }
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
