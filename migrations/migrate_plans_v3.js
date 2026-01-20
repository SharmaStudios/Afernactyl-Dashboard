const db = require('../config/database');

async function migratePlansV3() {
    let conn;
    try {
        conn = await db.getConnection();

        const { safeAddColumn } = require('./utils');
        await safeAddColumn(conn, 'Plans', 'db_count', 'INT DEFAULT 0');

        console.log("Migration v3 complete.");
    } catch (err) {
        console.error(err);
        throw err;
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    migratePlansV3();
}

module.exports = migratePlansV3;
