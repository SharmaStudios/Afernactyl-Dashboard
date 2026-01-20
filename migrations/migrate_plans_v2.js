const db = require('../config/database');

async function migratePlans() {
    let conn;
    try {
        conn = await db.getConnection();

        // Add Allocations, Databases, Backups
        const { safeAddColumn } = require('./utils');

        await safeAddColumn(conn, 'Plans', 'allocations', 'INT DEFAULT 0');
        await safeAddColumn(conn, 'Plans', 'databases', 'INT DEFAULT 0');
        await safeAddColumn(conn, 'Plans', 'backups', 'INT DEFAULT 0');

        // Remove startup_cmd? User said "remove start command feature".
        // I will make it nullable or drop it. Dropping might break existing servers if logic depends on it, but user doesn't want to edit it.
        // Safer to keep it but ignore it / set default.
        // Actually, user said "remove start command feature i dont need it".
        // I'll just stop using it in the UI/Code. No need to DROP COLUMN strictly, but I can set a default.

        console.log("Migration complete.");
    } catch (err) {
        console.error(err);
        throw err;
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    migratePlans();
}

module.exports = migratePlans;
