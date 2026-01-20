const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Adding due_date column to invoices table...");

        // Add due_date column if it doesn't exist
        const { safeAddColumn } = require('./utils');
        const added = await safeAddColumn(conn, 'invoices', 'due_date', 'DATETIME DEFAULT NULL');

        if (added) {
            // Only update if we actually added the column (new feature rollout)
            try {
                await conn.query(`
                    UPDATE invoices 
                    SET due_date = DATE_ADD(created_at, INTERVAL 7 DAY) 
                    WHERE due_date IS NULL AND status = 'pending'
                `);
                console.log("Updated existing pending invoices with due dates.");
            } catch (e) {
                // ignore
            }
        }

        // Update existing pending invoices to have due_date = created_at + 7 days
        await conn.query(`
            UPDATE invoices 
            SET due_date = DATE_ADD(created_at, INTERVAL 7 DAY) 
            WHERE due_date IS NULL AND status = 'pending'
        `);
        console.log("Updated existing pending invoices with due dates.");

        console.log("Migration complete!");
        // process.exit(0);
    } catch (err) {
        console.error("Migration failed:", err);
        // process.exit(1);
    } finally {
        if (conn) conn.release();
    }
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
