const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Migrating users table for email verification...");
        // Add is_verified and verification_code to users table
        const { safeAddColumn } = require('./utils');

        await safeAddColumn(conn, 'users', 'is_verified', 'BOOLEAN DEFAULT FALSE');
        await safeAddColumn(conn, 'users', 'verification_code', 'VARCHAR(10) DEFAULT NULL');

        // Optional: Auto-verify existing users so they don't get locked out
        // Removing this if you want existing users to verify, but usually safest to verify old ones.
        // Uncomment if needed:
        // await conn.query("UPDATE users SET is_verified = TRUE WHERE is_verified IS FALSE AND verification_code IS NULL");

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
