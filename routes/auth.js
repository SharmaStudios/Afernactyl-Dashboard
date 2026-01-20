const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcrypt');
const crypto = require('crypto'); // for gravatar
const emailService = require('../services/email');
const authService = require('../services/authService');
const passport = authService.passport;
// db is already imported at the top

// --- Dynamic OAuth Routes ---

// Helper: Check if provider is enabled
const checkSpecificProvider = (providerKey) => {
    return async (req, res, next) => {
        try {
            const conn = await db.getConnection();
            const [setting] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = ?", [providerKey]);
            conn.release();

            const isEnabled = setting && setting.setting_value === 'true';

            // Map setting key to passport strategy name
            const strategyMap = {
                'oauth_github_enabled': 'github',
                'oauth_discord_enabled': 'discord',
                'oauth_google_enabled': 'google',
                'oauth_apple_enabled': 'apple'
            };
            const strategyName = strategyMap[providerKey];
            const isLoaded = passport._strategies[strategyName];

            if (isEnabled && isLoaded) {
                next();
            } else {
                let msg = 'This login method is currently disabled.';
                if (isEnabled && !isLoaded) {
                    msg = 'This login method is enabled but not configured correctly on the server.';
                    console.error(`[Auth] Strategy ${strategyName} is enabled in settings but NOT loaded in Passport.`);
                }
                req.flash('error_msg', msg);
                res.redirect('/auth/login');
            }
        } catch (err) {
            console.error(err);
            res.redirect('/auth/login');
        }
    };
};

const handleOAuthCallback = (req, res) => {
    if (!req.user) {
        req.flash('error_msg', 'Authentication failed.');
        return res.redirect('/auth/login');
    }

    // Set session user
    req.session.user = {
        id: req.user.id,
        username: req.user.username,
        first_name: req.user.first_name,
        last_name: req.user.last_name,
        email: req.user.email,
        is_admin: !!req.user.is_admin,
        gravatar: req.user.avatar || 'https://www.gravatar.com/avatar/' + crypto.createHash('md5').update(req.user.email.trim().toLowerCase()).digest('hex') + '?d=mp&s=80'
    };

    req.flash('success_msg', 'Logged in successfully via Social Media');
    if (req.user.is_admin) {
        res.redirect('/admin');
    } else {
        res.redirect('/dashboard');
    }
};

// GitHub
router.get('/github', checkSpecificProvider('oauth_github_enabled'), passport.authenticate('github', { scope: ['user:email'] }));
router.get('/github/callback',
    passport.authenticate('github', { failureRedirect: '/auth/login', failureFlash: true }),
    handleOAuthCallback
);

// Discord
router.get('/discord', checkSpecificProvider('oauth_discord_enabled'), (req, res, next) => {
    passport.authenticate('discord')(req, res, next);
});
router.get('/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/auth/login', failureFlash: true }),
    handleOAuthCallback
);

// Google
router.get('/google', checkSpecificProvider('oauth_google_enabled'), passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback',
    passport.authenticate('google', { failureRedirect: '/auth/login', failureFlash: true }),
    handleOAuthCallback
);

// Apple
router.get('/apple', checkSpecificProvider('oauth_apple_enabled'), passport.authenticate('apple'));
router.post('/apple/callback',
    passport.authenticate('apple', { failureRedirect: '/auth/login', failureFlash: true }),
    handleOAuthCallback
);

// Register Page
router.get('/register', (req, res) => {
    res.render('auth/register');
});

