/**
 * Migration: Add broadcast_logs table
 */

const db = require('../config/database');

module.exports = async () => {
    let conn;
    try {
        conn = await db.getConnection();

        const { safeCreateTable } = require('./utils');
        // Actually utils doesn't have safeCreateTable yet, but standard CREATE TABLE IF NOT EXISTS is fine.
        // Just suppress the log or make it conditional?
        // Let's rely on standard silent behavior or just remove the log if table exists.

        // Check if table exists
        const [exists] = await conn.query("SHOW TABLES LIKE 'broadcast_logs'");
        if (!exists) {
            await conn.query(`
                CREATE TABLE IF NOT EXISTS broadcast_logs (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    admin_id INT NOT NULL,
                    admin_username VARCHAR(255),
                    subject VARCHAR(500),
                    email_type ENUM('announcement', 'maintenance', 'urgent') DEFAULT 'announcement',
                    recipient_type ENUM('all', 'active', 'admins') DEFAULT 'all',
                    recipients_count INT DEFAULT 0,
                    sent_count INT DEFAULT 0,
                    failed_count INT DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('[Migration] broadcast_logs table created');
        }
        return true;

    } catch (err) {
        console.error('[Migration Error]', err.message);
        throw err;
    } finally {
        if (conn) conn.release();
    }
};
if (require.main === module) {
    module.exports().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
