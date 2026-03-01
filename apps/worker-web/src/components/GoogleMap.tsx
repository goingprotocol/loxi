import React, { useEffect, useRef, useState } from 'react';

interface Location {
    lat: number;
    lon: number;
}

interface Stop {
    id: string;
    location: Location;
}

interface GoogleMapProps {
    stops: Stop[];
    route?: string[];
}

const GoogleMap: React.FC<GoogleMapProps> = ({ stops, route }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const [google, setGoogle] = useState<any>(null);
    const mapInstance = useRef<any>(null);
    const markers = useRef<any[]>([]);
    const polyline = useRef<any>(null);

    // 1. INJECT GOOGLE MAPS SCRIPT
    useEffect(() => {
        if ((window as any).google) {
            setGoogle((window as any).google);
            return;
        }

        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?v=weekly`; // No Key provided by user, will show watermarks but it WORKS
        script.async = true;
        script.defer = true;
        script.onload = () => setGoogle((window as any).google);
        document.head.appendChild(script);

        return () => {
            // Cleanup: Optional, script usually stays
        };
    }, []);

    // 2. INITIALIZE MAP
    useEffect(() => {
        if (google && mapRef.current && !mapInstance.current) {
            mapInstance.current = new google.maps.Map(mapRef.current, {
                center: { lat: -34.6037, lng: -58.3816 },
                zoom: 12,
                styles: industrialStyles, // Clean dark theme
                disableDefaultUI: true,
                zoomControl: true,
            });
        }
    }, [google]);

    // 3. UPDATE MARKERS & ROUTES
    useEffect(() => {
        if (!mapInstance.current || !google) return;

        // Clear previous
        markers.current.forEach(m => m.setMap(null));
        markers.current = [];
        if (polyline.current) polyline.current.setMap(null);

        if (stops.length === 0) return;

        // Validate stops have location data
        const validStops = stops.filter(s => s?.location?.lat != null && s?.location?.lon != null);
        if (validStops.length === 0) return;

        const bounds = new google.maps.LatLngBounds();
        const stopMap = new Map(stops.map(s => [s.id, s]));

        // Add Markers
        stops.forEach((stop, i) => {
            const isStart = i === 0;
            const isEnd = route && route.length > 0 && stop.id === route[route.length - 1];

            const marker = new google.maps.Marker({
                position: { lat: stop.location.lat, lng: stop.location.lon },
                map: mapInstance.current,
                title: stop.id,
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    fillColor: isStart ? '#10b981' : (isEnd ? '#ef4444' : '#3b82f6'),
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 1,
                    scale: isStart || isEnd ? 8 : 6,
                }
            });
            markers.current.push(marker);
            bounds.extend(marker.getPosition());
        });

        // Add Polyline
        if (route && route.length > 1) {
            const pathCoords = route
                .map(id => stopMap.get(id))
                .filter(s => !!s)
                .map(s => ({ lat: s!.location.lat, lng: s!.location.lon }));

            polyline.current = new google.maps.Polyline({
                path: pathCoords,
                geodesic: true,
                strokeColor: '#8b5cf6',
                strokeOpacity: 0.8,
                strokeWeight: 4,
            });
            polyline.current.setMap(mapInstance.current);
        }

        // Auto-center
        mapInstance.current.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });

    }, [stops, route, google]);

    return (
        <div
            ref={mapRef}
            style={{
                height: '100%',
                width: '100%',
                background: '#020617',
            }}
        />
    );
};

// INDUSTRIAL DARK THEME
const industrialStyles = [
    { "elementType": "geometry", "stylers": [{ "color": "#1d2c4d" }] },
    { "elementType": "labels.text.fill", "stylers": [{ "color": "#8ec3b9" }] },
    { "elementType": "labels.text.stroke", "stylers": [{ "color": "#1a3646" }] },
    { "featureType": "administrative.country", "elementType": "geometry.stroke", "stylers": [{ "color": "#4b6878" }] },
    { "featureType": "road", "elementType": "geometry", "stylers": [{ "color": "#304a7d" }] },
    { "featureType": "water", "elementType": "geometry", "stylers": [{ "color": "#0e1626" }] }
];

export default GoogleMap;
