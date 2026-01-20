const db = require('../config/database');


async function setup(conn) {
    // If conn is provided (by runner), use it. Otherwise create one (backwards compat).
    let localConn = false;
    if (!conn) {
        conn = await db.getConnection();
        localConn = true;
    }

    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                first_name VARCHAR(255) DEFAULT NULL,
                last_name VARCHAR(255) DEFAULT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                ptero_id INT,
                balance DECIMAL(10, 2) DEFAULT 0.00,
                is_admin BOOLEAN DEFAULT FALSE,
                country VARCHAR(10) DEFAULT NULL,
                preferred_currency VARCHAR(10) DEFAULT 'USD',
                billing_name VARCHAR(255) DEFAULT NULL,
                billing_address TEXT DEFAULT NULL,
                billing_gst VARCHAR(50) DEFAULT NULL,
                gst_number VARCHAR(50) DEFAULT NULL,
                reset_token VARCHAR(255) DEFAULT NULL,
                reset_expires DATETIME DEFAULT NULL,
                is_suspended BOOLEAN DEFAULT FALSE,
                suspension_reason TEXT DEFAULT NULL,
                deletion_requested BOOLEAN DEFAULT FALSE,
                deletion_date DATETIME DEFAULT NULL,
                is_verified BOOLEAN DEFAULT FALSE,
                verification_code VARCHAR(10) DEFAULT NULL,
                github_id VARCHAR(255) DEFAULT NULL,
                discord_id VARCHAR(255) DEFAULT NULL,
                google_id VARCHAR(255) DEFAULT NULL,
                apple_id VARCHAR(255) DEFAULT NULL,
                avatar VARCHAR(500) DEFAULT NULL,
                referred_by INT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);


        await conn.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS Plans (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price DECIMAL(10, 2) NOT NULL,
                ram INT NOT NULL,
                cpu INT NOT NULL,
                disk INT NOT NULL,
                egg_id INT NOT NULL,
                nest_id INT NOT NULL,
                category_id INT,
                docker_image VARCHAR(255) DEFAULT 'ghcr.io/pterodactyl/yolks:java_17',
                startup_cmd TEXT DEFAULT 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar',
                allocations INT DEFAULT 0,
                backups INT DEFAULT 0,
                db_count INT DEFAULT 0,
                is_out_of_stock TINYINT(1) DEFAULT 0,
                is_visible TINYINT(1) DEFAULT 1,
                processor_name VARCHAR(100) DEFAULT NULL,
                environment_config TEXT DEFAULT '{}',
                billing_period ENUM('weekly', 'monthly', 'quarterly', 'yearly') DEFAULT 'monthly',
                allow_egg_selection TINYINT(1) DEFAULT 0,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS active_servers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                plan_id INT NOT NULL,
                ptero_server_id INT,
                ptero_identifier VARCHAR(255),
                server_name VARCHAR(255) DEFAULT NULL,
                location_id INT DEFAULT NULL,
                status VARCHAR(50) DEFAULT 'active',
                failure_reason TEXT DEFAULT NULL,
                renewal_date DATETIME,
                suspended_at DATETIME DEFAULT NULL,
                currency_code VARCHAR(10) DEFAULT 'USD',
                radar_status ENUM('safe', 'warning', 'danger') DEFAULT 'safe',
                radar_last_scan DATETIME DEFAULT NULL,
                radar_details LONGTEXT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (plan_id) REFERENCES Plans(id)
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                subject VARCHAR(255) NOT NULL,
                status ENUM('open', 'awaiting_reply', 'in_progress', 'awaiting_customer', 'resolved', 'closed') DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS ticket_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                user_id INT NOT NULL,
                message TEXT NOT NULL,
                attachment VARCHAR(255) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                setting_key VARCHAR(255) NOT NULL UNIQUE,
                setting_value TEXT
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS broadcast_logs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                admin_id INT NOT NULL,
                admin_username VARCHAR(255),
                subject VARCHAR(500),
                email_type ENUM('announcement', 'maintenance', 'urgent') DEFAULT 'announcement',
                recipient_type ENUM('all', 'active', 'admins') DEFAULT 'all',
                recipients_count INT DEFAULT 0,
                sent_count INT DEFAULT 0,
                failed_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS canned_responses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(100) NOT NULL,
                message TEXT NOT NULL
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS locations (
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
                latency INT DEFAULT NULL,
                last_ping DATETIME DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS currencies (
                code VARCHAR(3) PRIMARY KEY,
                symbol VARCHAR(5) NOT NULL,
                rate_to_usd DECIMAL(10, 4) NOT NULL DEFAULT 1.0000,
                is_active BOOLEAN DEFAULT TRUE
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS payment_gateways (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(50) NOT NULL UNIQUE,
                display_name VARCHAR(100),
                enabled BOOLEAN DEFAULT FALSE,
                config LONGTEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS invoices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                plan_id INT,
                server_id INT,
                amount DECIMAL(10, 2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                currency_code VARCHAR(10) DEFAULT 'USD',
                currency_amount DECIMAL(10, 2),
                status VARCHAR(50) DEFAULT 'pending',
                type VARCHAR(50) DEFAULT 'purchase',
                payment_method VARCHAR(50),
                transaction_id VARCHAR(255),
                billing_name VARCHAR(255),
                billing_address TEXT,
                billing_gst VARCHAR(50),
                gst_number VARCHAR(50),
                description TEXT,
                notes TEXT,
                subtotal DECIMAL(10, 2),
                tax_rate DECIMAL(5, 2) DEFAULT 0.00,
                tax_amount DECIMAL(10, 2) DEFAULT 0.00,
                due_date DATETIME,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                paid_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (plan_id) REFERENCES Plans(id) ON DELETE SET NULL
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS plan_prices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                plan_id INT NOT NULL,
                currency_code VARCHAR(3) NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                FOREIGN KEY (plan_id) REFERENCES Plans(id) ON DELETE CASCADE,
                FOREIGN KEY (currency_code) REFERENCES currencies(code) ON DELETE CASCADE
            )
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS coupons (
                id INT AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(50) NOT NULL UNIQUE,
                discount_percent DECIMAL(5, 2) NOT NULL,
                max_uses INT DEFAULT 0,
                uses INT DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Affiliate System Tables
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

        // Add referred_by column to users if not exists
        const columns = await conn.query("SHOW COLUMNS FROM users LIKE 'referred_by'");
        if (!columns || columns.length === 0) {
            await conn.query("ALTER TABLE users ADD COLUMN referred_by INT NULL DEFAULT NULL");
        }

        // Insert default settings
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('enable_email_verification', 'false')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('maintenance', 'false')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('debug_mode', 'true')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('radar_enabled', 'false')");

        // Affiliate default settings
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('affiliate_enabled', 'false')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('affiliate_default_commission', '10.00')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('affiliate_min_payout', '10.00')");
        await conn.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('affiliate_cookie_days', '30')");

        // console.log("Database tables created successfully!"); // Reduce noise
    } catch (err) {
        console.error("Error creating tables:", err);
        throw err; // Propagate error!
    } finally {
        if (localConn && conn) conn.release();
        if (localConn) process.exit(0); // Only exit if running standalone
    }
}

// Support both standalone and imported usage
if (require.main === module) {
    setup();
}

module.exports = setup;
