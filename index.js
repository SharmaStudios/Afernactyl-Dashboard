const express = require('express');
const session = require('express-session');
const flash = require('express-flash');
const bodyParser = require('body-parser');
const path = require('path');
const methodOverride = require('method-override');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database Check
const db = require('./config/database');
const scheduler = require('./services/scheduler'); // Import Scheduler

db.getConnection().then(conn => {
    console.log("Connected to MariaDB!");
    conn.release();

    // Start Scheduler after DB is connected
    scheduler.initScheduler();
}).catch(err => {
    console.error("Failed to connect to DB - make sure it is created and running:", err.message);
});

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(methodOverride('_method'));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));
app.use(flash());

// Passport Config (Dynamic)
const authService = require('./services/authService');
app.use(authService.passport.initialize());
app.use(authService.passport.session());

// Load Strategies on Start
db.getConnection().then(async (conn) => {
    conn.release();
    await authService.loadStrategies();
    console.log("OAuth strategies loaded.");
}).catch(err => console.error("Failed to load OAuth strategies:", err));

// Global variables for views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.error = req.flash('error'); // Passport style
    res.locals.path = req.path;
    res.locals.originalAdmin = req.session.originalAdmin || null;
    next();
});

// Theme Middleware (Must be after global variables)
const themeMiddleware = require('./middleware/theme');
app.use(themeMiddleware);

// Maintenance Mode Middleware
app.use(async (req, res, next) => {
    // Whitelist paths
    const whitelist = ['/auth/login', '/maintenance', '/css', '/img', '/js', '/uploads'];
    const isStatic = whitelist.some(path => req.path.startsWith(path));

    // Process login POST even in maintenance
    if (isStatic || (req.path === '/auth/login' && req.method === 'POST')) {
        return next();
    }

    try {
        const conn = await db.getConnection();
        const rows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('maintenance', 'global_alert', 'affiliate_enabled')");
        conn.release();

        const maintenanceSetting = rows.find(r => r.setting_key === 'maintenance');
        const alertSetting = rows.find(r => r.setting_key === 'global_alert');
        const affiliateSetting = rows.find(r => r.setting_key === 'affiliate_enabled');

        const maintenance = maintenanceSetting && maintenanceSetting.setting_value === 'true';
        res.locals.affiliate_enabled = affiliateSetting?.setting_value || 'false';

        // Global Alert (User requested fix)
        if (alertSetting) {
            try {
                res.locals.globalAlert = JSON.parse(alertSetting.setting_value);
            } catch (e) {
                console.error("Failed to parse global alert:", e);
                res.locals.globalAlert = null;
            }
        } else {
            res.locals.globalAlert = null;
        }

        if (maintenance) {
            // Strict Check: Only Admins can bypass maintenance
            // Normal users (even if logged in) are shown the maintenance page.

            if (req.session.user && req.session.user.is_admin) {
                return next();
            } else {
                return res.render('maintenance');
            }
        }
    } catch (err) {
        console.error("Maintenance check error:", err);
    }
    next();
});

const settingsMiddleware = require('./middleware/settings');
app.use(settingsMiddleware);

// Routes
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

// Public API (no authentication required)
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

const dashboardRoutes = require('./routes/dashboard');
const ticketRoutes = require('./routes/tickets');
const { checkSuspended } = require('./middleware/auth');

// Make originalAdmin available in views for impersonation banner
app.use((req, res, next) => {
    res.locals.originalAdmin = req.session.originalAdmin || null;
    next();
});

// Tickets are NOT suspension-checked so suspended users can appeal
app.use('/dashboard/tickets', ticketRoutes);
// Dashboard checks suspension
app.use('/dashboard', checkSuspended, dashboardRoutes);

const adminRoutes = require('./routes/admin');
app.use('/admin', adminRoutes);

// Dynamic PWA Manifest (uses site settings)
app.get('/manifest.json', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const settings = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('site_name', 'site_description', 'site_logo')");
        conn.release();

        const siteName = settings.find(s => s.setting_key === 'site_name')?.setting_value || 'Afernactyl';
        const siteDescription = settings.find(s => s.setting_key === 'site_description')?.setting_value || 'Premium Game Server Hosting Dashboard';
        const siteLogo = settings.find(s => s.setting_key === 'site_logo')?.setting_value || null;

        // Build icons array - use custom logo if available, otherwise default icons
        let icons = [
            { src: '/icons/icon-72x72.png', sizes: '72x72', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-96x96.png', sizes: '96x96', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-144x144.png', sizes: '144x144', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ];

        // If custom logo is set, add it as the primary icon
        if (siteLogo) {
            icons = [
                { src: siteLogo, sizes: '192x192', type: 'image/png', purpose: 'any' },
                { src: siteLogo, sizes: '512x512', type: 'image/png', purpose: 'any' },
                ...icons
            ];
        }

        const manifest = {
            name: `${siteName} Dashboard`,
            short_name: siteName,
            description: siteDescription,
            start_url: '/dashboard',
            display: 'standalone',
            background_color: '#0a0f1c',
            theme_color: '#6366f1',
            orientation: 'any',
            scope: '/',
            icons: icons,
            categories: ['games', 'utilities', 'productivity'],
            prefer_related_applications: false
        };

        res.setHeader('Content-Type', 'application/manifest+json');
        res.json(manifest);
    } catch (err) {
        console.error('Manifest generation error:', err);
        res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
    }
});

app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// 404 Handler - Page Not Found
app.use((req, res, next) => {
    res.status(404).render('errors/404');
});

// 500 Handler - Critical Error
app.use((err, req, res, next) => {
    console.error(err.stack);

    // Check if error is a missing view/template (addon not included)
    if (err.message && (err.message.includes('Failed to lookup view') || err.message.includes('ENOENT'))) {
        console.log('[Addon Required] Missing view:', err.message);
        return res.status(200).render('addon_required');
    }

    res.status(err.status || 500).render('errors/500', { error: err });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
