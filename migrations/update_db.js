const db = require('../config/database');

async function update() {
    let conn;
    try {
        conn = await db.getConnection();

        const { safeAddColumn } = require('./utils');
        await safeAddColumn(conn, 'users', 'reset_token', 'VARCHAR(255) DEFAULT NULL');
        await safeAddColumn(conn, 'users', 'reset_expires', 'DATETIME DEFAULT NULL');

        console.log("Update migration complete");
    } catch (err) {
        console.error("Update migration failed:", err);
        throw err;
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}
if (require.main === module) {
    update();
}

module.exports = update;
