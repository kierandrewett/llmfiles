import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const PLUGIN = "meaningful-auto-commit";
const DEBOUNCE_MS = Number(process.env.OPENCODE_AUTO_COMMIT_DEBOUNCE_MS || 1500);
const QUIET_DEBOUNCE_MS = Number(process.env.OPENCODE_AUTO_COMMIT_QUIET_DEBOUNCE_MS || 45000);
const STARTUP_DEBOUNCE_MS = Number(process.env.OPENCODE_AUTO_COMMIT_STARTUP_DEBOUNCE_MS || QUIET_DEBOUNCE_MS);
const MIN_CHANGED_FILES = Number(process.env.OPENCODE_AUTO_COMMIT_MIN_FILES || 1);
const MAX_DIFF_CHARS = Number(process.env.OPENCODE_AUTO_COMMIT_MAX_DIFF_CHARS || 60000);
const PUSH_THRESHOLD = Number(process.env.OPENCODE_AUTO_COMMIT_PUSH_THRESHOLD || 5);

const SECRET_PATH_RE = /(^|\/)(\.env(\.|$)|credentials?\.|secrets?\.|.*\.pem$|.*\.key$|.*token.*|.*secret.*)/i;
const CONVENTIONAL_SUBJECT_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._-]+\))?!?: [a-z0-9].{8,100}$/;
const GENERIC_SUBJECT_RE = /checkpoint|automated|auto-commit|meaningful changes|update project files/i;
const PROMPT_TOOLS = {
    bash: false,
    edit: false,
    write: false,
    apply_patch: false,
    read: false,
    grep: false,
    glob: false,
    list: false,
    task: false,
    todowrite: false,
    webfetch: false,
    skill: false,
};

