const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Connected to DB...");

        // Add new columns to locations table
        // Add new columns to locations table
        const { safeAddColumn } = require('./utils');

        await safeAddColumn(conn, 'locations', 'node_id', 'INT DEFAULT NULL');
        await safeAddColumn(conn, 'locations', 'country_code', 'VARCHAR(2) DEFAULT NULL');
        await safeAddColumn(conn, 'locations', 'fqdn', 'VARCHAR(255) DEFAULT NULL');

    } catch (err) {
        console.error("Migration Failed:", err);
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
