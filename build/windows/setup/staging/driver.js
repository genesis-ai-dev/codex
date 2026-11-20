// Disposable VM only. Invoke the same commands used by the Manage menu.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
exports.activate = function () {
    const manifest = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
    if (manifest.updateUrl !== 'http://127.0.0.1:18763' || manifest.version !== process.env.CODEX_STAGE_PREVIOUS) return;
    async function check() {
        fs.appendFileSync(process.env.CODEX_STAGE_LOG, 'Checking local staging feed\n');
        await vscode.commands.executeCommand('update.checkForUpdate');
        const timer = setInterval(async () => {
            try {
                await vscode.commands.executeCommand('update.installUpdate');
                await vscode.commands.executeCommand('update.restartToUpdate');
            } catch (error) {
                fs.appendFileSync(process.env.CODEX_STAGE_LOG, String(error) + '\n');
            }
        }, 3000);
        timer.unref();
    }
    setTimeout(() => check().catch(console.error), 3000);
};
