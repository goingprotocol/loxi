const fs = require('fs');

function generateStops(count) {
    const stops = [];
    // Buenos Aires approximate center
    const centerLat = -34.6037;
    const centerLon = -58.3816;

    for (let i = 0; i < count; i++) {
        // Random spread roughly within CABA
        const lat = centerLat + (Math.random() - 0.5) * 0.1;
        const lon = centerLon + (Math.random() - 0.5) * 0.1;

        stops.push({
            "id": `stop_${i}`,
            "location": { "lat": lat, "lon": lon },
            "time_window": {
                "start": 28800, // 8 AM
                "end": 64800    // 6 PM
            },
            "service_time": 120, // 2 mins
            "demand": 1.0,
            "priority": 1
        });
    }
    return stops;
}

const problem = {
    "plan": {
        "jobs": generateStops(1000).map(s => ({
            "id": s.id,
            "deliveries": [{
                "places": [{
                    "location": { "lat": s.location.lat, "lng": s.location.lon },
                    "duration": s.service_time,
                    "times": [[convertTime(s.time_window.start), convertTime(s.time_window.end)]]
                }],
                "demand": [1]
            }]
        }))
    },
    // We strictly follow the 'pragmatic' format here for direct injection into the demo or simple JSON for our converter
    // Wait, the demo expects Loxi format (simplified), then converts it.
    // Let's generate LOXI Simplified format (stops + vehicle) like the other examples
    "stops": generateStops(1000),
    "fleet_size": 50,
    "vehicle": {
        "capacity": 2000.0, // Big enough to fit all
        "start_location": { "lat": -34.6037, "lon": -58.3816 },
        "end_location": { "lat": -34.6037, "lon": -58.3816 },
        "shift_window": { "start": 28000, "end": 70000 },
        "speed_mps": 10.0
    }
};

function convertTime(seconds) {
    // Just for internal logic if needed, but we output Loxi format which uses integers
    return seconds;
}


fs.writeFileSync('examples/large_1000stops.json', JSON.stringify(problem, null, 2));
console.log('Generated examples/large_1000stops.json');
