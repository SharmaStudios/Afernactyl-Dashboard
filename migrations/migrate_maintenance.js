const db = require('../config/database');

async function migrateMaintenance() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Checking Categories...");
        const cats = await conn.query("SELECT * FROM categories");
        console.log(`Found ${cats.length} categories.`);
        if (cats.length === 0) {
            console.log("Seeding default categories...");
            await conn.query("INSERT INTO categories (name) VALUES ('Minecraft'), ('Bot Hosting'), ('Web Hosting')");
        }

        console.log("Adding Maintenance Setting...");
        // Insert if not exists
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('maintenance', 'false')");

        console.log("Done.");
    } catch (err) {
        console.error(err);
            throw err;
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    migrateMaintenance();
}

module.exports = migrateMaintenance;
