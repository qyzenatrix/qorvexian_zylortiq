import fs from 'fs/promises';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { simpleParser } from 'mailparser';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

let tempPrivateKeyPath = null;
function getPrivateKeyPath() {
  if (process.env.SSH_PRIVATE_KEY) {
    if (!tempPrivateKeyPath) {
      tempPrivateKeyPath = path.join(os.tmpdir(), `ssh_key_${crypto.randomBytes(4).toString('hex')}`);
      let keyContent = process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\r/g, '');
      if (!keyContent.endsWith('\n')) keyContent += '\n';
      writeFileSync(tempPrivateKeyPath, keyContent, { mode: 0o600 });
      console.log(`  [SSH Sync] Using SSH_PRIVATE_KEY from environment`);
    }
    return tempPrivateKeyPath;
  }
  if (process.env.SSH_KEY_PATH) return process.env.SSH_KEY_PATH;
  return '';
}

// Default config generator to capture env sequentially
function getDefaultConfig() {
  return {
    ssh: {
      user: process.env.SSH_USER,
      host: process.env.SSH_HOST,
      port: parseInt(process.env.SSH_PORT),
      privateKeyPath: getPrivateKeyPath(),
      maildir: process.env.SSH_MAILDIR
    },
    outputDir: process.env.OUTPUT_DIR || 'public',
    maxAttachmentSize: parseInt(process.env.MAX_ATTACHMENT_SIZE) || 500 * 1024,
    syncDays: parseInt(process.env.SYNC_DAYS) || 10950,
    maxEmails: parseInt(process.env.MAX_EMAILS) || 30000
  };
}

/**
 * Generate unique email ID from headers
 */
function generateEmailId(messageId, date) {
  const hash = crypto.createHash('md5')
    .update(messageId + String(date))
    .digest('hex')
    .substring(0, 12);
  return `email-${hash}`;
}

/**
 * Sanitize filename
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-z0-9.-]/gi, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 100);
}

/**
 * Save attachment
 */
async function saveAttachment(attachment, emailId, config) {
  const attachDir = path.join(config.outputDir, 'attachments');
  await fs.mkdir(attachDir, { recursive: true });

  const safeFilename = sanitizeFilename(attachment.filename || 'attachment');
  const filename = `${emailId}-${safeFilename}`;
  const filepath = path.join(attachDir, filename);

  await fs.writeFile(filepath, attachment.content);

  return {
    filename: attachment.filename,
    size: attachment.size,
    type: attachment.contentType,
    url: `/attachments/${filename}`
  };
}

/**
 * Convert email to JSON
 */
async function convertEmail(buffer, folder, config) {
  const parsed = await simpleParser(buffer);
  const emailDate = parsed.date || new Date();
  const emailId = generateEmailId(parsed.messageId || String(Date.now()), emailDate);

  const attachments = [];
  if (parsed.attachments) {
    for (const att of parsed.attachments) {
      if (att.size <= config.maxAttachmentSize) {
        const saved = await saveAttachment(att, emailId, config);
        attachments.push(saved);
      } else {
        attachments.push({
          filename: att.filename, size: att.size, type: att.contentType, url: null, tooLarge: true
        });
      }
    }
  }

  let preview = '';
  if (parsed.text) {
    preview = parsed.text.replace(/\s+/g, ' ').trim().substring(0, 200);
  }

  const normalizedFolder = folder.toLowerCase();

  return {
    id: emailId,
    messageId: parsed.messageId,
    from: {
      name: parsed.from?.value[0]?.name || '',
      email: parsed.from?.value[0]?.address || ''
    },
    to: (parsed.to?.value || []).map(t => ({
      name: (t.name || '').trim(),
      email: (t.address || '').trim()
    })).filter(t => t.email),
    subject: (parsed.subject || '(No Subject)').trim(),
    date: emailDate.toISOString(),
    preview,
    body: parsed.text || '',
    bodyHtml: parsed.html || parsed.textAsHtml || '',
    attachments,
    folder: normalizedFolder,
    labels: [normalizedFolder],
    read: true,
    starred: false,
    hasAttachments: attachments.length > 0,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references
  };
}

/**
 * Execute SSH command using native OpenSSH (works on modern Windows/Linux/Mac)
 */
