const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const AppleStrategy = require('passport-apple'); // Requires handling for key files usually, keeping simple for now
const db = require('../config/database');
const bcrypt = require('bcrypt');

// Serialize/Deserialize
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const conn = await db.getConnection();
        const users = await conn.query("SELECT * FROM users WHERE id = ?", [id]);
        conn.release();
        if (users.length > 0) {
            done(null, users[0]);
        } else {
            done(new Error("User not found"), null);
        }
    } catch (err) {
        done(err, null);
    }
});

// Helper: Handle Social Login
async function handleSocialLogin(req, accessToken, refreshToken, profile, done, providerField) {
    let conn;
    try {
        conn = await db.getConnection();
        const email = profile.email ||
            (profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null) ||
            (profile._json && profile._json.email ? profile._json.email : null);

        console.log(`[Auth] Profile Debug: Provider=${providerField}, Extracted Email=${email}`);
        if (!email) console.log(`[Auth] Full Profile Data for Debug:`, JSON.stringify(profile, null, 2));

        // 1. Check by Social ID
        let users = await conn.query(`SELECT * FROM users WHERE ${providerField} = ?`, [profile.id]);

        if (users.length > 0) {
            const user = users[0];
            // If existing user has a placeholder email and we found a real one now, update it
            if (user.email.includes('@no-email.com') && email) {
                await conn.query("UPDATE users SET email = ?, avatar = COALESCE(avatar, ?) WHERE id = ?", [email, profile.photos ? profile.photos[0].value : null, user.id]);
                user.email = email;
            }
            conn.release();
            return done(null, user);
        }

        // 2. Check by Email (Link)
        if (email) {
            users = await conn.query("SELECT * FROM users WHERE email = ?", [email]);
            if (users.length > 0) {
                await conn.query(`UPDATE users SET ${providerField} = ?, avatar = COALESCE(avatar, ?) WHERE id = ?`,
                    [profile.id, profile.photos ? profile.photos[0].value : null, users[0].id]);
                const updatedUser = { ...users[0], [providerField]: profile.id };
                conn.release();
                return done(null, updatedUser);
            }
        }

        // 3. Create New User
        const randomPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        const username = profile.username || (email ? email.split('@')[0] : `user_${Math.floor(Math.random() * 10000)}`);

        const avatar = profile.photos ? profile.photos[0].value : null;
        const firstName = profile.name ? profile.name.givenName : (profile.displayName ? profile.displayName.split(' ')[0] : 'User');
        const lastName = profile.name ? profile.name.familyName : (profile.displayName ? profile.displayName.split(' ').slice(1).join(' ') : 'Name');

        // Affiliate Check (Social Login)
        let referredBy = null;
        if (req && req.cookies && req.cookies.affiliate_ref) {
            const [affiliate] = await conn.query("SELECT id FROM affiliates WHERE referral_code = ? AND is_active = 1", [req.cookies.affiliate_ref]);
            if (affiliate) {
                referredBy = affiliate.id;
            }
        }

        const result = await conn.query(
            "INSERT INTO users (username, email, password, first_name, last_name, " + providerField + ", avatar, is_verified, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?)",
            [username, email || `${profile.id}@no-email.com`, hashedPassword, firstName, lastName, profile.id, avatar, referredBy]
        );

        const newUserId = Number(result.insertId);
        if (referredBy) {
            await conn.query("INSERT INTO referrals (affiliate_id, referred_user_id, status) VALUES (?, ?, 'active')", [referredBy, newUserId]);
        }

        const newUser = {
            id: newUserId,
            username,
            email: email || `${profile.id}@no-email.com`,
            is_admin: false
        };

        conn.release();
        return done(null, newUser);
    } catch (err) {
        if (conn) conn.release();
        return done(err, null);
    }
}

