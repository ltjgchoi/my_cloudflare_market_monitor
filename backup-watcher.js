const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 감시할 파일 및 설정
const TARGET_FILE = 'cloudflare-worker-dashboard.js';
const TARGET_PATH = path.join(__dirname, TARGET_FILE);
const DEBOUNCE_DELAY = 2000; // 2초 대기 후 백업 실행

let timeoutId = null;

console.log(`[Backup Watcher] Starting watcher for ${TARGET_FILE}...`);

// Git 명령어 실행 헬퍼 함수
function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr });
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

// 자동 백업 실행 로직
async function performBackup() {
    console.log(`\n[${new Date().toISOString()}] [Backup Watcher] Change detected. Starting backup process...`);

    try {
        // 1. git add
        await runCommand(`git add "${TARGET_FILE}"`);
        console.log(`[Backup Watcher] Added ${TARGET_FILE} to stage.`);

        // 2. git status 확인하여 변경사항이 있는지 확인
        const status = await runCommand(`git status --porcelain "${TARGET_FILE}"`);
        if (!status) {
            console.log(`[Backup Watcher] No changes to commit.`);
            return;
        }

        // 3. git commit
        const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const commitMessage = `Auto backup: ${timestamp}`;
        await runCommand(`git commit -m "${commitMessage}"`);
        console.log(`[Backup Watcher] Committed changes: "${commitMessage}"`);

        // 4. Remote (origin) 등록 여부 확인 및 Push
        try {
            const remotes = await runCommand('git remote');
            if (remotes.includes('origin')) {
                console.log(`[Backup Watcher] Origin remote found. Pushing to GitHub...`);
                // 현재 브랜치 이름 확인
                const branch = await runCommand('git branch --show-current');
                await runCommand(`git push origin ${branch}`);
                console.log(`[Backup Watcher] Successfully pushed to origin/${branch}.`);
            } else {
                console.log(`[Backup Watcher] Remote 'origin' is not configured yet. Skipping push.`);
                console.log(`[Backup Watcher] To link with GitHub, run: git remote add origin <your-github-repo-url>`);
            }
        } catch (remoteError) {
            console.warn(`[Backup Watcher] Warning during remote check/push:`, remoteError.stderr || remoteError.message);
        }

    } catch (err) {
        console.error(`[Backup Watcher] Backup failed:`, err.stderr || err.error || err);
    }
}

// 파일 감시 설정
if (!fs.existsSync(TARGET_PATH)) {
    console.error(`[Backup Watcher] Error: Target file not found at ${TARGET_PATH}`);
    process.exit(1);
}

fs.watch(TARGET_PATH, (eventType, filename) => {
    if (eventType === 'change') {
        // 디바운스 적용
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        
        timeoutId = setTimeout(() => {
            performBackup();
        }, DEBOUNCE_DELAY);
    }
});

console.log(`[Backup Watcher] Monitoring '${TARGET_FILE}' for changes. Keep this terminal open to auto-backup.`);
