
import { Coordinate } from '../interfaces';

const OSRM_URL = process.env.OSRM_URL;
if (!OSRM_URL) {
    throw new Error("Configuration Error: OSRM_URL environment variable is missing. Public API usage is disabled.");
}

interface OSRMTableResponse {
    code: string;
    durations: number[][]; // Duration in seconds
    destinations: {
        hint: string;
        distance: number;
        name: string;
        location: [number, number];
    }[];
    sources: {
        hint: string;
        distance: number;
        name: string;
        location: [number, number];
    }[];
}

export const getDurationMatrix = async (locations: Coordinate[]): Promise<number[][]> => {
    if (locations.length < 2) {
        return [[0]];
    }

    // Format coordinates: lon,lat;lon,lat
    const coordsString = locations.map(loc => `${loc.lon},${loc.lat}`).join(';');

    // Construct URL
    // annotations=duration is default but explicit is good.
    const url = `${OSRM_URL}/table/v1/driving/${coordsString}?annotations=duration`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`OSRM Table Error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as OSRMTableResponse;

        if (data.code !== 'Ok') {
            throw new Error(`OSRM API Error Code: ${data.code}`);
        }

        return data.durations;

    } catch (error) {
        console.error('OSRM Matrix Error:', error);
        throw error;
    }
};
