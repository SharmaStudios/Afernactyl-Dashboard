const db = require('../config/database');

async function clearDatabase() {
    let conn;
    try {
        console.log('Connecting to database...');
        conn = await db.getConnection();

        console.log('Fetching tables...');
        const tables = await conn.query("SHOW TABLES");

        if (tables.length === 0) {
            console.log('Database is already empty.');
            return;
        }

        console.log(`Found ${tables.length} tables. Clearing...`);

        await conn.query("SET FOREIGN_KEY_CHECKS = 0");

        for (const row of tables) {
            const tableName = Object.values(row)[0];
            console.log(`Dropping table: ${tableName}`);
            await conn.query(`DROP TABLE IF EXISTS \`${tableName}\``);
        }

        await conn.query("SET FOREIGN_KEY_CHECKS = 1");

        console.log('Database cleared successfully!');
    } catch (err) {
        console.error('Error clearing database:', err);
    } finally {
        if (conn) conn.release();
        if (db.endPool) await db.endPool();
        process.exit(0);
    }
}

clearDatabase();