// Register Logic
router.post('/register', async (req, res) => {
    const { first_name, last_name, username, email, password } = req.body;

    // Validation
    if (!first_name || !last_name || !username || !email || !password) {
        req.flash('error_msg', 'Please fill in all fields');
        return res.redirect('/auth/register');
    }

    try {
        const conn = await db.getConnection();

        // Check if user exists
        const existing = await conn.query("SELECT * FROM users WHERE email = ? OR username = ?", [email, username]);
        if (existing.length > 0) {
            conn.release();
            req.flash('error_msg', 'User already exists');
            return res.redirect('/auth/register');
        }

        // Check if first user (make admin)
        const allUsers = await conn.query("SELECT count(*) as count FROM users");
        const isAdmin = (Number(allUsers[0].count) === 0);

        // Hash Password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Geo-detect country from IP
        let country = null;
        let preferredCurrency = 'USD';

        try {
            const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection.remoteAddress;
            const cleanIp = ip ? ip.replace('::ffff:', '').trim() : '';

            // ... (GEO logic preserved, skipping bulky copy-paste)
            if (cleanIp && !cleanIp.startsWith('127.') && !cleanIp.startsWith('192.168.') && !cleanIp.startsWith('10.') && !cleanIp.startsWith('172.') && cleanIp !== '::1' && cleanIp !== 'localhost') {
                const http = require('http');
                const geoData = await new Promise((resolve) => {
                    http.get(`http://ip-api.com/json/${cleanIp}?fields=status,countryCode`, (resp) => {
                        let data = '';
                        resp.on('data', chunk => data += chunk);
                        resp.on('end', () => {
                            try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
                        });
                    }).on('error', () => resolve({}));
                });

                if (geoData.status === 'success' && geoData.countryCode) {
                    country = geoData.countryCode;
                    const currencyMap = {
                        'IN': 'INR', 'US': 'USD', 'GB': 'GBP', 'EU': 'EUR',
                        'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR', 'NL': 'EUR',
                        'AU': 'AUD', 'CA': 'CAD', 'JP': 'JPY', 'CN': 'CNY',
                        'BR': 'BRL', 'MX': 'MXN', 'RU': 'RUB', 'KR': 'KRW',
                        'SG': 'SGD', 'AE': 'AED', 'ZA': 'ZAR', 'PH': 'PHP'
                    };
                    preferredCurrency = currencyMap[country] || 'USD';
                }
            }
        } catch (geoErr) {
            console.error('[GEO] Detection error:', geoErr.message);
        }

        // Check Settings
        const settingsRows = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'enable_email_verification'");
        const emailVerificationEnabled = settingsRows.length > 0 ? settingsRows[0].setting_value === 'true' : true;

        if (emailVerificationEnabled) {
            // Affiliate Check - Use form field instead of cookie
            let referredBy = null;
            const referralCode = req.body.referral_code?.trim();
            if (referralCode) {
                const [affiliate] = await conn.query("SELECT id FROM affiliates WHERE referral_code = ? AND is_active = 1", [referralCode]);
                if (affiliate) {
                    referredBy = affiliate.id;
                }
            }

            // Insert User with verification data
            const result1 = await conn.query("INSERT INTO users (username, first_name, last_name, email, password, is_admin, country, preferred_currency, is_verified, verification_code, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [username, first_name, last_name, email, hashedPassword, isAdmin, country, preferredCurrency, false, verificationCode, referredBy]);

            const newUserId = result1.insertId;
            if (referredBy) {
                await conn.query("INSERT INTO referrals (affiliate_id, referred_user_id, status) VALUES (?, ?, 'active')", [referredBy, newUserId]);
            }

            conn.release();

            // Send Verification Email
            await emailService.sendEmail(email, 'Verify your email address', 'verify', { code: verificationCode });

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.userRegistered({ id: Number(result1.insertId), username, email });
            } catch (e) { console.error('[Discord]', e.message); }

            // Store email in session for verification page
            req.session.pending_verification_email = email;

            req.flash('success_msg', 'Registration successful! Please verify your email.');
            res.redirect('/auth/verify');
        } else {
            // Affiliate Check - Use form field instead of cookie
            let referredBy = null;
            const referralCode = req.body.referral_code?.trim();
            if (referralCode) {
                const [affiliate] = await conn.query("SELECT id FROM affiliates WHERE referral_code = ? AND is_active = 1", [referralCode]);
                if (affiliate) {
                    referredBy = affiliate.id;
                }
            }

            // Auto-verify
            const result2 = await conn.query("INSERT INTO users (username, first_name, last_name, email, password, is_admin, country, preferred_currency, is_verified, verification_code, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [username, first_name, last_name, email, hashedPassword, isAdmin, country, preferredCurrency, true, null, referredBy]);

            const newUserId = result2.insertId;
            if (referredBy) {
                await conn.query("INSERT INTO referrals (affiliate_id, referred_user_id, status) VALUES (?, ?, 'active')", [referredBy, newUserId]);
            }

            conn.release();

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.userRegistered({ id: Number(result2.insertId), username, email });
            } catch (e) { console.error('[Discord]', e.message); }

            req.flash('success_msg', 'You are now registered and can log in');
            res.redirect('/auth/login');
        }

    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Registration failed');
        res.redirect('/auth/register');
    }
});

// Verify Page
router.get('/verify', (req, res) => {
    res.render('auth/verify');
});

// Process Verification
router.post('/verify', async (req, res) => {
    const { code } = req.body;
    const email = req.session.pending_verification_email;

    if (!email) {
        req.flash('error_msg', 'Session expired. Please login to verify.');
        return res.redirect('/auth/login');
    }

    try {
        const conn = await db.getConnection();
        const users = await conn.query("SELECT * FROM users WHERE email = ?", [email]);

        if (users.length === 0) {
            conn.release();
            req.flash('error_msg', 'User not found');
            return res.redirect('/auth/register');
        }

        const user = users[0];

        if (user.verification_code === code) {
            await conn.query("UPDATE users SET is_verified = TRUE, verification_code = NULL WHERE id = ?", [user.id]);
            conn.release();
            delete req.session.pending_verification_email;
            req.flash('success_msg', 'Email verified! You can now login.');
            res.redirect('/auth/login');
        } else {
            conn.release();
            req.flash('error_msg', 'Invalid verification code');
            res.redirect('/auth/verify');
        }
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Verification failed');
        res.redirect('/auth/verify');
    }
});

