const db = require('../config/database');

async function setup(conn) {
    let localConn = false;
    if (!conn) {
        conn = await db.getConnection();
        localConn = true;
    }

    try {
        console.log("[Migration] Adding Affiliate System Tables...");

        // 1. Affiliates Table
        await conn.query(`
            CREATE TABLE IF NOT EXISTS affiliates (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL UNIQUE,
                referral_code VARCHAR(50) NOT NULL UNIQUE,
                commission_rate DECIMAL(5, 2) DEFAULT 10.00,
                balance DECIMAL(15, 2) DEFAULT 0.00,
                total_earned DECIMAL(15, 2) DEFAULT 0.00,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // 2. Referrals Table (Links referred user to affiliate)
        await conn.query(`
            CREATE TABLE IF NOT EXISTS referrals (
                id INT AUTO_INCREMENT PRIMARY KEY,
                affiliate_id INT NOT NULL,
                referred_user_id INT NOT NULL UNIQUE,
                status ENUM('pending', 'active', 'completed') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE,
                FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // 3. Affiliate Payouts Table
        await conn.query(`
            CREATE TABLE IF NOT EXISTS affiliate_payouts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                affiliate_id INT NOT NULL,
                amount DECIMAL(15, 2) NOT NULL,
                status ENUM('pending', 'approved', 'rejected', 'paid') DEFAULT 'pending',
                payment_method VARCHAR(100) DEFAULT 'Credits',
                notes TEXT,
                paid_at DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE
            )
        `);

        // 4. Add referred_by to users (for easier tracking)
        const columns = await conn.query("SHOW COLUMNS FROM users LIKE 'referred_by'");
        if (!columns || columns.length === 0) {
            await conn.query("ALTER TABLE users ADD COLUMN referred_by INT NULL DEFAULT NULL");
            // Don't add foreign key if it might cause issues, can be added manually with proper index
        }

        // 5. Add default settings for affiliates
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('affiliate_default_commission', '10.00')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('affiliate_min_payout', '10.00')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('affiliate_cookie_days', '30')");

        console.log("[Migration] Affiliate System Tables layout created successfully.");
    } catch (err) {
        console.error("[Migration] Error creating affiliate tables:", err);
        throw err;
    } finally {
        if (localConn && conn) conn.release();
    }
}

if (require.main === module) {
    setup().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = setup;
