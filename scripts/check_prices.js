const db = require('../config/database');

async function checkPrices() {
    try {
        const conn = await db.getConnection();
        const prices = await conn.query("SELECT * FROM plan_prices");
        console.log('--- PLAN PRICES ---');
        console.table(prices);
        conn.release();
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

checkPrices();
