const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        console.log("Running migration: Add 'suspended_at' to active_servers table...");
        conn = await db.getConnection();

        // Check if column exists
        const { safeAddColumn } = require('./utils');
        await safeAddColumn(conn, 'active_servers', 'suspended_at', 'DATETIME DEFAULT NULL AFTER renewal_date');

    } catch (err) {
        console.error("Migration failed:", err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

// execute if running directly
if (require.main === module) {
    migrate().then(() => process.exit());
}

module.exports = migrate;
