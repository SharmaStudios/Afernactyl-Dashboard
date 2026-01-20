const db = require('../config/database');

async function migrate() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log('[Migration] Adding first_name and last_name columns to users table...');

        // Add first_name column
        try {
            await conn.query(`ALTER TABLE users ADD COLUMN first_name VARCHAR(255) DEFAULT NULL AFTER username`);
            console.log('[Migration] Added first_name column');
        } catch (e) {
            if (e.code === 'ER_DUP_FIELDNAME') {
                console.log('[Migration] first_name column already exists, skipping...');
            } else {
                throw e;
            }
        }

        // Add last_name column
        try {
            await conn.query(`ALTER TABLE users ADD COLUMN last_name VARCHAR(255) DEFAULT NULL AFTER first_name`);
            console.log('[Migration] Added last_name column');
        } catch (e) {
            if (e.code === 'ER_DUP_FIELDNAME') {
                console.log('[Migration] last_name column already exists, skipping...');
            } else {
                throw e;
            }
        }

        console.log('[Migration] User name fields migration completed successfully!');
    } catch (err) {
        console.error('[Migration] Error:', err);
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
