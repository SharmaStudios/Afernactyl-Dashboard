/**
 * Migration: Add billing_period to Plans table
 * Allows plans to be weekly, monthly, quarterly, or yearly
 */

const db = require('../config/database');

async function run() {
    const conn = await db.getConnection();
    try {
        const { safeAddColumn } = require('./utils');
        await safeAddColumn(conn, 'Plans', 'billing_period', "ENUM('weekly', 'monthly', 'quarterly', 'yearly') DEFAULT 'monthly'");

    } catch (err) {
        console.error('[Migration] Error:', err.message);
        throw err;
    } finally {
        conn.release();
    }
}

if (require.main === module) {
    run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = run;