export const MeaningfulAutoCommit = async ({ $, client, directory, worktree }) => {
    const repo = worktree || directory;
    const repoRoot = resolve(repo);
    const allowedFiles = new Map();
    const toolStatusBefore = new Map();
    let sawMeaningfulActivity = false;
    let timer = null;
    let timerDeadline = 0;
    let committing = false;
    let pushing = false;

    async function log(level, message, extra = {}) {
        try {
            await client.app.log({ body: { service: PLUGIN, level, message, extra } });
        } catch {
            // Logging must never block the editor/session lifecycle.
        }
    }

    async function toast(message, title = "Auto-commit created", variant = "success") {
        try {
            await client.tui.showToast({
                body: {
                    title,
                    message,
                    variant,
                    duration: 8000,
                },
            });
        } catch {
            // UI feedback is best-effort; logs still record the commit.
        }
    }

    function parseNameStatusSummary(output) {
        const summary = {
            added: 0,
            modified: 0,
            deleted: 0,
            renamed: 0,
            copied: 0,
            typeChanged: 0,
            unmerged: 0,
            other: 0,
            total: 0,
        };

        for (const line of output.split("\n")) {
            if (!line.trim()) continue;
            summary.total += 1;
            const code = line.slice(0, 1);
            if (code === "A") summary.added += 1;
            else if (code === "M") summary.modified += 1;
            else if (code === "D") summary.deleted += 1;
            else if (code === "R") summary.renamed += 1;
            else if (code === "C") summary.copied += 1;
            else if (code === "T") summary.typeChanged += 1;
            else if (code === "U") summary.unmerged += 1;
            else summary.other += 1;
        }

        return summary;
    }

    function parseNumStatSummary(output) {
        const summary = {
            insertions: 0,
            deletions: 0,
            binary: 0,
        };

        for (const line of output.split("\n")) {
            if (!line.trim()) continue;
            const [added, removed] = line.split("\t");
            if (added === "-" || removed === "-") {
                summary.binary += 1;
                continue;
            }
            summary.insertions += Number(added || 0);
            summary.deletions += Number(removed || 0);
        }

        return summary;
    }

    function formatNonZeroCount(label, value) {
        return value ? `${value} ${label}` : null;
    }

    function formatCommitToast({ subject, sha, branch, fileSummary, lineSummary, pushState }) {
        const fileParts = [
            formatNonZeroCount("added", fileSummary.added),
            formatNonZeroCount("modified", fileSummary.modified),
            formatNonZeroCount("deleted", fileSummary.deleted),
            formatNonZeroCount("renamed", fileSummary.renamed),
            formatNonZeroCount("copied", fileSummary.copied),
            formatNonZeroCount("type changed", fileSummary.typeChanged),
            formatNonZeroCount("unmerged", fileSummary.unmerged),
            formatNonZeroCount("other", fileSummary.other),
        ].filter(Boolean);

        const lines = [`+${lineSummary.insertions} / -${lineSummary.deletions}`];
        if (lineSummary.binary) lines.push(`${lineSummary.binary} binary`);

        const rows = [
            subject,
            `${sha} on ${branch}`,
            `${fileSummary.total} files: ${fileParts.join(", ") || "no status summary"}`,
            `Lines: ${lines.join(", ")}`,
        ];
        if (pushState?.hasUpstream) rows.push(`Queued out: ${pushState.ahead}/${PUSH_THRESHOLD}`);
        return rows.join("\n");
    }

    await log("info", "Plugin initialised", { repo });

    async function git(args) {
        return await $`git -C ${repo} ${args}`.quiet().text();
    }

    async function gitWithIndex(indexPath, args) {
        return await $`env GIT_INDEX_FILE=${indexPath} git -C ${repo} ${args}`.quiet().text();
    }

    function toolEventKey(event) {
        return String(
            event?.properties?.id ||
                event?.properties?.callID ||
                event?.properties?.callId ||
                event?.id ||
                event?.callID ||
                event?.callId ||
                "__last__",
        );
    }

    function normaliseRepoPath(value) {
        if (typeof value !== "string") return null;
        let candidate = value.trim();
        if (!candidate || candidate.includes("\0")) return null;
        if (candidate.startsWith("file://")) {
            try {
                candidate = new URL(candidate).pathname;
            } catch {
                return null;
            }
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null;
        if (candidate === "." || candidate === "./" || candidate === "/") return null;

        let relativePath = candidate;
        if (isAbsolute(candidate)) {
            relativePath = relative(repoRoot, resolve(candidate));
        }
        relativePath = relativePath.replace(/^\.\/+/, "").replaceAll("\\", "/");
        if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath === "..") return null;
        if (relativePath.endsWith("/")) return null;
        return relativePath;
    }

    function collectRepoPaths(value, paths = new Set()) {
        const normalised = normaliseRepoPath(value);
        if (normalised) paths.add(normalised);

        if (!value || typeof value !== "object") return paths;
        if (Array.isArray(value)) {
            for (const item of value) collectRepoPaths(item, paths);
            return paths;
        }

        for (const [key, nested] of Object.entries(value)) {
            if (["path", "file", "filePath", "filepath", "target", "include", "pattern", "paths"].includes(key)) {
                collectRepoPaths(nested, paths);
            } else if (nested && typeof nested === "object") {
                collectRepoPaths(nested, paths);
            }
        }

        return paths;
    }

    function rememberFiles(files, reason) {
        let added = 0;
        for (const file of files) {
            const normalised = normaliseRepoPath(file);
            if (!normalised) continue;
            if (!allowedFiles.has(normalised)) added += 1;
            allowedFiles.set(normalised, reason);
        }
        return added;
    }

    function parseStatus(output) {
        return output
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .map((line) => {
                const rawPath = line.slice(3);
                const file = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
                return { code: line.slice(0, 2), file };
            });
    }

    function validateCommitMessage(message) {
        const subject = String(message?.subject || "").trim();
        const body = String(message?.body || "").trim();
        if (!CONVENTIONAL_SUBJECT_RE.test(subject)) return { ok: false, reason: "subject_not_conventional", subject, body };
        if (GENERIC_SUBJECT_RE.test(subject) || GENERIC_SUBJECT_RE.test(body)) return { ok: false, reason: "generic_message", subject, body };
        return { ok: true, subject, body };
    }

    async function getPushState() {
        if (!PUSH_THRESHOLD || PUSH_THRESHOLD < 1) {
            return { pushEnabled: false, hasUpstream: false, branch: "", upstream: "", ahead: 0, behind: 0 };
        }

        const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        if (!branch || branch === "HEAD") {
            return { pushEnabled: true, hasUpstream: false, branch, upstream: "", ahead: 0, behind: 0, reason: "detached_head" };
        }

        let upstream = "";
        try {
            upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
        } catch {
            return { pushEnabled: true, hasUpstream: false, branch, upstream: "", ahead: 0, behind: 0, reason: "no_upstream" };
        }

        const counts = (await git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`])).trim().split(/\s+/);
        const behind = Number(counts[0] || 0);
        const ahead = Number(counts[1] || 0);
        return { pushEnabled: true, hasUpstream: true, branch, upstream, ahead, behind };
    }

    async function pushQueuedCommits(pushState) {
        if (pushing || !pushState?.pushEnabled || !pushState.hasUpstream) return;
        if (pushState.ahead < PUSH_THRESHOLD) return;
        if (pushState.behind > 0) {
            await log("warn", "Skipped auto-push because upstream has commits not present locally", pushState);
            await toast(
                `${pushState.branch} is ${pushState.ahead} ahead and ${pushState.behind} behind ${pushState.upstream}. Rebase/pull before pushing.`,
                "Auto-push skipped",
                "warning",
            );
            return;
        }

        pushing = true;
        try {
            await git(["push"]);
            await log("info", "Pushed queued auto-commits", pushState);
            await toast(
                `Pushed ${pushState.ahead} commits from ${pushState.branch} to ${pushState.upstream}.`,
                "Auto-push complete",
                "success",
            );
        } catch (error) {
            await log("error", "Auto-push failed", {
                ...pushState,
                error: String(error && error.message ? error.message : error),
            });
            await toast(
                `Push failed for ${pushState.branch} -> ${pushState.upstream}. Check the OpenCode log or run git push manually.`,
                "Auto-push failed",
                "error",
            );
        } finally {
            pushing = false;
        }
    }

    function extractStructuredOutput(result) {
        const candidates = [
            result?.data?.info?.structured_output,
            result?.data?.info?.structuredOutput,
            result?.data?.structured_output,
            result?.data?.structuredOutput,
            result?.info?.structured_output,
            result?.info?.structuredOutput,
        ];
        for (const candidate of candidates) {
            if (candidate && typeof candidate === "object") return candidate;
        }
        const parts = result?.data?.parts || result?.parts || [];
        const text = parts
            .filter((part) => part?.type === "text" || part?.text || part?.content)
            .map((part) => part?.text || part?.content || "")
            .filter(Boolean)
            .join("\n")
            .trim();
        if (!text) return null;
        try {
            return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, ""));
        } catch {
            return null;
        }
    }

    async function statusFiles() {
        const status = await git(["status", "--porcelain"]);
        return new Map(parseStatus(status).map((entry) => [entry.file, entry.code]));
    }

    async function buildCandidateDiff(files) {
        const tempDir = await mkdtemp(join(tmpdir(), "opencode-auto-commit-"));
        const indexPath = join(tempDir, "index");
        try {
            await gitWithIndex(indexPath, ["read-tree", "HEAD"]);
            await gitWithIndex(indexPath, ["add", "--", ...files]);
            const [diffStat, nameStatus, numStat, diff, staged] = await Promise.all([
                gitWithIndex(indexPath, ["diff", "--cached", "--stat"]),
                gitWithIndex(indexPath, ["diff", "--cached", "--name-status"]),
                gitWithIndex(indexPath, ["diff", "--cached", "--numstat"]),
                gitWithIndex(indexPath, ["diff", "--cached", "--no-ext-diff", "--unified=80"]),
                gitWithIndex(indexPath, ["diff", "--cached", "--name-only"]),
            ]);
            return { diffStat, nameStatus, numStat, diff, staged };
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }

    async function promptForCommitMessage({ statusSummary, diffStat, nameStatus, recentLog, diff }) {
        if (!client?.session?.create || !client?.session?.prompt) {
            await log("warn", "Skipped auto-commit because OpenCode session prompt API is unavailable");
            return null;
        }

        const truncated = diff.length > MAX_DIFF_CHARS;
        const prompt = `Write a high-quality git commit message for the candidate staged diff below.

Rules:
- Return only raw JSON with keys "subject" and "body". Do not use markdown fences.
- Use Conventional Commits: <type>(<scope>): <specific imperative summary>.
- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
- The subject must describe the actual change and why it matters.
- Do not use generic words like checkpoint, automated, auto-commit, update project files, or meaningful changes.
- Body should be 1-3 concise bullet points when it adds useful context; otherwise empty string.
- Do not mention that this was generated by a plugin or by OpenCode.

git status --porcelain:
${statusSummary}

git diff --cached --stat:
${diffStat}

git diff --cached --name-status:
${nameStatus}

Recent git log, newest first:
${recentLog || "(no recent commits available)"}

git diff --cached${truncated ? ` (truncated to ${MAX_DIFF_CHARS} chars)` : ""}:
${diff.slice(0, MAX_DIFF_CHARS)}`;

        const schema = {
            type: "object",
            properties: {
                subject: {
                    type: "string",
                    description: "Conventional Commit subject line, specific to the staged diff.",
                },
                body: {
                    type: "string",
                    description: "Optional commit body explaining why. Empty string if unnecessary.",
                },
            },
            required: ["subject", "body"],
            additionalProperties: false,
        };

        const session = await client.session.create({ body: { title: "Generate git commit message" } });
        const sessionId = session?.data?.id || session?.id;
        if (!sessionId) {
            await log("warn", "Skipped auto-commit because message generation session could not be created");
            return null;
        }

        let result;
        try {
            result = await client.session.prompt({
                path: { id: sessionId },
                body: {
                    agent: "build",
                    tools: PROMPT_TOOLS,
                    system: "You generate concise git commit messages. You must not call tools. Return only raw JSON.",
                    parts: [{ type: "text", text: prompt }],
                    outputFormat: { type: "json_schema", schema, retryCount: 2 },
                },
            });
        } catch (error) {
            result = await client.session.prompt({
                path: { id: sessionId },
                body: {
                    agent: "build",
                    tools: PROMPT_TOOLS,
                    system: "You generate concise git commit messages. You must not call tools. Return only raw JSON.",
                    parts: [{ type: "text", text: prompt }],
                    format: { type: "json_schema", schema, retryCount: 2 },
                },
            });
        }

        const extracted = extractStructuredOutput(result);
        const message = validateCommitMessage(extracted);
        if (!message.ok) {
            await log("warn", "Skipped auto-commit because generated commit message was invalid", {
                reason: message.reason,
                subject: message.subject,
            });
            return null;
        }
        return { subject: message.subject, body: message.body };
    }

    async function commitIfNeeded(reason) {
        if (committing || !sawMeaningfulActivity) return;
        committing = true;
        try {
            const inside = (await git(["rev-parse", "--is-inside-work-tree"])).trim();
            if (inside !== "true") return;

            const status = await git(["status", "--porcelain"]);
            const entries = parseStatus(status);
            const files = entries.map((entry) => entry.file).filter((file) => allowedFiles.has(file));
            if (files.length < MIN_CHANGED_FILES) return;

            const secretFiles = files.filter((file) => SECRET_PATH_RE.test(file));
            if (secretFiles.length) {
                await log("warn", "Skipped auto-commit because secret-like files are dirty", { files: secretFiles });
                return;
            }

            const { diffStat, nameStatus, numStat, diff, staged } = await buildCandidateDiff(files);
            if (!staged.trim()) return;

            let recentLog = "";
            try {
                recentLog = await git(["log", "--oneline", "--decorate=short", "-20"]);
            } catch {
                // Repositories with no commits yet do not have log context.
            }

            const message = await promptForCommitMessage({ statusSummary: status, diffStat, nameStatus, recentLog, diff });
            if (!message) return;

            await git(["add", "--", ...files]);

            const stagedAfterAdd = await git(["diff", "--cached", "--name-only"]);
            if (!stagedAfterAdd.trim()) return;

            const args = ["commit", "-m", message.subject];
            if (message.body) args.push("-m", message.body);
            await git(args);
            const [sha, branch] = await Promise.all([
                git(["rev-parse", "--short=12", "HEAD"]),
                git(["rev-parse", "--abbrev-ref", "HEAD"]),
            ]);
            const fileSummary = parseNameStatusSummary(nameStatus);
            const lineSummary = parseNumStatSummary(numStat);
            const pushState = await getPushState();
            sawMeaningfulActivity = false;
            for (const file of files) allowedFiles.delete(file);
            await log("info", "Created auto-commit", {
                subject: message.subject,
                sha: sha.trim(),
                branch: branch.trim(),
                files: fileSummary,
                lines: lineSummary,
                queuedOut: pushState,
                reason,
            });
            await toast(
                formatCommitToast({
                    subject: message.subject,
                    sha: sha.trim(),
                    branch: branch.trim(),
                    fileSummary,
                    lineSummary,
                    pushState,
                }),
            );
            await pushQueuedCommits(pushState);
        } catch (error) {
            await log("error", "Auto-commit failed", { error: String(error && error.message ? error.message : error) });
        } finally {
            committing = false;
        }
    }

    function schedule(reason, delay = DEBOUNCE_MS) {
        const deadline = Date.now() + delay;
        if (timer && timerDeadline <= deadline) return;
        if (timer) clearTimeout(timer);
        timerDeadline = deadline;
        timer = setTimeout(() => {
            timer = null;
            timerDeadline = 0;
            void commitIfNeeded(reason);
        }, delay);
    }

    void (async () => {
        try {
            const status = await git(["status", "--porcelain"]);
            if (!status.trim()) return;
            sawMeaningfulActivity = true;
            schedule("startup.dirty", STARTUP_DEBOUNCE_MS);
        } catch {
            // The normal commit path will log actionable errors later if this repo is usable.
        }
    })();

    return {
        event: async ({ event }) => {
            if (committing) return;
            if (event.type === "file.edited" || event.type === "file.watcher.updated" || event.type === "session.diff") {
                rememberFiles(collectRepoPaths(event), event.type);
                sawMeaningfulActivity = true;
                schedule(`quiet.${event.type}`, QUIET_DEBOUNCE_MS);
                return;
            }
            if (event.type === "tool.execute.before") {
                try {
                    toolStatusBefore.set(toolEventKey(event), await statusFiles());
                } catch {
                    // Status snapshots are best-effort; the after hook can still record explicit paths.
                }
                rememberFiles(collectRepoPaths(event), `tool.before.${String(event.properties?.tool || event.tool || "unknown")}`);
                return;
            }
            if (event.type === "tool.execute.after") {
                const tool = event.properties?.tool || event.tool;
                const explicitCount = rememberFiles(collectRepoPaths(event), `tool.after.${String(tool || "unknown")}`);
                let changedCount = 0;
                try {
                    const before = toolStatusBefore.get(toolEventKey(event)) || toolStatusBefore.get("__last__");
                    if (before) {
                        const after = await statusFiles();
                        const changed = [];
                        for (const [file, code] of after.entries()) {
                            if (before.get(file) !== code) changed.push(file);
                        }
                        changedCount = rememberFiles(changed, `tool.changed.${String(tool || "unknown")}`);
                    }
                } catch {
                    // Explicit paths above are still useful if a status comparison fails.
                } finally {
                    toolStatusBefore.delete(toolEventKey(event));
                }
                if (["write", "edit", "apply_patch", "bash"].includes(String(tool || ""))) {
                    sawMeaningfulActivity = true;
                    schedule(`quiet.tool.${String(tool || "unknown")}`, QUIET_DEBOUNCE_MS);
                } else if (explicitCount || changedCount) {
                    sawMeaningfulActivity = true;
                }
                return;
            }
            if (event.type === "session.idle") {
                sawMeaningfulActivity = true;
                if (timer) clearTimeout(timer);
                timer = null;
                timerDeadline = 0;
                await commitIfNeeded("session.idle");
            }
        },
    };
};
