const db = require('../config/database');

async function checkCurrency() {
    try {
        const conn = await db.getConnection();
        const currencies = await conn.query("SELECT * FROM currencies");
        console.log('--- CURRENCIES ---');
        console.table(currencies);

        // Simulate logic
        const planPrice = 1.00; // USD
        const inr = currencies.find(c => c.code === 'INR');
        if (inr) {
            const calculated = (planPrice * inr.rate_to_usd).toFixed(2);
            console.log(`1 USD = ${calculated} INR (Rate: ${inr.rate_to_usd})`);
        } else {
            console.log('INR not found');
        }

        conn.release();
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

checkCurrency();
