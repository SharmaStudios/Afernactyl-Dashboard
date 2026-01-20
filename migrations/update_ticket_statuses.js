/**
 * Migration: Update ticket statuses
 * Adds new status options: open, awaiting_reply, in_progress, awaiting_customer, resolved, closed
 */

const db = require('../config/database');

async function run() {
    const conn = await db.getConnection();
    try {
        console.log('[Migration] Updating ticket status column...');

        // Modify the existing ENUM column to include new statuses
        await conn.query(`
            ALTER TABLE tickets 
            MODIFY COLUMN status ENUM('open', 'awaiting_reply', 'in_progress', 'awaiting_customer', 'resolved', 'closed') 
            DEFAULT 'open'
        `);

        console.log('[Migration] Status column updated successfully');
        console.log('[Migration] Ticket statuses migration completed');
    } catch (err) {
        console.error('[Migration] Error:', err.message);
        throw err;
    } finally {
        conn.release();
    }
}

if (require.main === module) {
    run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
