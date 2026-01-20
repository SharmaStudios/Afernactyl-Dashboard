const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Connected to database...");

        const { safeAddColumn } = require('./utils');
        // 1. Add attachment column to ticket_messages
        await safeAddColumn(conn, 'ticket_messages', 'attachment', 'VARCHAR(255) DEFAULT NULL');

        // 2. Create canned_responses table
        await conn.query(`
            CREATE TABLE IF NOT EXISTS canned_responses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(100) NOT NULL,
                message TEXT NOT NULL
            )
        `);
        console.log("Created 'canned_responses' table.");

        // 3. Seed Canned Responses (if empty)
        const existing = await conn.query("SELECT count(*) as count FROM canned_responses");
        if (Number(existing[0].count) === 0) {
            await conn.query("INSERT INTO canned_responses (title, message) VALUES ('Greeting', 'Hello! How can I help you today?'), ('Investigating', 'We are currently investigating your issue.'), ('Resolved', 'We have resolved the issue. Please check and let us know.')");
            console.log("Seeded canned_responses.");
        }

        console.log("Migration complete!");
    } catch (err) {
        console.error("Migration failed:", err);
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
