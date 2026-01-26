// @ts-check

export function createMapController(mapEl) {
  /** @type {any} */
  let mapInstance = null;
  /** @type {any} */
  let routeLayer = null;
  /** @type {any} */
  let stopLayer = null;
  let labelsVisible = false;

  function resetMap() {
    if (routeLayer) {
      routeLayer.remove();
      routeLayer = null;
    }
    if (stopLayer) {
      stopLayer.remove();
      stopLayer = null;
    }
  }

  /**
   * @param {boolean} visible
   */
  function setLabelsVisible(visible) {
    labelsVisible = Boolean(visible);
    if (!stopLayer) {
      return;
    }
    stopLayer.eachLayer((layer) => {
      if (!layer?.unbindTooltip || !layer?.bindTooltip) {
        return;
      }
      layer.unbindTooltip();
      if (labelsVisible) {
        const content = layer.options?.tooltipContent ?? "";
        layer.bindTooltip(content, {
          permanent: true,
          direction: "right",
          offset: [8, -8],
          opacity: 1,
        });
      }
    });
  }

  /**
   * @param {any} problem
   * @param {string[]} routeIds
   */
  function renderMapRoute(problem, routeIds) {
    const stops = problem?.stops ?? [];
    if (!mapEl || stops.length === 0) {
      return;
    }

    if (!mapInstance) {
      // @ts-ignore
      mapInstance = L.map(mapEl, {
        zoomControl: true,
        attributionControl: true,
      });
      // @ts-ignore
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(mapInstance);
    }

    const stopById = new Map(stops.map((stop) => [stop.id, stop]));
    const routeStops = routeIds.map((id) => stopById.get(id)).filter(Boolean);

    resetMap();

    if (routeStops.length > 0) {
      const latLngs = routeStops.map((stop) => [stop.location.lat, stop.location.lon]);
      // @ts-ignore
      routeLayer = L.polyline(latLngs, { color: "#2563eb", weight: 4 }).addTo(mapInstance);
      // @ts-ignore
      stopLayer = L.layerGroup().addTo(mapInstance);

      routeStops.forEach((stop, index) => {
        // @ts-ignore
        const marker = L.circleMarker([stop.location.lat, stop.location.lon], {
          radius: 6,
          color: index === 0 ? "#16a34a" : "#0f172a",
          fillColor: index === 0 ? "#16a34a" : "#0f172a",
          fillOpacity: 1,
          weight: 2,
          tooltipContent: stop.id,
        }).addTo(stopLayer);
        if (labelsVisible) {
          marker.bindTooltip(stop.id, {
            permanent: true,
            direction: "right",
            offset: [8, -8],
            opacity: 1,
          });
        }
      });

      mapInstance.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
    }
  }

  /**
   * @param {any} problem
   * @param {string[]} routeIds
   * @param {string} color
   */
  function renderMultiRoute(problem, routeIds, color = "#2563eb") {
    const stops = problem?.stops ?? [];
    if (!mapEl || stops.length === 0) {
      return;
    }

    if (!mapInstance) {
      // @ts-ignore
      mapInstance = L.map(mapEl, {
        zoomControl: true,
        attributionControl: true,
      });
      // @ts-ignore
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(mapInstance);
    }

    const stopById = new Map(stops.map((stop) => [stop.id, stop]));
    const routeStops = routeIds.map((id) => stopById.get(id)).filter(Boolean);

    if (routeStops.length > 1) {
      const latLngs = routeStops.map((stop) => [stop.location.lat, stop.location.lon]);
      // @ts-ignore
      const layer = L.polyline(latLngs, { color: color, weight: 3, opacity: 0.8 }).addTo(mapInstance);

      // Add small markers for stops in this specific route
      routeStops.forEach((stop) => {
        // @ts-ignore
        L.circleMarker([stop.location.lat, stop.location.lon], {
          radius: 3,
          color: color,
          fillColor: color,
          fillOpacity: 0.6,
        }).addTo(mapInstance);
      });

      mapInstance.fitBounds(layer.getBounds(), { padding: [30, 30] });
    }
  }

  return {
    resetMap,
    renderMapRoute,
    renderMultiRoute,
    setLabelsVisible,
    get labelsVisible() {
      return labelsVisible;
    },
  };
}


