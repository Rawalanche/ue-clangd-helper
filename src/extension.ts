import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// --- Constants ---
const TASK_GENERATE = "Generate Clang CompileCommands";
const TASK_UHT = "Refresh UHT Generated Headers";
const TASK_COMPOUND = "Fix Header False Errors";

export function activate(context: vscode.ExtensionContext) {

    // 1. Command A: Setup
    let cmdSetup = vscode.commands.registerCommand('ue-clangd-helper.setup', async () => {
        await runSetup(context);
    });

    // 2. Command B: Refresh Files (Triggers Generate Task)
    let cmdRefreshFiles = vscode.commands.registerCommand('ue-clangd-helper.refreshFiles', async () => {
        const paths = getWorkspacePaths();
        if (!paths) {
            showMissingPathsError(); // <--- CHANGE
            return;
        }
        await triggerTask(TASK_GENERATE);
    });

    // 3. Command C: Refresh Headers (Triggers Compound Task)
    let cmdRefreshHeaders = vscode.commands.registerCommand('ue-clangd-helper.refreshHeaders', async () => {
        const paths = getWorkspacePaths();
        if (!paths) {
            showMissingPathsError(); // <--- CHANGE
            return;
        }
        await injectTasks(paths);
        await triggerTask(TASK_COMPOUND);
    });

    // 4. Watcher: Auto-sync compile_commands.json when "Generate" task finishes
    let taskWatcher = vscode.tasks.onDidEndTask(async (event) => {
        if (event.execution.task.name === TASK_GENERATE) {
            const config = vscode.workspace.getConfiguration('ueClangdHelper');
            if (config.get('syncCompileCommands')) {
                await syncCompileCommands();
            }
        }
    });

    // 5. Watcher: Auto-fix phantom errors on header save
    let saveWatcher = vscode.workspace.onDidSaveTextDocument(async (savedDocument) => {
        const config = vscode.workspace.getConfiguration('ueClangdHelper');
        if (!config.get('autoFixOnSave')) return;

        const projectPaths = getWorkspacePaths();
        if (!projectPaths) return;

        // Check if it's a header inside the Source folder
        const isHeader = savedDocument.fileName.endsWith('.h');
        const isInSource = savedDocument.fileName.includes(path.join(projectPaths.projectRoot, 'Source'));

        if (isHeader && isInSource) {
            if (hasPhantomErrors(savedDocument.uri)) {
                // Trigger the compound fix task automatically
                await triggerTask(TASK_COMPOUND);
            }
        }
    });

    context.subscriptions.push(cmdSetup, cmdRefreshFiles, cmdRefreshHeaders, taskWatcher, saveWatcher);
}

async function runSetup(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('ueClangdHelper');
    const paths = getWorkspacePaths();

    if (!paths) {
        showMissingPathsError(); // <--- CHANGE
        return;
    }

    if (config.get('generateConfigs')) {
        try {
            const clangdSrc = context.asAbsolutePath(path.join('resources', '.clangd'));
            const formatSrc = context.asAbsolutePath(path.join('resources', '.clang-format'));

            const clangdContent = fs.readFileSync(clangdSrc, 'utf8');
            const formatContent = fs.readFileSync(formatSrc, 'utf8');

            createFile(path.join(paths.projectRoot, '.clangd'), clangdContent);
            createFile(path.join(paths.projectRoot, '.clang-format'), formatContent);

            try {
                createFile(path.join(paths.engineRoot, '.clangd'), clangdContent);
            } catch (e) {
                vscode.window.showWarningMessage(`Could not write .clangd to Engine root. Run VSCode as Admin if needed.`);
            }
        } catch (err) {
            vscode.window.showErrorMessage("Failed to read resource templates. Check extension installation.");
            console.error(err);
        }
    }

    await injectTasks(paths);

    await new Promise(resolve => setTimeout(resolve, 500));

    await triggerTask(TASK_GENERATE);

    vscode.window.showInformationMessage("UE Clangd Helper: Setup initiated. Build task running...");
}

// --- Helper Functions ---

async function triggerTask(taskName: string) {
    // We must fetch tasks from VSCode's internal list to run them
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find(t => t.name === taskName);
    if (task) {
        vscode.tasks.executeTask(task);
    } else {
        vscode.window.showErrorMessage(`Task '${taskName}' not found. Try running Setup first.`);
    }
}

async function syncCompileCommands() {
    const paths = getWorkspacePaths();
    if (!paths) return;

    const source = path.join(paths.engineRoot, 'compile_commands.json');
    const dest = path.join(paths.projectRoot, 'compile_commands.json');

    if (fs.existsSync(source)) {
        try {
            fs.copyFileSync(source, dest);
            vscode.window.showInformationMessage("Synced compile_commands.json from Engine to Project.");

            await vscode.commands.executeCommand('clangd.restart');
        } catch (e) {
            vscode.window.showErrorMessage("Failed to copy compile_commands.json. Check file permissions.");
        }
    } else {
        vscode.window.showWarningMessage("compile_commands.json not found in Engine root. Did the generate task fail?");
    }
}

