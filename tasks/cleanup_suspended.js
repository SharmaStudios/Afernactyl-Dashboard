/**
 * Scheduled Task: Auto-delete servers suspended for 7+ days
 * Run this via cron: node /path/to/tasks/cleanup_suspended.js
 */

const db = require('../config/database');
const pteroService = require('../services/pterodactyl');

async function cleanupSuspendedServers() {
    let conn;
    try {
        conn = await db.getConnection();

        // Find servers suspended for more than 7 days
        const suspendedServers = await conn.query(`
            SELECT * FROM active_servers 
            WHERE status = 'suspended' 
            AND suspended_at IS NOT NULL 
            AND suspended_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
        `);

        console.log(`[Cleanup] Found ${suspendedServers.length} servers to delete.`);

        for (const server of suspendedServers) {
            try {
                // Delete from Pterodactyl
                await pteroService.deleteServer(server.ptero_server_id);
                console.log(`[Cleanup] Deleted Pterodactyl server ${server.ptero_server_id}`);
            } catch (pteroErr) {
                console.error(`[Cleanup] Failed to delete from Pterodactyl:`, pteroErr.message);
                // Only proceed if it was a 404 (already deleted), otherwise skip local delete to prevent sync issues
                if (!pteroErr.message.includes('404')) {
                    continue;
                }
            }

            // Delete from local DB
            await conn.query("DELETE FROM active_servers WHERE id = ?", [server.id]);
            console.log(`[Cleanup] Removed server #${server.id} from database.`);
        }

        console.log('[Cleanup] Complete.');
    } catch (err) {
        console.error('[Cleanup] Error:', err);
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
    cleanupSuspendedServers();
}

module.exports = cleanupSuspendedServers;
