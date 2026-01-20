const db = require('../config/database');

async function up() {
    let conn;
    try {
        conn = await db.getConnection();

        // Check if column exists
        const { safeAddColumn } = require('./utils');
        await safeAddColumn(conn, 'Plans', 'allow_egg_selection', 'TINYINT(1) DEFAULT 0 AFTER billing_period');

        // Make egg_id and nest_id nullable (for "Let User Choose" mode)
        await conn.query(`ALTER TABLE Plans MODIFY egg_id INT NULL`);
        await conn.query(`ALTER TABLE Plans MODIFY nest_id INT NULL`);

    } catch (err) {
        console.error('Migration error:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { up };

// Run if called directly
if (require.main === module) {
    up().then(() => {
        console.log('Migration complete');
        process.exit(0);
    }).catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}