async function injectTasks(paths: any) {
    const buildBat = path.join(paths.engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
    const uproject = path.join(paths.projectRoot, `${paths.projectName}.uproject`);
    const manifest = path.join( paths.projectRoot, 'Intermediate', 'Build', 'Win64', `${paths.projectName}Editor`, 'Development', `${paths.projectName}Editor.uhtmanifest` );

    const newTasks = [
        {
            "label": TASK_GENERATE,
            "type": "shell",
            "command": buildBat,
            "args": [`${paths.projectName}Editor`, "Win64", "Development", `-project=${uproject}`, "-mode=GenerateClangDatabase", "-game", "-rocket", "-progress", "-UsePrecompiled"],
            "group": "build",
            "problemMatcher": []
        },
        {
            "label": TASK_UHT,
            "type": "shell",
            "command": buildBat,
            "args": ["-Mode=UnrealHeaderTool", uproject, manifest, "-WarningsAsErrors"],
            "problemMatcher": "$msCompile",
            "presentation": { "reveal": "silent", "panel": "shared" }
        },
        {
            "label": "Restart Clangd",
            "command": "${command:clangd.restart}",
            "problemMatcher": []
        },
        {
            "label": TASK_COMPOUND,
            "dependsOn": [TASK_UHT, "Restart Clangd"],
            "dependsOrder": "sequence",
            "group": { "kind": "build", "isDefault": false },
            "problemMatcher": []
        }
    ];

    // Write tasks to .vscode/tasks.json in the project root
    const vscodeDir = path.join(paths.projectRoot, '.vscode');
    const tasksJsonPath = path.join(vscodeDir, 'tasks.json');

    // Ensure .vscode directory exists
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    // Read existing tasks.json or create default structure
    let tasksJson: any = {
        "version": "2.0.0",
        "tasks": []
    };

    if (fs.existsSync(tasksJsonPath)) {
        try {
            const content = fs.readFileSync(tasksJsonPath, 'utf8');
            tasksJson = JSON.parse(content);
            if (!tasksJson.tasks) {
                tasksJson.tasks = [];
            }
        } catch (e) {
            console.warn('UE Clangd Helper: Failed to parse existing tasks.json, creating new one.', e);
            tasksJson = { "version": "2.0.0", "tasks": [] };
        }
    }

    // Update or add tasks
    newTasks.forEach(nt => {
        const idx = tasksJson.tasks.findIndex((et: any) => et.label === nt.label);
        if (idx !== -1) {
            tasksJson.tasks[idx] = nt;
        } else {
            tasksJson.tasks.push(nt);
        }
    });

    // Write back to tasks.json
    fs.writeFileSync(tasksJsonPath, JSON.stringify(tasksJson, null, 4), 'utf8');
}

function hasPhantomErrors(fileUri: vscode.Uri): boolean {
    const diagnostics = vscode.languages.getDiagnostics(fileUri);

    // We look for errors related to missing .generated.h files or UHT-specific failures
    // These are identified by clang error codes: ovl_deleted_init and missing_type_specifier
    return diagnostics.some(diagnostic => {
        const errorCode = typeof diagnostic.code === 'string'
            ? diagnostic.code
            : typeof diagnostic.code === 'object' && diagnostic.code !== null
                ? String(diagnostic.code.value)
                : '';
        return (
            diagnostic.severity === vscode.DiagnosticSeverity.Error &&
            (errorCode === 'ovl_deleted_init' || errorCode === 'missing_type_specifier')
        );
    });
}

function getWorkspacePaths() {
    if (!vscode.workspace.workspaceFolders) return null;

    let projectRoot = '';
    let engineRoot = '';
    let projectName = '';

    for (const folder of vscode.workspace.workspaceFolders) {
        const fsPath = folder.uri.fsPath;
        try {
            // Safety check: ensure it is actually a folder
            if (!fs.statSync(fsPath).isDirectory()) continue;

            const files = fs.readdirSync(fsPath);
            const uproject = files.find(f => f.endsWith('.uproject'));

            if (uproject) {
                projectRoot = fsPath;
                projectName = path.parse(uproject).name;
            }

            if (fs.existsSync(path.join(fsPath, 'Engine', 'Build', 'BatchFiles', 'Build.bat'))) {
                engineRoot = fsPath;
            }
        } catch (e) {
            console.warn(`UE Clangd Helper: Failed to read folder ${fsPath}`, e);
        }
    }

    // Strict return: All must be found, or we return null
    if (projectRoot && engineRoot && projectName) {
        return { projectRoot, engineRoot, projectName };
    }

    return null;
}

function createFile(filePath: string, content: string) {
    fs.writeFileSync(filePath, content, 'utf8');
}

function showMissingPathsError() {
    vscode.window.showErrorMessage("Error: Engine or Project root not found in workspace. Please run 'Generate Visual Studio Code Project' from the Unreal Editor.");
}

export function deactivate() {}