#!/usr/bin/env node
/**
 * Afernactyl Database Migration Runner
 * 
 * Usage:
 *   node migrations/run.js           - Run all pending migrations
 *   node migrations/run.js --list    - List all available migrations
 *   node migrations/run.js --setup   - Run initial database setup
 *   node migrations/run.js --all     - Run setup + all migrations
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Bypass DB protection during migrations
process.env.DB_MIGRATING = 'true';


const MIGRATIONS_DIR = __dirname;

// Migration files in order of execution
const SETUP_SCRIPTS = [
    { name: 'setup_db.js', description: 'Core database tables' },
    { name: 'setup_commerce_db.js', description: 'Commerce tables (invoices, coupons, gateways)' },
];

const MIGRATION_SCRIPTS = [
    { name: 'migrate_maintenance.js', description: 'Maintenance mode settings' },
    { name: 'migrate_locations.js', description: 'Locations table updates' },
    { name: 'migrate_locations_ping.js', description: 'Location ping/latency fields' },
    { name: 'migrate_plans_v2.js', description: 'Plans table v2 updates' },
    { name: 'migrate_plans_v3.js', description: 'Plans table v3 (visibility, processor)' },
    { name: 'migrate_tickets_v2.js', description: 'Tickets table v2 (attachments, canned responses)' },
    { name: 'update_ticket_statuses.js', description: 'Update ticket status options' },
    { name: 'add_billing_period.js', description: 'Add billing period support' },
    { name: 'add_broadcast_logs.js', description: 'Add broadcast logs table' },
    { name: 'add_email_verification.js', description: 'Add email verification fields' },
    { name: 'add_invoice_due_date.js', description: 'Add invoice due dates' },
    { name: 'add_radar_fields.js', description: 'Add radar/protection fields' },
    { name: 'add_server_failure_fields.js', description: 'Add server failure tracking' },
    { name: 'add_server_suspended_at.js', description: 'Add suspension timestamp' },
    { name: 'add_user_suspension_deletion.js', description: 'Add user suspension/deletion fields' },
    { name: 'update_db.js', description: 'General DB updates' },
    { name: 'update_db_v2.js', description: 'General DB updates v2' },
    { name: 'update_db_v3.js', description: 'General DB updates v3 (Invoice & Active Server fields)' },
    { name: 'add_allow_egg_selection.js', description: 'Add allow_egg_selection to Plans' },
];

// Debug/utility scripts (not run automatically)
const DEBUG_SCRIPTS = [
    { name: 'check_columns.js', description: 'Check database column structure' },
    { name: 'debug_canned.js', description: 'Debug canned responses' },
    { name: 'debug_create_server.js', description: 'Debug server creation' },
    { name: 'debug_egg_vars.js', description: 'Debug egg variables' },
    { name: 'debug_ptero_info.js', description: 'Debug Pterodactyl info' },
    { name: 'debug_ptero_locations.js', description: 'Debug Pterodactyl locations' },
    { name: 'debug_users.js', description: 'Debug user data' },
];

const db = require('../config/database');

async function runScript(filename) {
    const filepath = path.join(MIGRATIONS_DIR, filename);
    if (!fs.existsSync(filepath)) {
        console.log(`  ⚠️  Skipping ${filename} (file not found)`);
        return false;
    }

    console.log(`  ▶️  Running ${filename}...`);

    try {
        // Try to require the file
        const migration = require(filepath);

        // Check if it exports a function (migrator contract)
        // Contract: module.exports = async function(conn) { ... }
        // or module.exports.up = async function(conn) { ... }
        let migrationFn = typeof migration === 'function' ? migration : migration.up;

        if (typeof migrationFn === 'function') {
            // Run in-process
            const conn = await db.getConnection();
            try {
                await migrationFn(conn);
                console.log(`  ✅ ${filename} completed`);
                return true;
            } catch (err) {
                console.log(`  ❌ ${filename} failed: ${err.message}`);
                // Print stack if available for debugging
                // console.error(err); 
                return false;
            } finally {
                if (conn) conn.release();
            }
        } else {
            // Fallback to spawn (legacy scripts)
            // We must delete from require cache to ensure fresh run if needed, though usually not for CLI
            delete require.cache[require.resolve(filepath)];

            return new Promise((resolve) => {
                const child = spawn('node', [filepath], {
                    stdio: ['inherit', 'pipe', 'pipe'],
                    env: { ...process.env, DB_MIGRATING: 'true' }
                });

                let output = '';
                child.stdout.on('data', (data) => { output += data.toString(); });
                child.stderr.on('data', (data) => { output += data.toString(); });

                child.on('close', (code) => {
                    if (code === 0) {
                        console.log(`  ✅ ${filename} completed`);
                        resolve(true);
                    } else {
                        console.log(`  ❌ ${filename} failed (exit code ${code})`);
                        if (output) console.log(`     ${output.trim()}`);
                        resolve(false);
                    }
                });

                child.on('error', (err) => {
                    console.log(`  ❌ ${filename} error: ${err.message}`);
                    resolve(false);
                });
            });
        }
    } catch (err) {
        // If require fails or some other error (e.g. syntax error in file), fall back to spawn might be safer? 
        // Or report error. A syntax error in require throws immediately.
        console.log(`  ❌ ${filename} failed to load: ${err.message}`);
        return false;
    }
}

async function listMigrations() {
    console.log('\n📋 Available Migrations:\n');

    console.log('Setup Scripts (run with --setup):');
    SETUP_SCRIPTS.forEach(m => {
        const exists = fs.existsSync(path.join(MIGRATIONS_DIR, m.name));
        console.log(`  ${exists ? '✓' : '✗'} ${m.name} - ${m.description}`);
    });

    console.log('\nMigration Scripts (run with --migrate or default):');
    MIGRATION_SCRIPTS.forEach(m => {
        const exists = fs.existsSync(path.join(MIGRATIONS_DIR, m.name));
        console.log(`  ${exists ? '✓' : '✗'} ${m.name} - ${m.description}`);
    });

    console.log('\nDebug Scripts (run individually with: node migrations/<name>.js):');
    DEBUG_SCRIPTS.forEach(m => {
        const exists = fs.existsSync(path.join(MIGRATIONS_DIR, m.name));
        console.log(`  ${exists ? '✓' : '✗'} ${m.name} - ${m.description}`);
    });
}

async function runSetup() {
    console.log('\n🔧 Running Initial Database Setup...\n');

    let success = 0, failed = 0;
    for (const script of SETUP_SCRIPTS) {
        const result = await runScript(script.name);
        if (result) success++; else failed++;
    }

    console.log(`\n📊 Setup Summary: ${success} succeeded, ${failed} failed\n`);

    await rotateAndSyncSessionSecret();

    return failed === 0;
}

async function runMigrations() {
    console.log('\n🚀 Running Database Migrations...\n');

    let success = 0, failed = 0;
    for (const script of MIGRATION_SCRIPTS) {
        const result = await runScript(script.name);
        if (result) success++; else failed++;
    }

    console.log(`\n📊 Migration Summary: ${success} succeeded, ${failed} failed\n`);

    // Always sync key if migrations didn't fail (even if 0 ran)
    if (failed === 0) {
        await rotateAndSyncSessionSecret();
    }

    return failed === 0;
}

const crypto = require('crypto');
const mariadb = require('../config/database');

async function rotateAndSyncSessionSecret() {
    console.log('\n🔒 rotating and syncing DB Protection Key (SESSION_SECRET)...\n');

    try {
        const conn = await mariadb.pool.getConnection();

        // 0. Security Verification: Check if we are authorized to rotate
        try {
            const [existing] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'db_protection_key'");

            if (existing && existing.setting_value) {
                // Key exists in DB, verify it matches local .env
                if (existing.setting_value !== process.env.SESSION_SECRET) {
                    console.error('\n❌ FATAL ERROR: Database Protection Key Mismatch!');
                    console.error('   The key in your .env file does not match the key in the database.');
                    console.error('   You are not authorized to modify this database.');
                    console.error('   Fix: Restore your original .env file or contact the administrator.\n');
                    process.exit(1); // Hard exit to prevent any damage
                }
                // Key matches, proceeding...
            } else {
                // Key doesn't exist in DB (Fresh install or manually cleared table)
                // Proceed...
            }

        } catch (err) {
            // If table doesn't exist yet (setup phase), we can proceed?
            // Actually setup_db.js should have run. If table missing, query throws.
            if (err.code !== 'ER_NO_SUCH_TABLE') {
                throw err;
            }
        }

        // 1. Generate new high-entropy key
        const newSecret = crypto.randomBytes(64).toString('hex');

        // 2. Update .env file
        const envPath = path.join(__dirname, '../.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');

            if (envContent.includes('SESSION_SECRET=')) {
                envContent = envContent.replace(/SESSION_SECRET=.*/g, `SESSION_SECRET=${newSecret}`);
            } else {
                envContent += `\nSESSION_SECRET=${newSecret}`;
            }

            fs.writeFileSync(envPath, envContent);
            console.log('  ✅ Updated .env with new SESSION_SECRET');
        } else {
            console.warn('  ⚠️ .env file not found, skipping file update');
        }

        // 3. Update process.env for current run
        process.env.SESSION_SECRET = newSecret;

        // 4. Sync to Database
        const res = await conn.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('db_protection_key', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
            [newSecret, newSecret]
        );
        conn.release();

        if (res && res.affectedRows >= 0) {
            console.log('  ✅ Synced Protection Key to Database');
            return true;
        } else {
            console.log('  ⚠️ Warning: Database insert might have failed.');
            return false;
        }

    } catch (err) {
        console.error('  ❌ Failed to rotate/sync protection key:', err.message);
        return false;
    }
}

