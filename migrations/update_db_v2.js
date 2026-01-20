const db = require('../config/database');

async function update() {
    try {
        const conn = await db.getConnection();
        // Add out of stock column to plans
        const { safeAddColumn } = require('./utils');
        await safeAddColumn(conn, 'Plans', 'is_out_of_stock', 'BOOLEAN DEFAULT FALSE');

        conn.release();
        // process.exit();
    } catch (err) {
        console.error(err);
        // process.exit(1);
    }
}
if (require.main === module) {
    update();
}

module.exports = update;