async function runSSHCommand(config, command) {
    const { user, host, port, privateKeyPath } = config.ssh;
    let keyArgs = '';
    if (privateKeyPath) {
        // Wrap path in quotes to handle spaces
        keyArgs = `-i "${privateKeyPath}" -o StrictHostKeyChecking=no -o BatchMode=yes`;
    } else {
        keyArgs = `-o StrictHostKeyChecking=no -o BatchMode=yes`; // Assumes SSH agent or default keys
    }

    const sshCmd = `ssh ${keyArgs} -p ${port} ${user}@${host} "${command.replace(/"/g, '\\"')}"`;
    const { stdout } = await execAsync(sshCmd, { maxBuffer: 1024 * 1024 * 50 }); // 50MB buffer capacity
    return stdout;
}

/**
 * Fetch files directly via ssh cat stream
 */
async function syncEmailsSSH(customConfig = {}) {
    const config = { ...getDefaultConfig(), ...customConfig };
    
    // Merge nested config
    if (customConfig.ssh) {
        config.ssh = { ...getDefaultConfig().ssh, ...customConfig.ssh };
    }

    const maildir = config.ssh.maildir;
    
    if (!maildir) {
        throw new Error("SSH_MAILDIR or config.ssh.maildir must be provided to locate emails.");
    }

    console.log(`\n  [SSH Sync] Connecting to ${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`);
    console.log(`  [SSH Sync] Maildir Path: ${maildir}`);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (config.syncDays || 30));
    const mtimeDays = config.syncDays || 30;

    const foldersToSync = [
        { name: 'inbox', path: `${maildir}/new/` },
        { name: 'inbox', path: `${maildir}/cur/` },
        { name: 'sent', path: `${maildir}/.Sent/cur/` },
        { name: 'sent', path: `${maildir}/.Sent/new/` }
    ];

    const allEmails = [];

    for (const folder of foldersToSync) {
        console.log(`  [SSH Sync] Scanning ${folder.path} (last ${mtimeDays} days)...`);
        
        try {
            // Find recent files
            const findCmd = `find ${folder.path} -type f -mtime -${mtimeDays}`;
            const fileListRaw = await runSSHCommand(config, findCmd);
            const files = fileListRaw.split('\n').filter(f => f.trim().length > 0);

            if (files.length === 0) {
                console.log(`  [SSH Sync] No new emails found in ${folder.path}.`);
                continue;
            }

            console.log(`  [SSH Sync] Found ${files.length} email files. Fetching...`);
            
            // Limit the amount of files fetched
            const fetchFiles = files.slice(-(config.maxEmails || 3000));

            for (let i = 0; i < fetchFiles.length; i++) {
                const filePath = fetchFiles[i];
                if (i === 0 || (i + 1) % 20 === 0 || i === fetchFiles.length - 1) {
                    console.log(`  [SSH Sync] Fetching file ${i + 1} of ${fetchFiles.length}...`);
                }
                
                try {
                    // Fetch individual file content
                    const catCmd = `cat ${filePath}`;
                    const rawEmail = await runSSHCommand(config, catCmd);
                    
                    const buffer = Buffer.from(rawEmail, 'utf8');
                    const parsedData = await convertEmail(buffer, folder.name, config);
                    
                    if (new Date(parsedData.date) >= cutoffDate) {
                        allEmails.push(parsedData);
                    }
                } catch (err) {
                    console.error(`  [SSH Sync] Failed to parse email ${filePath}: ${err.message}`);
                }
            }

        } catch (e) {
            console.error(`  [SSH Sync] Error scanning folder ${folder.path}: ${e.message}`);
        }
    }

    console.log(`  [SSH Sync] Successfully fetched ${allEmails.length} emails from server.`);
    return allEmails;
}

export { syncEmailsSSH };

// Allow testing directly from CLI: `node sync-ssh.js`
import url from 'url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    import('dotenv').then(dotenv => {
        dotenv.config({ override: true });
        console.log("🚀 Running Test SSH Sync directly...");
        syncEmailsSSH() // Uses defaults from .env (36500 days)
            .then(emails => {
                console.log(`\n✅ TEST SUCCESS: Extracted ${emails.length} emails!`);
                if (emails.length > 0) console.log("First email subject:", emails[0].subject);
                process.exit(0);
            })
            .catch(err => {
                console.error("\n❌ TEST FAILED:");
                console.error(err);
                process.exit(1);
            });
    });
}