// Resend Verification
router.get('/resend-verification', async (req, res) => {
    const email = req.session.pending_verification_email;
    if (!email) {
        req.flash('error_msg', 'Session expired. Please login.');
        return res.redirect('/auth/login');
    }

    try {
        const verificationCode = crypto.randomInt(100000, 999999).toString();
        const conn = await db.getConnection();
        await conn.query("UPDATE users SET verification_code = ? WHERE email = ?", [verificationCode, email]);
        conn.release();

        await emailService.sendEmail(email, 'Verify your email address', 'verify', { code: verificationCode });
        req.flash('success_msg', 'Verification code resent.');
        res.redirect('/auth/verify');
    } catch (err) {
        console.error(err);
        res.redirect('/auth/verify');
    }
});

// Login Page
router.get('/login', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const settingsRows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'oauth_%_enabled'");
        conn.release();

        const oauth = {
            github: false,
            discord: false,
            google: false,
            apple: false
        };

        settingsRows.forEach(row => {
            if (row.setting_key === 'oauth_github_enabled') oauth.github = (row.setting_value === 'true');
            if (row.setting_key === 'oauth_discord_enabled') oauth.discord = (row.setting_value === 'true');
            if (row.setting_key === 'oauth_google_enabled') oauth.google = (row.setting_value === 'true');
            if (row.setting_key === 'oauth_apple_enabled') oauth.apple = (row.setting_value === 'true');
        });

        res.render('auth/login', { oauth });
    } catch (err) {
        console.error(err);
        res.render('auth/login', { oauth: { github: false, discord: false, google: false, apple: false } });
    }
});

// Login Logic
router.post('/login', async (req, res) => {
    const { identifier, password } = req.body;

    try {
        const conn = await db.getConnection();
        // Search by username OR email
        const users = await conn.query("SELECT * FROM users WHERE email = ? OR username = ?", [identifier, identifier]);

        if (users.length === 0) {
            conn.release();
            req.flash('error_msg', 'User not found');
            return res.redirect('/auth/login');
        }

        const user = users[0];
        const match = await bcrypt.compare(password, user.password);

        if (match) {
            // Check Settings for verification requirement
            const settingsRows = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'enable_email_verification'");
            conn.release();
            const emailVerificationEnabled = settingsRows.length > 0 ? settingsRows[0].setting_value === 'true' : true;

            if (emailVerificationEnabled && !user.is_verified) {
                req.session.pending_verification_email = user.email;
                req.flash('error_msg', 'Please verify your email address.');
                return res.redirect('/auth/verify');
            }

            req.session.user = {
                id: user.id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                email: user.email,
                is_admin: !!user.is_admin,
                gravatar: 'https://www.gravatar.com/avatar/' + crypto.createHash('md5').update(user.email.trim().toLowerCase()).digest('hex') + '?d=mp&s=80'
            };
            req.flash('success_msg', 'Logged in successfully');
            if (user.is_admin) {
                res.redirect('/admin');
            } else {
                res.redirect('/dashboard');
            }
        } else {
            conn.release();
            req.flash('error_msg', 'Incorrect password');
            res.redirect('/auth/login');
        }

    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Login Error');
        res.redirect('/auth/login');
    }
});

// Forgot Password Page
router.get('/reset-password', (req, res) => {
    res.render('auth/forgot_password');
});

// Process Forgot Password
router.post('/reset-password', async (req, res) => {
    const { email } = req.body;
    try {
        const conn = await db.getConnection();
        const users = await conn.query("SELECT * FROM users WHERE email = ?", [email]);

        if (users.length > 0) {
            const token = crypto.randomBytes(20).toString('hex');
            const expires = new Date(Date.now() + 3600000); // 1 hour

            await conn.query("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?", [token, expires, users[0].id]);

            // Send Email
            const link = `http://${req.headers.host}/auth/reset/${token}`;
            await emailService.sendEmail(email, 'Password Reset', 'reset', { link: link });

            req.flash('success_msg', 'Reset link sent to email.');
        } else {
            req.flash('error_msg', 'Email not found.');
        }

        conn.release();
        res.redirect('/auth/login');
    } catch (err) {
        console.error(err);
        res.redirect('/auth/reset-password');
    }
});

// Reset Page
router.get('/reset/:token', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const users = await conn.query("SELECT * FROM users WHERE reset_token = ? AND reset_expires > NOW()", [req.params.token]);
        conn.release();

        if (users.length === 0) {
            req.flash('error_msg', 'Token invalid or expired');
            return res.redirect('/auth/login');
        }
        res.render('auth/reset', { token: req.params.token });
    } catch (err) {
        console.error(err);
        res.redirect('/auth/login');
    }
});

// Process Reset
router.post('/reset/:token', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const users = await conn.query("SELECT * FROM users WHERE reset_token = ? AND reset_expires > NOW()", [req.params.token]);

        if (users.length === 0) {
            conn.release();
            req.flash('error_msg', 'Token invalid or expired');
            return res.redirect('/auth/login');
        }

        const hashedPassword = await bcrypt.hash(req.body.password, 10);
        await conn.query("UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?", [hashedPassword, users[0].id]);
        conn.release();

        req.flash('success_msg', 'Password updated!');
        res.redirect('/auth/login');
    } catch (err) {
        console.error(err);
        res.redirect('/auth/login');
    }
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/auth/login');
});

module.exports = router;
