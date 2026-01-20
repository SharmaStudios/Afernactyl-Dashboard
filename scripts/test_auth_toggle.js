const axios = require('axios');
const db = require('../config/database');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const jar = new CookieJar();
const client = wrapper(axios.create({ jar, baseURL: 'http://localhost:3000', maxRedirects: 0, validateStatus: null }));

async function testToggleFlow() {
    const testUser = `toggle_test_${Date.now()}`;
    const email = `${testUser}@example.com`;
    const password = 'password123';
    let conn;

    console.log(`Starting toggle test for user: ${testUser}`);

    try {
        conn = await db.getConnection();

        // 0. Disable Email Verification
        console.log("Step 0: Disabling email verification...");
        await conn.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'enable_email_verification'");

        // 1. Register
        console.log("Step 1: Registering...");
        let res = await client.post('/auth/register', {
            username: testUser,
            email: email,
            password: password
        });

        // Should redirect to login immediately (or dashboard if auto-login, but our logic redirects to login)
        if (res.status !== 302 || res.headers.location !== '/auth/login') {
            console.error("FAILED: Registration did not redirect to /auth/login");
            console.error("Status:", res.status);
            console.error("Location:", res.headers.location);
            process.exit(1);
        }
        console.log("PASS: Redirected to /auth/login (Verification skipped)");

        // 2. Check DB status
        const rows = await conn.query("SELECT is_verified, verification_code FROM users WHERE email = ?", [email]);
        if (rows.length === 0) {
            console.error("FAILED: User not found in DB");
            process.exit(1);
        }
        const user = rows[0];

        if (!user.is_verified) {
            console.error("FAILED: User should be auto-verified");
            process.exit(1);
        }
        console.log("PASS: User is auto-verified in DB");

        // 3. Restore Setting
        console.log("Step 3: Restoring setting...");
        await conn.query("UPDATE settings SET setting_value = 'true' WHERE setting_key = 'enable_email_verification'");

        console.log("ALL TESTS PASSED");
        process.exit(0);

    } catch (err) {
        console.error("Test Error:", err);
        // Try to restore setting if failed
        if (conn) {
            try { await conn.query("UPDATE settings SET setting_value = 'true' WHERE setting_key = 'enable_email_verification'"); } catch (e) { }
        }
        process.exit(1);
    } finally {
        if (conn) conn.release();
    }
}

testToggleFlow();
