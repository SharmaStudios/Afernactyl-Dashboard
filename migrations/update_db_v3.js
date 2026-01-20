const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Running migration: Update DB v3 (Invoice & Active Server fields)...");

        const { safeAddColumn } = require('./utils');

        await safeAddColumn(conn, 'users', 'gst_number', 'VARCHAR(50) DEFAULT NULL');
        await safeAddColumn(conn, 'active_servers', 'currency_code', 'VARCHAR(10) DEFAULT "USD"');
        await safeAddColumn(conn, 'invoices', 'server_id', 'INT DEFAULT NULL');
        await safeAddColumn(conn, 'invoices', 'gst_number', 'VARCHAR(50) DEFAULT NULL');
        await safeAddColumn(conn, 'invoices', 'currency_code', 'VARCHAR(10) DEFAULT "USD"');
        await safeAddColumn(conn, 'invoices', 'currency_amount', 'DECIMAL(10,2) DEFAULT NULL');
        await safeAddColumn(conn, 'invoices', 'type', 'VARCHAR(50) DEFAULT "purchase"');
        await safeAddColumn(conn, 'invoices', 'description', 'TEXT DEFAULT NULL');
        await safeAddColumn(conn, 'invoices', 'subtotal', 'DECIMAL(10,2) DEFAULT NULL');
        await safeAddColumn(conn, 'invoices', 'tax_rate', 'DECIMAL(5,2) DEFAULT 0.00');
        await safeAddColumn(conn, 'invoices', 'tax_amount', 'DECIMAL(10,2) DEFAULT 0.00');

        console.log("Migration Update DB v3 complete!");
    } catch (err) {
        console.error("Migration Update DB v3 failed:", err);
        throw err;
    } finally {
        if (conn) conn.release();
        if (require.main === module) process.exit();
    }
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
