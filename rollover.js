import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

function runCmd(cmd, cwd) {
    console.log(`Running: ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit', cwd: cwd || __dirname });
    } catch (e) {
        console.error(`Error running command: ${cmd}`);
        console.error(e.message);
        throw e;
    }
}

function updateEnvValue(envPath, key, value) {
    if (!fs.existsSync(envPath)) return;
    let lines = fs.readFileSync(envPath, 'utf8').split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`${key}=`)) {
            lines[i] = `${key}=${value}`;
            found = true;
            break;
        }
    }
    if (!found) lines.push(`${key}=${value}`);
    fs.writeFileSync(envPath, lines.join('\n'));
}

async function main() {
    const cfAccountId = process.env.CF_ID;
    const cfApiToken = process.env.CF_API_TOKEN || process.env.GLOUDFLARE_API;
    const gitToken = process.env.GIT_TOKEN;
    const originalProjectName = process.env.PROJECT_NAME || 'email-cosmosim-project';
    const emailUser = process.env.EMAIL_USER;
    const gitOwner = process.env.GIT_OWNER || process.env.GITHUB_OWNER || 'qyzenatrix';

    if (!cfAccountId || !cfApiToken || !gitToken) {
        console.error("Missing required credentials in .env (CF_ID, CF_API_TOKEN, GIT_TOKEN).");
        process.exit(1);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '').substring(0, 12);
    const archiveProjectName = `${originalProjectName}-archive-${timestamp}`;
    const archiveTargetDir = path.join(path.dirname(__dirname), archiveProjectName.replace('email-cosmosim-', ''));

    console.log(`\n[1/5] Starting Rollover. Archive Name: ${archiveProjectName}`);
    console.log(`Copying files to: ${archiveTargetDir}`);

    if (fs.existsSync(archiveTargetDir)) {
        console.error("Archive directory already exists!");
        process.exit(1);
    }

    // Use pure JS to copy files, avoiding .git and node_modules
    fs.mkdirSync(archiveTargetDir, { recursive: true });
    
    const skipDirs = new Set(['.git', 'node_modules', '.wrangler']);
    const stack = [{ src: __dirname, dest: archiveTargetDir }];
    
    while (stack.length > 0) {
        const { src, dest } = stack.pop();
        const items = fs.readdirSync(src);
        
        for (const item of items) {
            if (skipDirs.has(item)) continue;
            
            const srcPath = path.join(src, item);
            const destPath = path.join(dest, item);
            const stat = fs.statSync(srcPath);
            
            if (stat.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                stack.push({ src: srcPath, dest: destPath });
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    console.log(`\n[2/5] Updating configuration for archive repository...`);
    const targetEnvPath = path.join(archiveTargetDir, '.env');
    updateEnvValue(targetEnvPath, 'PROJECT_NAME', archiveProjectName);
    
    // Also disable IMAP sync in the archive
    updateEnvValue(targetEnvPath, 'DISABLE_SYNC', 'true');
    updateEnvValue(targetEnvPath, 'GITHUB_OWNER', gitOwner);
    updateEnvValue(targetEnvPath, 'GITHUB_REPO', `${gitOwner}/${archiveProjectName}`);

    // Update package.json name if exists
    const pkgPath = path.join(archiveTargetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        pkg.name = archiveProjectName;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }

    // We don't overwrite KV for this archive; it acts strictly as static files!
    // Or we create a new KV? The script `create-cloudflare-pages.js` will create the page.
    console.log(`\n[3/5] Installing dependencies and Deploying to Cloudflare Pages...`);
    try {
        runCmd('npm install', archiveTargetDir);
        runCmd('node create-cloudflare-pages.js', archiveTargetDir);
        // Important: Provision variables and KV bindings so the archive UI works!
        runCmd('node update-cloudflare-env.js', archiveTargetDir);
        runCmd('node add-kv-binding.js', archiveTargetDir);
    } catch (e) {
        console.error("Warning: Cloudflare pages deployment script failed. You may need to run it manually.");
    }
    
    // Create new github repo
    console.log(`\n[4/5] Pushing archive to GitHub...`);
    try {
        runCmd('git init -b master', archiveTargetDir);
        runCmd('git add .', archiveTargetDir);
        runCmd(`git commit -m "Archive snapshot ${timestamp}"`, archiveTargetDir);
        
        // Setup git remote
        const gitOwner = process.env.GIT_OWNER || 'qyzenatrix';
        process.env.GH_TOKEN = gitToken;
        runCmd(`gh repo create ${gitOwner}/${archiveProjectName} --private`, archiveTargetDir);
        runCmd(`git remote add origin https://${gitToken}@github.com/${gitOwner}/${archiveProjectName}.git`, archiveTargetDir);
        runCmd(`git push -u origin master`, archiveTargetDir);
        console.log(`✅ GitHub repository created: ${gitOwner}/${archiveProjectName}`);
    } catch(e) {
        console.error("Warning: Failed to create or push GitHub repository.");
    }

    // Final Setup back in the original repository
    console.log(`\n[5/5] Resetting Original Repository Emails...`);
    
    // Delete all emails in public/emails
    const emailsDir = path.join(__dirname, 'public', 'emails');
    if (fs.existsSync(emailsDir)) {
        fs.rmSync(emailsDir, { recursive: true, force: true });
        fs.mkdirSync(emailsDir, { recursive: true });
    }

    // Reset search-index.json
    const searchIndexPath = path.join(__dirname, 'public', 'search-index.json');
    const cleanIndex = {
        emails: [],
        version: new Date().toISOString(),
        totalEmails: 0
    };
    if (fs.existsSync(path.dirname(searchIndexPath))) {
        fs.writeFileSync(searchIndexPath, JSON.stringify(cleanIndex, null, 2));
    }

    // Determine current ISODate for min sync cutoff
    const rolloverDate = new Date().toISOString();

    // Note the new archive URL
    const archiveUrl = `https://${archiveProjectName}.pages.dev`;
    
    // Update active .env file
    const activeEnvPath = path.join(__dirname, '.env');
    updateEnvValue(activeEnvPath, 'MIN_SYNC_DATE', rolloverDate);
    
    // Append to JSON safe ARCHIVES env var
    let archivesJSON = [];
    if (process.env.ARCHIVES) {
        try { archivesJSON = JSON.parse(process.env.ARCHIVES); } catch(e) {}
    }
    archivesJSON.push({
        name: `Archive ${new Date().toLocaleDateString()}`,
        url: archiveUrl
    });
    updateEnvValue(activeEnvPath, 'ARCHIVES', JSON.stringify(archivesJSON));

    // Create a local backup settings update so frontend `app.js` can read it statically from config
    const settingsPath = path.join(__dirname, 'public', 'config', 'settings.json');
    let settings = {};
    if(fs.existsSync(settingsPath)) {
        try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch(e) {}
    }
    settings.archives = archivesJSON;
    if (fs.existsSync(path.dirname(settingsPath))) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }

    console.log(`\n✅ Rollover process completed successfully!`);
    console.log(`- New archive created and deployed: ${archiveUrl}`);
    console.log(`- Main repository wiped of old emails.`);
    console.log(`- MIN_SYNC_DATE set to ${rolloverDate} to prevent re-fetching emails.`);
    console.log(`- UI updated to include new archive dropdown link.`);
}

main().catch(err => {
    console.error("Rollover failed:", err);
    process.exit(1);
});
