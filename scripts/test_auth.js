const axios = require('axios');
const db = require('../config/database');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const jar = new CookieJar();
const client = wrapper(axios.create({ jar, baseURL: 'http://localhost:3000', maxRedirects: 0, validateStatus: null })); // Disable redirects to check headers

async function testAuthFlow() {
    const testUser = `test_${Date.now()}`;
    const email = `${testUser}@example.com`;
    const password = 'password123';

    console.log(`Starting test for user: ${testUser}`);

    try {
        // 1. Register
        console.log("Step 1: Registering...");
        let res = await client.post('/auth/register', {
            username: testUser,
            email: email,
            password: password
        });

        if (res.status !== 302 || res.headers.location !== '/auth/verify') {
            console.error("FAILED: Registration did not redirect to /auth/verify");
            console.error("Status:", res.status);
            console.error("Location:", res.headers.location);
            // console.error("Body:", res.data);
            process.exit(1);
        }
        console.log("PASS: Redirected to /auth/verify");

        // 2. Get Code
        console.log("Step 2: Retrieving code from DB...");
        const conn = await db.getConnection();
        const rows = await conn.query("SELECT verification_code, is_verified FROM users WHERE email = ?", [email]);
        conn.release();

        if (rows.length === 0) {
            console.error("FAILED: User not found in DB");
            process.exit(1);
        }
        const user = rows[0];
        console.log(`User found. Verified: ${user.is_verified}. Code: ${user.verification_code}`);

        if (user.is_verified) {
            console.error("FAILED: User initially verified (should be false)");
            process.exit(1);
        }

        // 3. Verify
        console.log("Step 3: Verifying...");
        res = await client.post('/auth/verify', {
            code: user.verification_code
        });

        if (res.status !== 302 || res.headers.location !== '/auth/login') {
            console.error("FAILED: Verification did not redirect to /auth/login");
            console.error("Status:", res.status);
            console.error("Location:", res.headers.location);
            // console.error("Body:", res.data); // Likely flash message
            process.exit(1);
        }
        console.log("PASS: Redirected to /auth/login");

        // 4. Check DB status
        const conn2 = await db.getConnection();
        const rows2 = await conn2.query("SELECT is_verified FROM users WHERE email = ?", [email]);
        conn2.release();
        if (!rows2[0].is_verified) {
            console.error("FAILED: User still not verified in DB");
            process.exit(1);
        }
        console.log("PASS: User is verified in DB");

        // 5. Login
        console.log("Step 5: Logging in...");
        res = await client.post('/auth/login', {
            email: email,
            password: password
        });

        if (res.status !== 302) {
            console.error("FAILED: Login did not redirect");
            console.error("Status:", res.status);
            process.exit(1);
        }

        // Check if redirected to dashboard or admin (first user is admin, subsequents are dashboard)
        // Since we created random user, likely not first.
        const location = res.headers.location;
        if (location !== '/dashboard' && location !== '/admin') {
            console.error("FAILED: Login redirected to unexpected location:", location);
            process.exit(1);
        }
        console.log(`PASS: Login successful (redirected to ${location})`);

        console.log("ALL TESTS PASSED");
        process.exit(0);

    } catch (err) {
        console.error("Test Error:", err);
        process.exit(1);
    }
}

testAuthFlow();
