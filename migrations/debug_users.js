const db = require('../config/database');

async function checkUsers() {
    try {
        const conn = await db.getConnection();
        const users = await conn.query("SELECT id, username, email, is_admin FROM users");
        console.log(users);
        conn.release();
        // process.exit();
    } catch (err) {
        console.error(err);
        // process.exit(1);
    }
}

if (require.main === module) {
    checkUsers();
}

module.exports = checkUsers;
