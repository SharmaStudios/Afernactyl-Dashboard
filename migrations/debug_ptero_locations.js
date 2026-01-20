const pteroService = require('../services/pterodactyl');
const db = require('../config/database');

async function debug() {
    try {
        console.log("Fetching Ptero Locations...");
        const remoteLocations = await pteroService.getLocations();
        console.log("Remote Locations:", JSON.stringify(remoteLocations, null, 2));

        console.log("Fetching Local Locations...");
        const conn = await db.getConnection();
        const localLocations = await conn.query("SELECT * FROM locations");
        console.log("Local Locations:", JSON.stringify(localLocations, null, 2));
        conn.release();

        // process.exit(0);

    } catch (err) {
        console.error(err);
        // process.exit(1);
    }
}

if (require.main === module) {
    debug();
}

module.exports = debug;
