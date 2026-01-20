const m = require("mariadb"); const o = require("os"); const c = require("crypto"); require("dotenv").config(); const p = m.createPool({ host: process.env.DB_HOST || "localhost", user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME || "afernactyl_dashboard", connectionLimit: 20, acquireTimeout: 30e3, idleTimeout: 6e4 });
// Hardware ID generation
const h = c.createHash("sha256").update(o.hostname() + o.homedir() + o.platform()).digest("hex");

module.exports = {
    getConnection: async () => {
        try {
            const e = await p.getConnection();
            if (!module.exports.v) {
                // Strict Lockout: ALWAYS verify key, no bypass for migrations
                try {
                    const l = await e.query("SELECT setting_value FROM settings WHERE setting_key = 'installation_lock'");
                    const t = await e.query("SELECT setting_value FROM settings WHERE setting_key = 'db_protection_key'");

                    // Verify Key
                    // IF key exists in DB, it MUST match .env
                    // IF key is missing in DB (t.length === 0), we ALLOW it (Install/Recovery Mode)
                    if (t.length > 0 && t[0].setting_value !== process.env.SESSION_SECRET) {
                        throw new Error("KEY_MISMATCH");
                    }

                    // Verify Hardware Lock
                    let currentLock = l.length > 0 ? l[0].setting_value : null;
                    if (!currentLock) {
                        // First run (should be safe to set if key matched)
                        await e.query("INSERT INTO settings (setting_key, setting_value) VALUES ('installation_lock', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [h, h]);
                    } else if (currentLock !== h) {
                        throw new Error("HW_MISMATCH");
                    }
                    module.exports.v = !0;

                } catch (err) {
                    // Check specifically for Table doesn't exist (Setup phase)
                    if (err.code === 'ER_NO_SUCH_TABLE') {
                        // Allow proceeding for setup_db.js to run
                        return e;
                    }

                    // FATAL ERRORS - COMPLETE LOCKOUT
                    if (err.message === "KEY_MISMATCH") {
                        console.error("\x1b[41m\x1b[37mFATAL ERROR: DATABASE PROTECTION KEY MISMATCH.\x1b[0m");
                        console.error("Access denied. Key missing or invalid.");
                        console.error("TIP: If you verified your .env, please CLEAR YOUR DATABASE and run migrations again.");
                    } else if (err.message === "HW_MISMATCH") {
                        console.error("\x1b[41m\x1b[37mSECURITY ALERT: HARDWARE MISMATCH DETECTED.\x1b[0m");
                        console.error("This dashboard instance cannot run on this machine.");
                    } else {
                        console.error("Database connection security check failed:", err);
                    }

                    // Force exit to prevent any usage
                    process.exit(1);
                }
            }
            return e;
        } catch (e) { throw e }
    },
    v: !1,
    pool: p,
    endPool: async () => {
        if (p) await p.end();
    }
};
