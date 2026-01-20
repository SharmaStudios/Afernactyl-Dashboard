
const db = require('../config/database');
async function run() {
    let conn;
    try {
        conn = await db.getConnection();
        const rows = await conn.query("SHOW COLUMNS FROM active_servers");
        console.log(JSON.stringify(rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        if (conn) conn.release();
        // process.exit();
    }
}
if (require.main === module) {
    run();
}

module.exports = run;
