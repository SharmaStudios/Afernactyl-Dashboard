const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log("Connected to DB...");

        const [tableExists] = await conn.query("SHOW TABLES LIKE 'locations'");
        if (!tableExists) {
            await conn.query(`
                CREATE TABLE locations (
                    id INT PRIMARY KEY,
                    short VARCHAR(50),
                    long_name VARCHAR(255),
                    multiplier DECIMAL(10, 2) DEFAULT 1.00,
                    is_public BOOLEAN DEFAULT TRUE,
                    is_sold_out BOOLEAN DEFAULT FALSE,
                    region VARCHAR(50) DEFAULT 'Americas',
                    node_id INT DEFAULT NULL,
                    country_code VARCHAR(2) DEFAULT NULL,
                    fqdn VARCHAR(255) DEFAULT NULL,
                    processor_name VARCHAR(100) DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log("Locations table created.");
        }

        // Add processor_name column if missing (for existing installations)
        const { safeAddColumn } = require('./utils');
        await safeAddColumn(conn, 'locations', 'processor_name', 'VARCHAR(100) DEFAULT NULL');

        // Migration: Check if we have JSON data to migrate
        const settings = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'locations_config'");
        if (settings.length > 0 && settings[0].setting_value) {
            try {
                const locs = JSON.parse(settings[0].setting_value);
                console.log(`Found ${locs.length} legacy locations. Migrating...`);

                for (let l of locs) {
                    await conn.query(`
                        INSERT INTO locations (id, short, long_name, multiplier, is_public, is_sold_out)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                        multiplier = VALUES(multiplier),
                        is_public = VALUES(is_public),
                        is_sold_out = VALUES(is_sold_out)
                    `, [l.id, l.short, l.long, l.multiplier, l.is_public, l.is_sold_out]);
                }
                console.log("Migration complete.");
            } catch (e) {
                console.error("Error migrating JSON:", e);
            }
        }

    } catch (err) {
        console.error("Migration Failed:", err);
        throw e;
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
