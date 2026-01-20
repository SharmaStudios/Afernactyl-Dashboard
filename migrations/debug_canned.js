const db = require('../config/database');

async function checkCanned() {
    try {
        const conn = await db.getConnection();
        const rows = await conn.query("SELECT * FROM canned_responses");
        console.log("Canned Responses Count:", rows.length);
        console.log(rows);
        conn.release();
        // process.exit();
    } catch (err) {
        console.error(err);
        // process.exit(1);
    }
}

if (require.main === module) {
    checkCanned();
}

module.exports = checkCanned;
