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
    route?: string[];
    vehicle?: {
        start_location: Location;
        end_location: Location;
    };
}

const LeafletMap: React.FC<LeafletMapProps> = ({ stops, route, vehicle }) => {
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
            setTimeout(() => {
                mapInstance.current?.invalidateSize();
            }, 200);
        }

        return () => {
            if (mapInstance.current) {
                mapInstance.current.remove();
                mapInstance.current = null;
            }
        };
    }, []);

    // 2. UPDATE MARKERS & ROUTES
    useEffect(() => {
        if (!mapInstance.current || !markersLayer.current || !polylineLayer.current) return;

        // Clear previous
        markersLayer.current.clearLayers();
        polylineLayer.current.clearLayers();

        if (stops.length === 0) return;

        // Validate stops have location data
        const validStops = stops.filter(s => s?.location?.lat != null && s?.location?.lon != null);
        if (validStops.length === 0) return;

        const bounds = L.latLngBounds([]);
        const stopMap = new Map(stops.map(s => [s.id, s]));

        // Add Markers (Circle style like Google Maps version)
        stops.forEach((stop) => {
            const marker = L.circleMarker([stop.location.lat, stop.location.lon], {
                radius: 6,
                fillColor: '#3b82f6',
                color: '#ffffff',
                weight: 1,
                opacity: 1,
                fillOpacity: 1
            }).bindTooltip(stop.id, { permanent: false, direction: 'top' });

            markersLayer.current?.addLayer(marker);
            bounds.extend([stop.location.lat, stop.location.lon]);
        });

        // Add Vehicle Depot Markers (Differentiating Start/End)
        if (vehicle) {
            const startMarker = L.circleMarker([vehicle.start_location.lat, vehicle.start_location.lon], {
                radius: 10,
                fillColor: '#10b981', // Emerald Green for Start
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 1
            }).bindTooltip("DEPOT (START)", { permanent: true, direction: 'bottom' });

            const endMarker = L.circleMarker([vehicle.end_location.lat, vehicle.end_location.lon], {
                radius: 10,
                fillColor: '#ef4444', // Red for End
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 1
            }).bindTooltip("DEPOT (END)", { permanent: true, direction: 'top' });

            markersLayer.current?.addLayer(startMarker);
            markersLayer.current?.addLayer(endMarker);
            bounds.extend([vehicle.start_location.lat, vehicle.start_location.lon]);
            bounds.extend([vehicle.end_location.lat, vehicle.end_location.lon]);
        }

        // Add Polyline
        if (route && route.length > 1) {
            const pathCoords: L.LatLngExpression[] = route
                .map(id => stopMap.get(id))
                .filter(s => !!s)
                .map(s => [s!.location.lat, s!.location.lon] as L.LatLngExpression);

            if (pathCoords.length > 1) {
                const polyline = L.polyline(pathCoords, {
                    color: '#8b5cf6',
                    weight: 4,
                    opacity: 0.8,
                    lineJoin: 'round'
                });
                polylineLayer.current.addLayer(polyline);
            }
        }

        // Auto-center with padding
        if (bounds.isValid()) {
            mapInstance.current.fitBounds(bounds, {
                padding: [50, 50]
            });
        }

    }, [stops, route]);

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
