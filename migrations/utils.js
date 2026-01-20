const db = require('../config/database');

/**
 * Safely adds a column to a table if it doesn't exist.
 * @param {Object} conn - Database connection
 * @param {string} table - Table name
 * @param {string} column - Column name
 * @param {string} definition - Column definition (e.g., "INT DEFAULT 0")
 */
async function safeAddColumn(conn, table, column, definition) {
    try {
        // Check if column exists
        const [exists] = await conn.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME = ? 
            AND COLUMN_NAME = ?
        `, [table, column]);

        if (exists) {
            // Silently skip
            return false;
        }

        // Add column
        await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        return true;
    } catch (err) {
        // If race condition or other error, log debug but don't fail hard if it's "Duplicate column"
        if (err.code === 'ER_DUP_FIELDNAME' || err.code === '42S21') {
            return false;
        }
        throw err;
    }
}

/**
 * Safely drops a column from a table if it exists.
 * @param {Object} conn - Database connection
 * @param {string} table - Table name
 * @param {string} column - Column name
 */
async function safeDropColumn(conn, table, column) {
    try {
        await conn.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        return true;
    } catch (err) {
        if (err.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
            return false;
        }
        throw err;
    }
}

module.exports = {
    safeAddColumn,
    safeDropColumn
};
