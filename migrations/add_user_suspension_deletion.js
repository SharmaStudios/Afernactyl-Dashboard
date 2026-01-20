const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Migrating users table...");

        const { safeAddColumn } = require('./utils');

        await safeAddColumn(conn, 'users', 'is_suspended', 'BOOLEAN DEFAULT FALSE');
        await safeAddColumn(conn, 'users', 'suspension_reason', 'TEXT DEFAULT NULL');
        await safeAddColumn(conn, 'users', 'deletion_requested', 'BOOLEAN DEFAULT FALSE');
        await safeAddColumn(conn, 'users', 'deletion_date', 'DATETIME DEFAULT NULL');

        console.log("Migration complete.");
    } catch (err) {
        console.error("Migration failed:", err);
        throw err;
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
