const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        const { safeAddColumn } = require('./utils');

        await safeAddColumn(conn, 'active_servers', 'radar_status', "ENUM('safe', 'warning', 'danger') DEFAULT 'safe'");
        await safeAddColumn(conn, 'active_servers', 'radar_last_scan', 'DATETIME DEFAULT NULL');
        await safeAddColumn(conn, 'active_servers', 'radar_details', 'JSON DEFAULT NULL');

        // Add default radar setting if it doesn't exist
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('radar_enabled', 'false')");

    } catch (err) {
        console.error("Migration failed:", err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}
if (require.main === module) {
    migrate().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = migrate;
