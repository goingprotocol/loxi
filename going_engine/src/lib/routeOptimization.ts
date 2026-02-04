import { Coordinate } from '../interfaces';
import { latLngToCell, gridDistance } from 'h3-js';
import { H3_RESOLUTION_MICRO } from './routingUtils';

/**
 * Calculate the total distance of a route given a sequence of coordinates.
 */
export const calculateRouteDistance = (route: Coordinate[]): number => {
    if (route.length < 2) return 0;

    let totalDistance = 0;
    for (let i = 0; i < route.length - 1; i++) {
        const startCell = latLngToCell(route[i].lat, route[i].lon, H3_RESOLUTION_MICRO);
        const endCell = latLngToCell(route[i + 1].lat, route[i + 1].lon, H3_RESOLUTION_MICRO);
        totalDistance += gridDistance(startCell, endCell);
    }

    return totalDistance;
};

/**
 * Calculate the cost (additional distance) of adding a new point to a route.
 * Uses a simple greedy insertion: adds the point at the end of the route.
 */
export const calculateInsertionCost = (
    currentRoute: Coordinate[],
    newPoint: Coordinate
): number => {
    if (currentRoute.length === 0) return 0;

    const lastPoint = currentRoute[currentRoute.length - 1];

    // Cost is the distance from the last point to the new point
    const startCell = latLngToCell(lastPoint.lat, lastPoint.lon, H3_RESOLUTION_MICRO);
    const endCell = latLngToCell(newPoint.lat, newPoint.lon, H3_RESOLUTION_MICRO);
    return gridDistance(startCell, endCell);
};

/**
 * Calculate the Total Tour Cost:
 * Pickup Route + Bridge (Last Pickup -> First Delivery) + Delivery Route
 * 
 * This metric naturally enforces directionality. If a new pickup is "backwards",
 * it increases the Pickup Route length AND potentially the Bridge length,
 * resulting in a high cost.
 */
export const calculateTotalTourCost = (
    pickupRoute: Coordinate[],
    deliveryRoute: Coordinate[]
): number => {
    if (pickupRoute.length === 0 || deliveryRoute.length === 0) return 0;

    const pickupDist = calculateRouteDistance(pickupRoute);
    const deliveryDist = calculateRouteDistance(deliveryRoute);

    // The "Bridge" is the distance from the last pickup to the first delivery
    const lastPickup = pickupRoute[pickupRoute.length - 1];
    const firstDelivery = deliveryRoute[0];

    const startCell = latLngToCell(lastPickup.lat, lastPickup.lon, H3_RESOLUTION_MICRO);
    const endCell = latLngToCell(firstDelivery.lat, firstDelivery.lon, H3_RESOLUTION_MICRO);
    const bridgeDist = gridDistance(startCell, endCell);

    return pickupDist + bridgeDist + deliveryDist;
};

/**
 * Evaluate if adding a shipment is efficient based on Total Tour Cost.
 * It compares the cost BEFORE adding vs AFTER adding.
 */
export const shouldAddShipmentToBatch = (
    currentPickupRoute: Coordinate[],
    currentDeliveryRoute: Coordinate[],
    newPickup: Coordinate,
    newDelivery: Coordinate,
    maxDetourHops: number = 10 // Allowable increase in total tour length (10 hops ~ 5km)
): boolean => {
    const currentCost = calculateTotalTourCost(currentPickupRoute, currentDeliveryRoute);

    // Simulate new routes
    const newPickupRoute = [...currentPickupRoute, newPickup];
    const newDeliveryRoute = [...currentDeliveryRoute, newDelivery];

    const newCost = calculateTotalTourCost(newPickupRoute, newDeliveryRoute);

    const increase = newCost - currentCost;

    // If it's the first shipment (currentCost is 0), we accept it (increase is just the base distance)
    if (currentPickupRoute.length === 0) return true;

    return increase <= maxDetourHops;
};

/**
 * Helper to calculate the increase in cost for greedy selection
 */
export const calculateCostIncrease = (
    currentPickupRoute: Coordinate[],
    currentDeliveryRoute: Coordinate[],
    newPickup: Coordinate,
    newDelivery: Coordinate
): number => {
    const currentCost = calculateTotalTourCost(currentPickupRoute, currentDeliveryRoute);

    const newPickupRoute = [...currentPickupRoute, newPickup];
    const newDeliveryRoute = [...currentDeliveryRoute, newDelivery];

    const newCost = calculateTotalTourCost(newPickupRoute, newDeliveryRoute);

    return newCost - currentCost;
};
