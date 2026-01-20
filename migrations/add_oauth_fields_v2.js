const db = require('../config/database');

async function up() {
    let conn;
    try {
        conn = await db.getConnection();

        console.log("Checking for OAuth columns in users table...");

        const [columns] = await conn.query("SHOW COLUMNS FROM users LIKE 'github_id'");

        if (!columns) {
            console.log("Adding OAuth columns...");
            await conn.query(`
                ALTER TABLE users 
                ADD COLUMN github_id VARCHAR(255) DEFAULT NULL,
                ADD COLUMN discord_id VARCHAR(255) DEFAULT NULL,
                ADD COLUMN google_id VARCHAR(255) DEFAULT NULL,
                ADD COLUMN apple_id VARCHAR(255) DEFAULT NULL,
                ADD COLUMN avatar VARCHAR(500) DEFAULT NULL
            `);
            console.log("OAuth columns added successfully.");
        } else {
            console.log("OAuth columns already exist.");
        }

    } catch (err) {
        console.error("Migration failed:", err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

if (require.main === module) {
    up().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = up;
