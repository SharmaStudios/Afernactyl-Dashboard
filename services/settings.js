const db = require('../config/database');

const SettingsService = {
    /**
     * Get a setting by key
     * @param {string} key 
     * @returns {Promise<string|null>}
     */
    async get(key) {
        let conn;
        try {
            conn = await db.getConnection();
            const rows = await conn.query("SELECT setting_value FROM settings WHERE setting_key = ?", [key]);
            if (rows.length > 0) {
                return rows[0].setting_value;
            }
            return null;
        } catch (err) {
            console.error(`Error fetching setting ${key}:`, err);
            return null;
        } finally {
            if (conn) conn.release();
        }
    },

    /**
     * Set a setting (insert or update)
     * @param {string} key 
     * @param {string} value 
     * @returns {Promise<boolean>}
     */
    async set(key, value) {
        let conn;
        try {
            conn = await db.getConnection();
            await conn.query(`
                INSERT INTO settings (setting_key, setting_value) 
                VALUES (?, ?) 
                ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
            `, [key, value]);
            return true;
        } catch (err) {
            console.error(`Error setting ${key}:`, err);
            return false;
        } finally {
            if (conn) conn.release();
        }
    },

    /**
     * Delete a setting
     * @param {string} key 
     * @returns {Promise<boolean>}
     */
    async delete(key) {
        let conn;
        try {
            conn = await db.getConnection();
            await conn.query("DELETE FROM settings WHERE setting_key = ?", [key]);
            return true;
        } catch (err) {
            console.error(`Error deleting setting ${key}:`, err);
            return false;
        } finally {
            if (conn) conn.release();
        }
    },

    /**
     * Get all settings that start with a prefix
     * @param {string} prefix 
     * @returns {Promise<Object>} Object with key-value pairs (prefix removed from keys)
     */
    async getPrivilegedSettings(prefix = 'theme_') {
        let conn;
        try {
            conn = await db.getConnection();
            const rows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE ?", [`${prefix}%`]);

            const settings = {};
            rows.forEach(row => {
                // Remove prefix for cleaner usage in objects
                const cleanKey = row.setting_key;
                settings[cleanKey] = row.setting_value;
            });

            return settings;
        } catch (err) {
            console.error(`Error fetching settings with prefix ${prefix}:`, err);
            return {};
        } finally {
            if (conn) conn.release();
        }
    }
};

module.exports = SettingsService;
