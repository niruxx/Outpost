// Reuse the isolated real Earth API with fixture downloads for browser integration checks.
process.env.OUTPOST_EARTH_BROWSER = '1';
await import('./beamng-earth.mjs');