async function runAll() {
    console.log('\n🔧 Running Full Database Setup + Migrations...\n');

    await runSetup();
    await runMigrations();

    // Rotate key at the end
    await rotateAndSyncSessionSecret();

    console.log('✅ All done!\n');

    // Explicitly close the pool to ensure process exit
    if (mariadb.endPool) {
        await mariadb.endPool();
    }
}

async function main() {
    const args = process.argv.slice(2);

    console.log('╔════════════════════════════════════════╗');
    console.log('║   Afernactyl Database Migration Tool   ║');
    console.log('╚════════════════════════════════════════╝');

    if (args.includes('--list') || args.includes('-l')) {
        await listMigrations();
    } else if (args.includes('--setup') || args.includes('-s')) {
        await runSetup();
        if (mariadb.endPool) await mariadb.endPool();
    } else if (args.includes('--all') || args.includes('-a')) {
        await runAll();
    } else if (args.includes('--help') || args.includes('-h')) {
        console.log('\nUsage:');
        console.log('  npm run migrate           Run migrations only');
        console.log('  npm run migrate:setup     Run initial DB setup only');
        console.log('  npm run migrate:list      List all migrations');
        console.log('');
        console.log('Or directly:');
        console.log('  node migrations/run.js [options]');
        console.log('  --setup, -s    Run setup scripts (create tables)');
        console.log('  --all, -a      Run setup + all migrations');
        console.log('  --list, -l     List all available scripts');
        console.log('  --help, -h     Show this help');
        console.log('\nTo run a specific script:');
        console.log('  node migrations/<script_name>.js');
    } else {
        // Default: run migrations only (not setup)
        await runMigrations();
        if (mariadb.endPool) await mariadb.endPool();
    }
}

main().catch(console.error);
