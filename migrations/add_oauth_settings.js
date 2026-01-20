const db = require('../config/database');

async function migrate(conn) {
    let localConn = false;
    if (!conn) {
        conn = await db.getConnection();
        localConn = true;
    }

    try {
        const keys = [
            'oauth_github_enabled', 'oauth_github_client_id', 'oauth_github_client_secret',
            'oauth_discord_enabled', 'oauth_discord_client_id', 'oauth_discord_client_secret',
            'oauth_google_enabled', 'oauth_google_client_id', 'oauth_google_client_secret',
            'oauth_apple_enabled', 'oauth_apple_client_id', 'oauth_apple_client_secret',
            'discord_webhook_url'
        ];

        for (const key of keys) {
            // Check if exists
            const [rows] = await conn.query("SELECT setting_key FROM settings WHERE setting_key = ?", [key]);
            if (!rows) {
                let defaultVal = 'false';
                if (key.endsWith('_id') || key.endsWith('_secret') || key.endsWith('_url')) defaultVal = '';

                await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)", [key, defaultVal]);
                console.log(`Added setting: ${key}`);
            }
        }
    } catch (err) {
        console.error("Migration failed:", err);
        throw err;
    } finally {
        if (localConn && conn) conn.release();
    }
}

if (require.main === module) {
    migrate().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = migrate;
