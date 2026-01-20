const db = require('../config/database');

async function run() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Running migration: Add 'failure_reason' to active_servers table...");

        // Check if column exists
        const { safeAddColumn } = require('./utils');
        const added = await safeAddColumn(conn, 'active_servers', 'failure_reason', 'TEXT DEFAULT NULL');

        if (added) {
            console.log("Added 'failure_reason' column to active_servers.");
        }

        console.log("Migration complete!");
    } catch (err) {
        console.error("Migration error:", err);
        throw err;
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    run();
}

module.exports = run;
