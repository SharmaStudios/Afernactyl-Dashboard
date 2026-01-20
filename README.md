![coverimage](https://i.imgur.com/Pp4qcss.jpeg)
![Discord](https://img.shields.io/discord/1061564725734944818?style=flat-square&logo=discord&logoColor=blue&link=https%3A%2F%2Fdiscord.gg%2FKKZVsJCct2)

Discord for support: https://discord.gg/KKZVsJCct2


A powerful, modern billing and management dashboard for Pterodactyl.

## Requirements

*   **Node.js**: v16 or higher
*   **Database**: MariaDB or MySQL
*   **Pterodactyl Panel**: Updated to latest version

## Installation

### 1. Download and Extract
Download the latest version from BuiltByBit and extract the files to your server.
cd Afernactyl

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
Copy the example environment file and configure it:

```bash
cp .env.example .env
nano .env
```

**Required Configuration:**
*   `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`: Database credentials

### 4. Create the Database
Before running migrations, you need to create the database in MariaDB/MySQL:

```bash
# Log into MariaDB/MySQL
sudo mariadb -u root -p

# Create the database
CREATE DATABASE afernactyl_dashboard;

# Create a user and grant permissions (replace 'yourpassword' with a secure password)
CREATE USER 'afernactyl'@'localhost' IDENTIFIED BY 'yourpassword';
GRANT ALL PRIVILEGES ON afernactyl_dashboard.* TO 'afernactyl'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Make sure the database name matches what you set in your `.env` file.

### 5. Database Setup
Run the migrations to set up the database schema:
```bash
npm run migrate:setup
```


### 5. Start the Dashboard

**For Development:**
```bash
npm run dev
```

**For Production (Recommended with PM2):**
To keep the dashboard running in the background, use PM2:
```bash
npm install pm2 -g
pm2 start index.js --name "afernactyl"
pm2 save
pm2 startup
```

Or simply:
```bash
npm start
```


The dashboard will be available at `http://localhost:3001` (or the port specified in your .env).

## Web Server Configuration

To access your dashboard securely over the internet, you should set up a reverse proxy. Below are example configurations for Caddy, Nginx, and Apache.

### Caddy (Recommended)
Caddy automatically handles SSL certificates for you.

1. Install Caddy: [https://caddyserver.com/docs/install](https://caddyserver.com/docs/install)
2. Create/edit your Caddyfile (usually at `/etc/caddy/Caddyfile`):

```caddyfile
your-domain.com {
    reverse_proxy localhost:3001
}
```
3. Reload Caddy: `systemctl reload caddy`

### Nginx

1. Create a new configuration file: `/etc/nginx/sites-available/afernactyl.conf`

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
2. Enable the site:
```bash
ln -s /etc/nginx/sites-available/afernactyl.conf /etc/nginx/sites-enabled/
```
3. Test and reload Nginx:
```bash
nginx -t
systemctl reload nginx
```
4. (Optional) Secure with Certbot: `certbot --nginx -d your-domain.com`

### Apache

1. Create a new virtual host file: `/etc/apache2/sites-available/afernactyl.conf`

```apache
<VirtualHost *:80>
    ServerName your-domain.com

    ProxyPreserveHost On
    ProxyPass / http://localhost:3001/
    ProxyPassReverse / http://localhost:3001/
</VirtualHost>
```
2. Enable required modules and site:
```bash
a2enmod proxy
a2enmod proxy_http
a2ensite afernactyl.conf
```
3. Reload Apache:
```bash
systemctl reload apache2
```
4. (Optional) Secure with Certbot: `certbot --apache -d your-domain.com`


## Features
*   **Automated Billing**: Generates invoices and suspends overdue servers automatically.
*   **Pterodactyl Integration**: Create, suspend, and delete servers directly from the dashboard.
*   **Modern UI**: Sleek, responsive design with dark mode and glassmorphism support.
*   **Payment Gateways**: Support for PayPal, Stripe, and PhonePe.

![image1](https://i.imgur.com/l9Ix4kI.png)
![image2](https://i.imgur.com/jqx9Owk.png)
![image3](https://i.imgur.com/x8zrBgF.png)
![image4](https://i.imgur.com/hxId9cB.jpeg)
![image5](https://i.imgur.com/JXkLEAC.jpeg)
![image6](https://i.imgur.com/XwqKTHY.png)
![image7](https://i.imgur.com/upLTnl1.jpeg)
