const pteroService = require('../services/pterodactyl');
const db = require('../config/database');
const crypto = require('crypto');

async function debug() {
    try {
        console.log("Starting Debug Process...");

        // 1. Get a mock user
        const email = 'debug_user_' + Math.floor(Math.random() * 1000) + '@example.com';
        console.log("Creating/Fetching Ptero User:", email);

        // Mock User Params
        const pteroPass = crypto.randomBytes(8).toString('hex');
        let pteroUser = await pteroService.getUser(email);

        if (!pteroUser) {
            pteroUser = await pteroService.createUser({
                email: email,
                username: 'DebugUser' + Math.floor(Math.random() * 1000),
                first_name: 'Debug',
                last_name: 'User'
            }, pteroPass);
            console.log("Created New User:", pteroUser.id);
        } else {
            console.log("Used Existing User:", pteroUser.id);
        }

        // 2. Prepare Server Config (Simulate Payload from Dashboard)
        // Adjust these IDs to match your ACTUAL Pterodactyl setup
        const nestId = 1; // Minecraft
        const eggId = 4;  // Vanilla Minecraft
        const locationId = 1; // India (Suspected Full)

        const serverConfig = {
            name: 'Debug Server ' + Math.floor(Math.random() * 1000),
            user_id: parseInt(pteroUser.id),
            egg_id: eggId,
            nest_id: nestId,
            docker_image: 'ghcr.io/pterodactyl/yolks:java_17',
            startup_cmd: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar',
            environment: {}, // Should be auto-healed
            ram: 128,          // Minimal RAM
            swap: 0,
            disk: 128,         // Minimal Disk
            cpu: 100,
            location_id: locationId,
            db_count: 0,
            allocations: 0,    // Try 0 extra ports? No, need at least 1 for default. Ptero assigns 1 automatically from deploy location. 
            // Actually feature_limits.allocations = number of ADDITIONAL ports.
            backups: 0
        };

        console.log("Attempting to Create Server...");
        const server = await pteroService.createServer(serverConfig);
        console.log("Server Created Successfully:", server.id);

        // process.exit(0);

    } catch (err) {
        console.error("DEBUG ERROR CAUGHT:");
        if (err.response) {
            console.error("Status:", err.response.status);
            console.error("Data:", JSON.stringify(err.response.data, null, 2));
        } else {
            console.error(err.message);
        }
        // process.exit(1);
    }
}

if (require.main === module) {
    debug();
}

module.exports = debug;
