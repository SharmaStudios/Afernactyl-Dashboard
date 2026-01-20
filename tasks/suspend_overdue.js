/**
 * Scheduled Task: Auto-suspend overdue servers
 * Run this via cron: node tasks/suspend_overdue.js
 */

const db = require('../config/database');
const pteroService = require('../services/pterodactyl');

async function suspendOverdueServers() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log('[Suspension Job] Starting auto-suspension check...');

        // Find active servers that are past renewal date
        const overdueServers = await conn.query(`
            SELECT * FROM active_servers 
            WHERE status = 'active' 
            AND renewal_date IS NOT NULL 
            AND renewal_date < NOW()
        `);

        console.log(`[Suspension Job] Found ${overdueServers.length} servers to suspend.`);

        for (const server of overdueServers) {
            try {
                // Suspend on Pterodactyl
                if (server.ptero_server_id) {
                    await pteroService.suspendServer(server.ptero_server_id);
                    console.log(`[Suspension Job] Suspended Pterodactyl server ${server.ptero_server_id}`);
                }

                // Update local status
                await conn.query(`
                    UPDATE active_servers 
                    SET status = 'suspended', suspended_at = NOW() 
                    WHERE id = ?
                `, [server.id]);

                console.log(`[Suspension Job] Marked server #${server.id} (${server.server_name}) as suspended.`);

                // Optional: Send email notification (implement later if needed)

            } catch (err) {
                console.error(`[Suspension Job] Failed to suspend server ${server.id}:`, err.message);
            }
        }

        console.log('[Suspension Job] Complete.');
    } catch (err) {
        console.error('[Suspension Job] Error:', err);
    } finally {
        if (conn) conn.release();
        // Only exit if running standalone
        if (require.main === module) {
            process.exit(0);
        }
    }
}

// Run if called directly
if (require.main === module) {
    suspendOverdueServers();
}

module.exports = suspendOverdueServers;
