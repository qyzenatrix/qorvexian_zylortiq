import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

function runCmd(cmd, cwd, envOverrides = {}) {
    console.log(`Running: ${cmd}`);
    try {
        const env = { ...process.env, ...envOverrides };
        execSync(cmd, { stdio: 'inherit', cwd: cwd || __dirname, env });
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
    const gitToken = process.env.GIT_TOKEN || process.env.GH_TOKEN || process.env.PRIVATE_REPO_PAT;
    const originalProjectName = process.env.PROJECT_NAME || 'email-cosmosim-project';
    const emailUser = process.env.EMAIL_USER;
    const gitOwner = process.env.GIT_OWNER || process.env.GITHUB_OWNER || 'qyzenatrix';

    if (!cfAccountId || !cfApiToken || !gitToken) {
        console.error("Missing required credentials in .env (CF_ID, CF_API_TOKEN, GIT_TOKEN).");
        process.exit(1);
    }

    let archivesJSON = [];
    if (process.env.ARCHIVES) {
        try { archivesJSON = JSON.parse(process.env.ARCHIVES); } catch(e) {}
    }
    const archiveIndex = archivesJSON.length + 1;
    
    const archiveProjectName = `${originalProjectName}-archive-${archiveIndex}`;
    const archiveTargetDir = path.join(path.dirname(__dirname), archiveProjectName.replace('email-cosmosim-', ''));

    console.log(`\n[1/5] Starting Rollover. Archive Name: ${archiveProjectName}`);
    console.log(`Targeting local directory: ${archiveTargetDir}`);

    if (!fs.existsSync(archiveTargetDir)) {
        fs.mkdirSync(archiveTargetDir, { recursive: true });
    } else {
        console.log(`Archive directory already exists. Reusing it.`);
    }

    // We only want to archive the static 'public' directory
    const publicSrcDir = path.join(__dirname, 'public');
    const publicDestDir = path.join(archiveTargetDir, 'public');

    if (fs.existsSync(publicSrcDir)) {
        fs.mkdirSync(publicDestDir, { recursive: true });
        const stack = [{ src: publicSrcDir, dest: publicDestDir }];
        
        while (stack.length > 0) {
            const { src, dest } = stack.pop();
            const items = fs.readdirSync(src);
            
            for (const item of items) {
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
    } else {
        console.warn(`Warning: public directory does not exist at ${publicSrcDir}`);
    }

    // No need to update .env or package.json since the archive repo only contains the public/ directory.

    // Create new github repo
    console.log(`\n[3/5] Pushing archive to GitHub...`);
    try {
        const actGitOwner = process.env.GIT_OWNER || process.env.GITHUB_OWNER || 'qyzenatrix';
        process.env.GH_TOKEN = gitToken;
        
        let isNewRepo = false;
        if (!fs.existsSync(path.join(archiveTargetDir, '.git'))) {
            runCmd('git init -b master', archiveTargetDir);
            isNewRepo = true;
        }

        runCmd('git add .', archiveTargetDir);
        
        try {
            runCmd(`git commit -m "Archive snapshot for ${archiveProjectName}"`, archiveTargetDir);
        } catch (e) {
            console.log("Nothing new to commit. Proceeding to push.");
        }
        
        if (isNewRepo) {
            runCmd(`gh repo create ${actGitOwner}/${archiveProjectName} --private`, archiveTargetDir);
            runCmd(`git remote add origin https://${gitToken}@github.com/${actGitOwner}/${archiveProjectName}.git`, archiveTargetDir);
        }
        
        runCmd(`git push -u origin master`, archiveTargetDir);
        console.log(`✅ GitHub repository updated: ${actGitOwner}/${archiveProjectName}`);
    } catch(e) {
        console.error("Warning: Failed to create or push GitHub repository.");
    }

    console.log(`\n[4/5] Deploying to Cloudflare Pages...`);
    try {
        const childEnv = { PROJECT_NAME: archiveProjectName, GITHUB_REPO: archiveProjectName };
        // Run deployment scripts from the original repo where they exist
        runCmd('node create-cloudflare-pages.js', __dirname, childEnv);
        // Important: Provision variables and KV bindings so the archive UI works!
        runCmd('node update-cloudflare-env.js', __dirname, childEnv);
        runCmd('node add-kv-binding.js', __dirname, childEnv);
    } catch (e) {
        console.error("Warning: Cloudflare pages deployment script failed. You may need to run it manually.");
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
    
    // Clear manifest.json and any chunked emails JSON files so sync-multi ignores them
    const publicDir = path.join(__dirname, 'public');
    if (fs.existsSync(publicDir)) {
        const items = fs.readdirSync(publicDir);
        for (const item of items) {
            if (item === 'manifest.json' || (item.startsWith('emails') && item.endsWith('.json'))) {
                try {
                    fs.rmSync(path.join(publicDir, item), { force: true });
                } catch(e) {}
            }
        }
    }

    // Determine current ISODate for min sync cutoff
    const rolloverDate = new Date().toISOString();

    // Note the new archive URL
    const archiveUrl = `https://${archiveProjectName}.pages.dev`;
    
    // Update active .env file
    const activeEnvPath = path.join(__dirname, '.env');
    updateEnvValue(activeEnvPath, 'MIN_SYNC_DATE', rolloverDate);
    
    // Persist MIN_SYNC_DATE in public/config/sync-state.json so it commits to the repo 
    // because .env is often ignored by git during GitHub Actions
    const syncStatePath = path.join(__dirname, 'public', 'config', 'sync-state.json');
    let syncState = {};
    if (fs.existsSync(syncStatePath)) {
        try { syncState = JSON.parse(fs.readFileSync(syncStatePath, 'utf8')); } catch(e) {}
    }
    syncState.MIN_SYNC_DATE = rolloverDate;
    fs.mkdirSync(path.dirname(syncStatePath), { recursive: true });
    fs.writeFileSync(syncStatePath, JSON.stringify(syncState, null, 2));
    
    // Append to JSON safe ARCHIVES env var
    if (!archivesJSON.find(a => a.url === archiveUrl)) {
        archivesJSON.push({
            name: `Archive ${archiveIndex} (${new Date().toLocaleDateString()})`,
            url: archiveUrl
        });
        updateEnvValue(activeEnvPath, 'ARCHIVES', JSON.stringify(archivesJSON));
    }

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