// Dynamic Strategy Loader
const loadStrategies = async () => {
    let conn;
    try {
        conn = await db.getConnection();
        const settingsRows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'oauth_%' OR setting_key = 'site_url'");
        conn.release();

        const settings = {};
        settingsRows.forEach(row => {
            settings[row.setting_key] = row.setting_value;
        });

        const baseUrl = (settings.site_url || process.env.SITE_URL || '').replace(/\/$/, '');
        if (!baseUrl) console.warn('[Auth] site_url is not set in settings or .env. OAuth callbacks will likely fail.');

        // Unuse existing strategies to prevent duplicates/errors on reload
        passport.unuse('github');
        passport.unuse('discord');
        passport.unuse('google');
        passport.unuse('apple');

        // GitHub
        if (settings.oauth_github_enabled === 'true' && settings.oauth_github_client_id && settings.oauth_github_client_secret) {
            const githubCallback = baseUrl ? `${baseUrl}/auth/github/callback` : "/auth/github/callback";
            passport.use(new GitHubStrategy({
                clientID: settings.oauth_github_client_id.trim(),
                clientSecret: settings.oauth_github_client_secret.trim(),
                callbackURL: githubCallback,
                scope: ['user:email'],
                passReqToCallback: true
            }, (req, accessToken, refreshToken, profile, done) => handleSocialLogin(req, accessToken, refreshToken, profile, done, 'github_id')));
            console.log(`[Auth] GitHub Strategy Loaded. Callback: ${githubCallback}`);
        } else if (settings.oauth_github_enabled === 'true') {
            console.warn('[Auth] GitHub strategy enabled but missing Client ID or Secret.');
        }

        // Discord
        if (settings.oauth_discord_enabled === 'true' && settings.oauth_discord_client_id && settings.oauth_discord_client_secret) {
            const discordCallback = baseUrl ? `${baseUrl}/auth/discord/callback` : "/auth/discord/callback";
            console.log(`[Auth] Configuring Discord Strategy with Callback: ${discordCallback}`);
            passport.use(new DiscordStrategy({
                clientID: settings.oauth_discord_client_id.trim(),
                clientSecret: settings.oauth_discord_client_secret.trim(),
                callbackURL: discordCallback,
                scope: ['identify', 'email'],
                passReqToCallback: true
            }, (req, accessToken, refreshToken, profile, done) => handleSocialLogin(req, accessToken, refreshToken, profile, done, 'discord_id')));
            console.log('[Auth] Discord Strategy Registered');
        } else if (settings.oauth_discord_enabled === 'true') {
            console.warn('[Auth] Discord strategy enabled but missing Client ID or Secret.');
        }

        // Google
        if (settings.oauth_google_enabled === 'true' && settings.oauth_google_client_id && settings.oauth_google_client_secret) {
            const googleCallback = baseUrl ? `${baseUrl}/auth/google/callback` : "/auth/google/callback";
            passport.use(new GoogleStrategy({
                clientID: settings.oauth_google_client_id.trim(),
                clientSecret: settings.oauth_google_client_secret.trim(),
                callbackURL: googleCallback,
                passReqToCallback: true
            }, (req, accessToken, refreshToken, profile, done) => handleSocialLogin(req, accessToken, refreshToken, profile, done, 'google_id')));
            console.log(`[Auth] Google Strategy Loaded. Callback: ${googleCallback}`);
        } else if (settings.oauth_google_enabled === 'true') {
            console.warn('[Auth] Google strategy enabled but missing Client ID or Secret.');
        }

        // Apple (Simplistic for now)
        if (settings.oauth_apple_enabled === 'true' && settings.oauth_apple_client_id) {
            // Apple setup is complex (requires key files). For this dynamic implementation, 
            // we assume standard usage but it might require filesystem writes for keys if pasted in admin.
            // Skipping complex apple logic for this iteration unless requested specifically with key file handling.
            // Placeholder:
            console.log('[Auth] Apple Strategy skipped (requires file handling for private keys)');
        }

    } catch (err) {
        console.error('[Auth] Failed to load strategies:', err);
    }
};

module.exports = {
    passport,
    loadStrategies,
    handleSocialLogin
};
