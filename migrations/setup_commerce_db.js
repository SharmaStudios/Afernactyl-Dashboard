const db = require('../config/database');


async function setupTables(conn) {
    let localConn = false;
    if (!conn) {
        conn = await db.getConnection();
        localConn = true;
    }

    try {
        console.log("Creating tables...");

        // Coupons
        await conn.query(`
            CREATE TABLE IF NOT EXISTS coupons (
                id INT AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                discount_percent DECIMAL(5,2) NOT NULL,
                max_uses INT DEFAULT 0,
                uses INT DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // console.log("Created coupons table.");

        // Payment Gateways
        await conn.query(`
            CREATE TABLE IF NOT EXISTS payment_gateways (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(50) UNIQUE NOT NULL,
                display_name VARCHAR(100),
                enabled BOOLEAN DEFAULT FALSE,
                config JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Seed default gateways
        await conn.query(`
            INSERT IGNORE INTO payment_gateways (name, display_name, enabled, config) VALUES 
            ('stripe', 'Stripe', 0, '{}'),
            ('paypal', 'PayPal', 0, '{}'),
            ('phonepe', 'PhonePe', 0, '{}')
        `);
        // console.log("Created payment_gateways table.");

        // Currencies
        await conn.query(`
            CREATE TABLE IF NOT EXISTS currencies (
                code VARCHAR(3) PRIMARY KEY,
                symbol VARCHAR(5) NOT NULL,
                rate_to_usd DECIMAL(10,4) NOT NULL DEFAULT 1.0,
                is_active BOOLEAN DEFAULT TRUE
            )
        `);
        // Seed default currencies
        await conn.query(`
            INSERT IGNORE INTO currencies (code, symbol, rate_to_usd, is_active) VALUES 
            ('USD', '$', 1.0, 1),
            ('INR', '₹', 83.0, 1),
            ('EUR', '€', 0.92, 1)
        `);
        // console.log("Created currencies table.");

        // Plan Prices (Per Currency Override)
        await conn.query(`
            CREATE TABLE IF NOT EXISTS plan_prices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                plan_id INT NOT NULL,
                currency_code VARCHAR(3) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                UNIQUE KEY unique_plan_currency (plan_id, currency_code),
                FOREIGN KEY (plan_id) REFERENCES Plans(id) ON DELETE CASCADE,
                FOREIGN KEY (currency_code) REFERENCES currencies(code) ON DELETE CASCADE
            )
        `);
        // console.log("Created plan_prices table.");

        // Invoices
        await conn.query(`
            CREATE TABLE IF NOT EXISTS invoices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                plan_id INT,
                server_id INT DEFAULT NULL,
                amount DECIMAL(10,2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                currency_code VARCHAR(10) DEFAULT 'USD',
                currency_amount DECIMAL(10,2) DEFAULT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                type VARCHAR(50) DEFAULT 'purchase',
                payment_method VARCHAR(50),
                transaction_id VARCHAR(255),
                billing_name VARCHAR(255) DEFAULT NULL,
                billing_address TEXT DEFAULT NULL,
                billing_gst VARCHAR(50) DEFAULT NULL,
                gst_number VARCHAR(50) DEFAULT NULL,
                description TEXT,
                notes TEXT,
                subtotal DECIMAL(10,2) DEFAULT NULL,
                tax_rate DECIMAL(5,2) DEFAULT 0.00,
                tax_amount DECIMAL(10,2) DEFAULT 0.00,
                due_date DATETIME DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                paid_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (plan_id) REFERENCES Plans(id) ON DELETE SET NULL
            )
        `);
        // console.log("Created invoices table.");

        // console.log("All tables set up successfully!");
    } catch (err) {
        console.error("Error setting up tables:", err);
        throw err;
    } finally {
        if (localConn && conn) conn.release();
        if (localConn) process.exit(0);
    }
}

if (require.main === module) {
    setupTables();
}

module.exports = setupTables;
