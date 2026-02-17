import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface Location {
    lat: number;
    lon: number;
}

interface Stop {
    id: string;
    location: Location;
}

interface LeafletMapProps {
    stops: Stop[];
    routes?: string[][]; // Support multiple routes (one per partition)
    vehicle?: {
        start_location: Location;
        end_location?: Location;
    };
    shapes?: string[]; // Encoded polylines from Valhalla
    stopAssignments?: Record<string, string>; // { stop_id: color }
}

const COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4'];

const fromE6 = (val: number) => (Math.abs(val) > 180 ? val / 1000000 : val);

const LeafletMap: React.FC<LeafletMapProps> = ({ stops, routes, vehicle, shapes, stopAssignments }) => {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapInstance = useRef<L.Map | null>(null);
    const markersLayer = useRef<L.LayerGroup | null>(null);
    const polylineLayer = useRef<L.LayerGroup | null>(null);

    // 1. INITIALIZE MAP
    useEffect(() => {
        if (mapContainerRef.current && !mapInstance.current) {
            mapInstance.current = L.map(mapContainerRef.current, {
                center: [-34.6037, -58.3816],
                zoom: 12,
                zoomControl: false,
                attributionControl: false
            });

            // Add Dark Theme Tiles (CartoDB Dark Matter)
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                subdomains: 'abcd',
                maxZoom: 20,
                // @ts-ignore - Leaflet supports crossOrigin
                crossOrigin: true
            }).addTo(mapInstance.current);

            // Layers for dynamic items
            markersLayer.current = L.layerGroup().addTo(mapInstance.current);
            polylineLayer.current = L.layerGroup().addTo(mapInstance.current);

            // Add zoom control at bottom right
            L.control.zoom({ position: 'bottomright' }).addTo(mapInstance.current);

            // FORZAR ACTUALIZACIÓN DE TAMAÑO (Solución al mapa gris)
            const resizeObserver = new ResizeObserver(() => {
                mapInstance.current?.invalidateSize();
            });
            if (mapContainerRef.current) {
                resizeObserver.observe(mapContainerRef.current);
            }

            // Also a quick timeout just in case
            setTimeout(() => {
                mapInstance.current?.invalidateSize();
            }, 200);

            // Cleanup observer on unmount
            return () => {
                resizeObserver.disconnect();
                if (mapInstance.current) {
                    mapInstance.current.remove();
                    mapInstance.current = null;
                }
            };
        }
    }, []);

    // Helper: Decode Google Polyline (Precision 6)
    const decodePolyline = (str: string, precision: number) => {
        var index = 0,
            lat = 0,
            lng = 0,
            coordinates = [],
            shift = 0,
            result = 0,
            byte = null,
            latitude_change,
            longitude_change,
            factor = Math.pow(10, precision || 6);

        while (index < str.length) {
            byte = null; shift = 0; result = 0;
            do {
                byte = str.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
            shift = result = 0;
            do {
                byte = str.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += latitude_change;
            lng += longitude_change;
            coordinates.push([lat / factor, lng / factor]);
        }
        return coordinates;
    };

    // 2. UPDATE MARKERS & ROUTES
    useEffect(() => {
        if (!mapInstance.current || !markersLayer.current || !polylineLayer.current) return;

        // Clear previous
        markersLayer.current.clearLayers();
        polylineLayer.current.clearLayers();

        const bounds = L.latLngBounds([]);

        // A. Render Street-Level Polylines (Valhalla Shapes)
        if (shapes && shapes.length > 0) {
            console.log(`🗺️ [LeafletMap] Rendering ${shapes.length} street-level shapes...`);
            shapes.forEach((shapeStr, idx) => {
                const decoded = decodePolyline(shapeStr, 6);
                if (decoded.length > 0) {
                    const polyline = L.polyline(decoded as L.LatLngExpression[], {
                        color: COLORS[idx % COLORS.length],
                        weight: 6,
                        opacity: 0.9,
                        lineJoin: 'round'
                    });
                    polylineLayer.current?.addLayer(polyline);
                    decoded.forEach(pt => bounds.extend(pt as L.LatLngExpression));
                } else {
                    console.warn(`🗺️ [LeafletMap] Failed to decode shape ${idx} (Length: ${shapeStr.length})`);
                }
            });
        }

        if (stops && stops.length > 0) {
            const stopMap = new Map(stops.map(s => [s.id, s]));

            // Add Markers (Circle style like Google Maps version)
            stops.forEach((stop) => {
                if (!stop.location) return;
                const assignmentColor = stopAssignments?.[stop.id];
                const lat = fromE6(stop.location.lat);
                const lon = fromE6(stop.location.lon);

                const marker = L.circleMarker([lat, lon], {
                    radius: 7,
                    fillColor: assignmentColor || '#3b82f6',
                    color: assignmentColor ? '#ffffff' : '#ffffff',
                    weight: assignmentColor ? 2 : 1,
                    opacity: 1,
                    fillOpacity: 1,
                    className: assignmentColor ? 'worker-pulse' : ''
                }).bindTooltip(stop.id, { permanent: false, direction: 'top' });

                markersLayer.current?.addLayer(marker);
                bounds.extend([lat, lon]);
            });

            // Add Polylines (VRP Route IDs) - ONLY IF SHAPES ARE NOT PRESENT
            if (routes && routes.length > 0 && (!shapes || shapes.length === 0)) {
                routes.forEach((route, index) => {
                    if (route.length < 2) return;

                    const pathCoords: L.LatLngExpression[] = route
                        .map(id => stopMap.get(id))
                        .filter(s => !!s && s.location)
                        .map(s => [fromE6(s!.location.lat), fromE6(s!.location.lon)] as L.LatLngExpression);

                    if (pathCoords.length > 1) {
                        const polyline = L.polyline(pathCoords, {
                            color: COLORS[index % COLORS.length],
                            weight: 4,
                            opacity: 0.8,
                            lineJoin: 'round'
                        });
                        polylineLayer.current?.addLayer(polyline);
                    }
                });
            } else if (routes && routes.length > 0) {
                console.log("🗺️ [LeafletMap] Skipping VRP straight lines because shapes are present.");
            }
        }

        // Add Vehicle Depot Markers (Differentiating Start/End)
        if (vehicle) {
            const startLat = fromE6(vehicle.start_location.lat);
            const startLon = fromE6(vehicle.start_location.lon);

            const startMarker = L.circleMarker([startLat, startLon], {
                radius: 10,
                fillColor: '#10b981', // Emerald Green for Start
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 1
            }).bindTooltip("DEPOT (START)", { permanent: true, direction: 'bottom' });

            markersLayer.current?.addLayer(startMarker);
            bounds.extend([startLat, startLon]);

            if (vehicle.end_location) {
                const endLat = fromE6(vehicle.end_location.lat);
                const endLon = fromE6(vehicle.end_location.lon);

                const endMarker = L.circleMarker([endLat, endLon], {
                    radius: 10,
                    fillColor: '#ef4444', // Red for End
                    color: '#ffffff',
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 1
                }).bindTooltip("DEPOT (END)", { permanent: true, direction: 'top' });

                markersLayer.current?.addLayer(endMarker);
                bounds.extend([endLat, endLon]);
            }
        }

        // Auto-center with padding
        if (bounds.isValid()) {
            mapInstance.current.fitBounds(bounds, {
                padding: [50, 50]
            });
        }

    }, [stops, routes, vehicle, shapes, stopAssignments]);

    return (
        <div
            ref={mapContainerRef}
            style={{
                height: '100%',
                width: '100%',
                background: '#020617',
                zIndex: 1
            }}
        />
    );
};

export default LeafletMap;
