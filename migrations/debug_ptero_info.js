const pteroService = require('../services/pterodactyl');

async function debug() {
    try {
        console.log("=== NESTS & EGGS ===");
        const nests = await pteroService.getNests();
        for (let nest of nests) {
            console.log(`Nest: ${nest.name} (ID: ${nest.id})`);
            try {
                const eggs = await pteroService.getEggs(nest.id);
                for (let egg of eggs) {
                    console.log(`  - Egg: ${egg.name} (ID: ${egg.id})`);
                }
            } catch (e) {
                console.log(`  - Failed to fetch eggs: ${e.message}`);
            }
        }

        console.log("\n=== NODES ===");
        const nodes = await pteroService.getNodes();
        for (let node of nodes) {
            console.log(`Node: ${node.name} (ID: ${node.id})`);
            console.log(`  Location ID: ${node.location_id}`);
            console.log(`  Public: ${node.public}`);
            console.log(`  Maintenance: ${node.maintenance_mode}`);
            // Check allocs not directly exposed by getNodes usually, but we assume "NoViableNode" means ports/resources
        }

    } catch (err) {
        console.error(err);
    }
}

if (require.main === module) {
    debug();
}

module.exports = debug;
