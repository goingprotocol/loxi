use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
}

impl Location {
    pub fn new(lat: f64, lon: f64) -> Self {
        Self { lat, lon }
    }

    pub fn distance_to(&self, other: &Location) -> f64 {
        const EARTH_RADIUS_M: f64 = 6_371_000.0;

        let lat1 = self.lat.to_radians();
        let lat2 = other.lat.to_radians();
        let delta_lat = (other.lat - self.lat).to_radians();
        let delta_lon = (other.lon - self.lon).to_radians();

        let a = (delta_lat / 2.0).sin().powi(2)
            + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
        let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

        EARTH_RADIUS_M * c
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeWindow {
    pub start: u32,
    pub end: u32,
}

impl TimeWindow {
    pub fn new(start: u32, end: u32) -> Self {
        assert!(start <= end, "Time window start must be <= end");
        Self { start, end }
    }

    pub fn contains(&self, time: u32) -> bool {
        time >= self.start && time <= self.end
    }

    pub fn wait_time(&self, arrival_time: u32) -> u32 {
        self.start.saturating_sub(arrival_time)
    }

    pub fn late_by(&self, arrival_time: u32) -> u32 {
        arrival_time.saturating_sub(self.end)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stop {
    pub id: String,
    pub location: Location,
    pub time_window: TimeWindow,
    pub service_time: u32,
    pub demand: f64,
    pub priority: u32,
}

impl Stop {
    pub fn new(
        id: impl Into<String>,
        location: Location,
        time_window: TimeWindow,
        service_time: u32,
        demand: f64,
        priority: u32,
    ) -> Self {
        Self { id: id.into(), location, time_window, service_time, demand, priority }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn test_location_distance() {
        let nyc = Location::new(40.7128, -74.0060);
        let la = Location::new(34.0522, -118.2437);
        let distance = nyc.distance_to(&la);

        assert_relative_eq!(distance, 3_936_000.0, max_relative = 0.01);
    }

    #[test]
    fn test_time_window_contains() {
        let tw = TimeWindow::new(3600, 7200);
        assert!(!tw.contains(3599));
        assert!(tw.contains(3600));
        assert!(tw.contains(5400));
        assert!(tw.contains(7200));
        assert!(!tw.contains(7201));
    }

    #[test]
    fn test_time_window_penalty() {
        let tw = TimeWindow::new(3600, 7200);
        assert_eq!(tw.wait_time(3000), 600);
        assert_eq!(tw.late_by(3000), 0);
        assert_eq!(tw.wait_time(5400), 0);
        assert_eq!(tw.late_by(5400), 0);
        assert_eq!(tw.wait_time(8000), 0);
        assert_eq!(tw.late_by(8000), 800);
    }

    #[test]
    fn test_stop_serialization() {
        let stop = Stop::new(
            "stop1",
            Location::new(40.7128, -74.0060),
            TimeWindow::new(0, 86400),
            300,
            10.0,
            1,
        );

        let json = serde_json::to_string(&stop).unwrap();
        let deserialized: Stop = serde_json::from_str(&json).unwrap();
        assert_eq!(stop.id, deserialized.id);
        assert_eq!(stop.location, deserialized.location);
    }
}
