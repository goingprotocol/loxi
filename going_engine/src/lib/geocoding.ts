import axios from 'axios';
import { Address, GeocodedAddress } from '../interfaces';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export const geocodeAddress = async (address: Address): Promise<GeocodedAddress | null> => {
    // If already has lat/lon, return as GeocodedAddress (casting)
    if (address.lat && address.lon) {
        return address as GeocodedAddress;
    }

    try {
        const query = `${address.street}, ${address.city}, ${address.country}`;
        console.log(`[Geocoding] Requesting: ${query}`);

        const response = await axios.get(NOMINATIM_URL, {
            params: {
                q: query,
                format: 'json',
                limit: 1
            },
            headers: {
                'User-Agent': 'GoingLogisticsEngine/1.0' // Required by Nominatim
            }
        });

        if (response.data && response.data.length > 0) {
            const result = response.data[0];
            const lat = parseFloat(result.lat);
            const lon = parseFloat(result.lon);

            console.log(`[Geocoding] Success: ${lat}, ${lon}`);

            return {
                ...address,
                lat,
                lon,
                // H3 indices will be calculated by the caller or a separate helper if needed
                h3Index: '',
                h3IndexL6: '',
                h3IndexL8: '',
                h3IndexL11: ''
            } as GeocodedAddress;
        } else {
            console.warn(`[Geocoding] No results found for: ${query}`);
            return null;
        }
    } catch (error) {
        console.error('[Geocoding] Error:', error);
        return null;
    }
};
